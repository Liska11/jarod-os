// V-06 — la plateforme de plugins (signature, permissions accordées, mise à jour annulée si elle échoue, retour arrière) branchée sur l'hôte
// réel : VRAI kernel, vraie plateforme, vraie clé locale du profil, vrais processus isolés. Aucune approbation automatique ici (sauf le plugin
// d'exemple au premier lancement) : chaque approbation est l'appel que fait le bridge après la confirmation native.
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, cleanup, discoverPlugins, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { digestOf, type PluginHost } from "../src/index.js";

afterEach(cleanup);

type Any = any; // le kernel est un objet cordis à services dynamiques

/** Un plugin qui expose un outil `version` rendant `v<version>` ; `broken` le fait échouer à l'activation. */
function write(dataDir: string, id: string, version: string, broken = false): string {
  const root = join(dataDir, "plugins", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ id, name: `Plugin ${id}`, version, main: "index.js", permissions: ["tools"] }));
  writeFileSync(
    join(root, "index.js"),
    broken
      ? `exports.activate = () => { throw new Error("panne volontaire de ${version}"); };\n`
      : `exports.activate = (api) => { api.registerTool({ name: "version", description: "v", parameters: { type: "object", properties: {} }, run: () => "v${version}" }); };\n`,
  );
  return root;
}

const keys = memoryKeyStore();

async function boot(dataDir = tempDir(), extra: Record<string, Record<string, unknown> | false> = {}) {
  const plugins: Record<string, Record<string, unknown> | false> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir, keyStores: [keys] };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  plugins.mcp = { autoSync: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.workflows = { seed: false, load: false };
  Object.assign(plugins, extra);
  const app = (await bootApp(plugins)) as Any;
  const host: PluginHost = app.pluginHost;
  const info = (id: string) => host.list().find((p) => p.id === id);
  return { app, host, dataDir, info, tools: app.agent.tools };
}

describe("V-06 — un plugin ne tourne qu'approuvé et signé", () => {
  it("un dossier déposé dans plugins/ n'est PAS lancé : bloqué, sans processus ni outil, et la raison le dit", async () => {
    const { host, dataDir, info, tools } = await boot();
    write(dataDir, "depose", "1.0.0");
    await host.reload();
    expect(info("depose")).toMatchObject({ state: "blocked", pid: null, error: expect.stringMatching(/^non approuvé/) });
    expect(tools.get("depose_version")).toBeUndefined();
    expect(host.governance!.status("depose")).toEqual({ status: "unapproved" });
  });

  it("un dossier déposé APRÈS le démarrage se voit à la liste suivante, bloqué, sans relancer les autres plugins", async () => {
    const { host, dataDir, info } = await boot();
    write(dataDir, "premier", "1.0.0");
    await host.reload();
    await host.governance!.approve("premier");
    const pid = info("premier")!.pid;
    write(dataDir, "second", "1.0.0");
    await host.scanNew();
    expect(info("second")).toMatchObject({ state: "blocked", error: expect.stringMatching(/^non approuvé/) });
    expect(info("premier")).toMatchObject({ state: "active", pid });

    // Le contenu d'un plugin qui TOURNE change : la liste suivante l'arrête et le bloque, sans attendre un redémarrage.
    write(dataDir, "premier", "1.0.0", true);
    await host.scanNew();
    expect(info("premier")).toMatchObject({ state: "blocked", pid: null, error: expect.stringMatching(/contenu modifié/) });
  });

  it("approuvé : signé par la clé locale du profil, installé et activé par la plateforme, l'outil tourne", async () => {
    const { app, host, dataDir, info, tools } = await boot();
    write(dataDir, "outil", "1.0.0");
    await host.reload();
    expect(await host.governance!.approve("outil")).toEqual({ status: "approved", version: "1.0.0", signer: "local-1" });
    expect(info("outil")).toMatchObject({ state: "active" });
    expect(await tools.get("outil_version").run({}, { sessionId: "s", workspace: null })).toBe("v1.0.0");
    expect(app.plugins.get("outil")).toMatchObject({ status: "enabled", manifest: { name: "outil", permissions: ["tools"] } });
    // Un rechargement complet garde ce qui est approuvé.
    await host.reload();
    expect(info("outil")!.state).toBe("active");
  });

  it("modifié sans nouvelle version : bloqué, et l'approbation demande de monter la version ; avec 2.0.0 : mise à jour, puis retour à 1.0.0", async () => {
    const { host, dataDir, info, tools } = await boot();
    const root = write(dataDir, "evolue", "1.0.0");
    await host.reload();
    await host.governance!.approve("evolue");

    writeFileSync(join(root, "index.js"), `exports.activate = (api) => { api.registerTool({ name: "version", description: "v", parameters: { type: "object", properties: {} }, run: () => "pirate" }); };\n`);
    await host.reload();
    expect(info("evolue")).toMatchObject({ state: "blocked", error: expect.stringMatching(/contenu modifié depuis l'approbation de la version 1\.0\.0/) });
    expect(host.governance!.status("evolue").status).toBe("modified");
    await expect(host.governance!.approve("evolue")).rejects.toThrow(/montez la version/);

    write(dataDir, "evolue", "2.0.0");
    expect(await host.governance!.approve("evolue")).toMatchObject({ status: "approved", version: "2.0.0", previous: "1.0.0" });
    expect(await tools.get("evolue_version").run({}, { sessionId: "s", workspace: null })).toBe("v2.0.0");

    expect(await host.governance!.rollback("evolue")).toMatchObject({ status: "approved", version: "1.0.0" });
    expect(info("evolue")).toMatchObject({ state: "active", version: "1.0.0" });
    expect(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).version).toBe("1.0.0");
    expect(await tools.get("evolue_version").run({}, { sessionId: "s", workspace: null })).toBe("v1.0.0");
  });

  it("une mise à jour qui échoue à l'activation est ANNULÉE : l'ancienne version est remise en place et tourne", async () => {
    const { host, dataDir, info, tools } = await boot();
    write(dataDir, "fragile", "1.0.0");
    await host.reload();
    await host.governance!.approve("fragile");

    write(dataDir, "fragile", "1.1.0", true);
    await expect(host.governance!.approve("fragile")).rejects.toThrow(/1\.1\.0 a échoué.*1\.0\.0 est rétabli/);
    expect(info("fragile")).toMatchObject({ state: "active", version: "1.0.0" });
    expect(await tools.get("fragile_version").run({}, { sessionId: "s", workspace: null })).toBe("v1.0.0");
    expect(host.governance!.status("fragile")).toMatchObject({ status: "approved", version: "1.0.0" });
  });

  it("désactiver, réactiver, retirer l'approbation : la plateforme décide, l'hôte suit", async () => {
    const { host, dataDir, info } = await boot();
    write(dataDir, "cycle", "1.0.0");
    await host.reload();
    await host.governance!.approve("cycle");
    await host.governance!.setEnabled("cycle", false);
    expect(info("cycle")!.state).toBe("disabled");
    expect(host.governance!.status("cycle")).toMatchObject({ status: "disabled", version: "1.0.0" });
    await host.governance!.setEnabled("cycle", true);
    expect(info("cycle")!.state).toBe("active");
    await host.governance!.revoke("cycle");
    expect(info("cycle")).toMatchObject({ state: "blocked", error: expect.stringMatching(/^non approuvé/) });
    await expect(host.governance!.setEnabled("cycle", true)).rejects.toThrow(/approuvez-le d'abord/);
  });

  it("un état de la plateforme réécrit à la main (signature d'une autre clé) ne fait rien tourner", async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir);
    write(dataDir, "vise", "1.0.0");
    await first.host.reload();
    await first.host.governance!.approve("vise");
    const state = JSON.parse(readFileSync(join(dataDir, "plugin-platform.json"), "utf8"));
    await first.host.unloadAll();
    // Le contenu change, et l'attaquant réécrit l'état avec SA signature (une clé que le profil ne connaît pas), sous l'identifiant local.
    write(dataDir, "vise", "1.0.0", true);
    const { privateKey } = generateKeyPairSync("ed25519");
    const { signature: _, ...unsigned } = { ...state.vise.manifest, payloadSha256: await digestOf(join(dataDir, "plugins", "vise")) };
    // Même forme canonique que plugin-platform (clés triées, sans espace) : seule la CLÉ diffère.
    const canonical = (v: unknown): string =>
      Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
    const forged = { ...unsigned, signature: { keyId: "local-1", value: sign(null, Buffer.from(canonical(unsigned)), privateKey).toString("base64") } };
    writeFileSync(join(dataDir, "plugin-platform.json"), JSON.stringify({ vise: { ...state.vise, manifest: forged } }));

    const second = await boot(dataDir);
    await second.host.reload();
    expect(second.info("vise")).toMatchObject({ state: "blocked", error: expect.stringMatching(/signature invalide/) });
  });

  it("le contenu change entre la confirmation et la signature : rien n'est approuvé", async () => {
    const { host, dataDir, info } = await boot();
    write(dataDir, "glisse", "1.0.0");
    await host.reload();
    const shown = info("glisse")!.digest;
    write(dataDir, "glisse", "1.0.0", true);
    await expect(host.governance!.approve("glisse", shown)).rejects.toThrow(/a changé pendant la confirmation/);
    expect(host.governance!.status("glisse")).toEqual({ status: "unapproved" });
  });

  it("sans plugin-platform : aucun plugin ne tourne, et la raison le dit", async () => {
    const { host, dataDir, info } = await boot(tempDir(), { platform: false });
    write(dataDir, "seul", "1.0.0");
    await host.reload();
    expect(info("seul")).toMatchObject({ state: "blocked", error: expect.stringMatching(/plateforme de plugins n'est pas chargée/) });
    expect(host.governance).toBeNull();
  });

  it("le plugin d'exemple posé au premier lancement est approuvé d'office et tourne", async () => {
    const { info, host } = await boot(tempDir(), { workflows: { seed: true, load: true } });
    expect(info("des")).toMatchObject({ state: "active" });
    expect(host.governance!.status("des")).toMatchObject({ status: "approved", signer: "local-1" });
  });
});
