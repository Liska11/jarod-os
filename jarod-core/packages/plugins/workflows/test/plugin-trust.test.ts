// Q19-4 — l'accord d'un outil de plugin est fixé par l'UTILISATEUR, jamais par le plugin : inconnu = dangereux, le classement
// « sans accord » est lié à l'empreinte du contenu du plugin, et seul `/plugin trust` (composer) le pose.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, cleanup, discoverPlugins, tempDir } from "@jarod/kernel/testing";
import { executeGuardedTool } from "@jarod/plugin-agent";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { approveOnReload } from "./approve.js";
import { digestOf, type PluginHost } from "../src/index.js";

afterEach(cleanup);

type Any = any; // le kernel est un objet cordis à services dynamiques

/** Un plugin qui DÉCLARE `lire` non dangereux et `ecrire` dangereux : ni l'un ni l'autre ne décide de l'accord. */
function installTools(dataDir: string, id: string): string {
  const root = join(dataDir, "plugins", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", main: "index.js", permissions: ["tools"] }));
  writeFileSync(
    join(root, "index.js"),
    `exports.activate = (api) => {
  api.registerTool({ name: "lire", description: "lit", parameters: { type: "object", properties: {} }, dangerous: false, run: () => "lu" });
  api.registerTool({ name: "ecrire", description: "écrit", parameters: { type: "object", properties: {} }, dangerous: true, run: () => "écrit" });
};
`,
  );
  return root;
}

async function boot() {
  const dataDir = tempDir();
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir, keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  plugins.mcp = { autoSync: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.workflows = { seed: false, load: false };
  const app = (await bootApp(plugins)) as Any;
  const host: PluginHost = approveOnReload(app.pluginHost);
  return { app, host, dataDir, tools: app.agent.tools, settings: app.agent.settings };
}

describe("un outil de plugin est dangereux tant que l'utilisateur ne l'a pas classé", () => {
  it("ce que le plugin déclare n'y change rien : `dangerous: false` ET `dangerous: true` exigent l'accord ; la déclaration est gardée comme indication", async () => {
    const { host, dataDir, tools } = await boot();
    installTools(dataDir, "outils");
    await host.reload();
    expect(tools.get("outils_lire")).toMatchObject({ dangerous: true, declaredDangerous: false, source: "plugin" });
    expect(tools.get("outils_ecrire")).toMatchObject({ dangerous: true, declaredDangerous: true });
    expect(host.list()[0]).toMatchObject({ id: "outils", trusted: [], digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("par le garde : l'accord est demandé (refusé → l'outil ne tourne pas ; accordé → il tourne) ; sans porte d'accord (passerelle, tâche) → refusé", async () => {
    const { host, dataDir, tools, settings } = await boot();
    installTools(dataDir, "outils");
    await host.reload();
    const call = { id: "c", name: "outils_lire", args: {} };
    const signal = new AbortController().signal;
    const cfg = { ...settings.getAll(), autoApproveTools: false };
    const asked: string[] = [];
    const hooks = (answer: boolean) => ({ approve: async (_s: string, c: { name: string }) => (asked.push(c.name), answer) });
    const gate = { decide: () => "allow" as const };
    expect(await executeGuardedTool(tools, "s", call, signal, hooks(false), cfg, { gate })).toMatchObject({ isError: true, content: expect.stringMatching(/refusé/) });
    expect(await executeGuardedTool(tools, "s", call, signal, hooks(true), cfg, { gate })).toEqual({ content: "lu", isError: false });
    expect(asked).toEqual(["outils_lire", "outils_lire"]);
  });

  it("`/plugin trust`-équivalent : classer un outil (nom court ou complet) le rend sans accord, lui SEUL ; `distrust` le rétablit", async () => {
    const { host, dataDir, tools, settings } = await boot();
    installTools(dataDir, "outils");
    await host.reload();
    expect(host.trustTools("outils", ["lire"])).toEqual(["outils_lire"]);
    expect(tools.get("outils_lire").dangerous).toBe(false);
    expect(tools.get("outils_ecrire").dangerous).toBe(true); // l'autre outil du même plugin reste dangereux
    expect(host.list()[0]!.trusted).toEqual(["outils_lire"]);
    expect(settings.get("pluginTrust").outils).toMatchObject({ tools: ["outils_lire"], digest: host.list()[0]!.digest });

    const asked: string[] = [];
    const run = (name: string) =>
      executeGuardedTool(tools, "s", { id: "c", name, args: {} }, new AbortController().signal, { approve: async (_s: string, c: { name: string }) => (asked.push(c.name), false) }, { ...settings.getAll(), autoApproveTools: false }, { gate: { decide: () => "allow" as const } });
    expect(await run("outils_lire")).toEqual({ content: "lu", isError: false }); // sans demander
    expect(await run("outils_ecrire")).toMatchObject({ isError: true }); // demande, refusé
    expect(asked).toEqual(["outils_ecrire"]);

    host.trustTools("outils", ["outils_ecrire"]); // nom complet
    expect(tools.get("outils_ecrire").dangerous).toBe(false);
    expect(host.distrustTools("outils", ["lire"])).toEqual(["outils_lire"]);
    expect(tools.get("outils_lire").dangerous).toBe(true);
    expect(tools.get("outils_ecrire").dangerous).toBe(false);
    host.distrustTools("outils"); // aucun nom : tous
    expect(tools.get("outils_ecrire").dangerous).toBe(true);
    expect(settings.get("pluginTrust")).toEqual({});
  });

  it("un nom inconnu ou un plugin inactif : erreur, RIEN n'est classé", async () => {
    const { host, dataDir, settings } = await boot();
    installTools(dataDir, "outils");
    await host.reload();
    expect(() => host.trustTools("outils", ["lire", "inexistant"])).toThrow(/Outil inconnu.*inexistant/);
    expect(() => host.trustTools("absent")).toThrow(/introuvable ou inactif/);
    expect(settings.get("pluginTrust")).toEqual({});
  });

  it("le classement survit à un rechargement du même contenu, et à un fichier écrit dans `data/` (que le plugin écrit lui-même)", async () => {
    const { host, dataDir, tools } = await boot();
    const root = installTools(dataDir, "outils");
    await host.reload();
    host.trustTools("outils", ["lire"]);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "etat.json"), "{}");
    await host.reload();
    expect(tools.get("outils_lire").dangerous).toBe(false);
    expect(host.list()[0]!.trusted).toEqual(["outils_lire"]);
  });

  it("le classement est lié au CONTENU : un plugin modifié (même nom, même version) perd son classement, et l'utilisateur en est prévenu ; depuis V-06 il ne tourne même plus", async () => {
    const { app, host, dataDir, tools, settings } = await boot();
    const root = installTools(dataDir, "outils");
    await host.reload();
    host.trustTools("outils");
    expect(tools.get("outils_lire").dangerous).toBe(false);
    const before = host.list()[0]!.digest;

    appendFileSync(join(root, "index.js"), "\n// modifié après le classement\n");
    await host.reload();
    expect(host.list()[0]!.digest).not.toBe(before);
    // V-06 : un contenu modifié depuis son approbation n'est plus lancé du tout — ses outils ne sont plus enregistrés.
    expect(host.list()[0]).toMatchObject({ state: "blocked", error: expect.stringMatching(/contenu modifié depuis l'approbation/) });
    expect(tools.get("outils_lire")).toBeUndefined();
    expect(tools.get("outils_ecrire")).toBeUndefined();
    expect(settings.get("pluginTrust")).toEqual({});
    const note = app.storage.notifications.list().find((n: { title: string }) => /confiance retirée/.test(n.title));
    expect(note?.body).toMatch(/outils_lire/);
    expect(note?.body).toMatch(/\/plugin trust outils/);
  });

  it("le classement d'un plugin ne touche pas un autre plugin, même aux outils de même nom court", async () => {
    const { host, dataDir, tools } = await boot();
    installTools(dataDir, "un");
    installTools(dataDir, "deux");
    await host.reload();
    host.trustTools("un", ["lire"]);
    expect(tools.get("un_lire").dangerous).toBe(false);
    expect(tools.get("deux_lire").dangerous).toBe(true);
  });

  it("`digestOf` : stable, sensible au contenu ET au chemin, indifférent à `data/`", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "a", "sub"), { recursive: true });
    writeFileSync(join(dir, "a", "x.js"), "1");
    writeFileSync(join(dir, "a", "sub", "y.js"), "2");
    const d1 = await digestOf(join(dir, "a"));
    expect(await digestOf(join(dir, "a"))).toBe(d1);
    mkdirSync(join(dir, "a", "data"), { recursive: true });
    writeFileSync(join(dir, "a", "data", "z"), "état");
    expect(await digestOf(join(dir, "a"))).toBe(d1);
    writeFileSync(join(dir, "a", "sub", "y.js"), "3");
    const d2 = await digestOf(join(dir, "a"));
    expect(d2).not.toBe(d1);
    writeFileSync(join(dir, "a", "sub", "y.js"), "2");
    writeFileSync(join(dir, "a", "y.js"), "2"); // même octets ailleurs : autre chemin
    expect(await digestOf(join(dir, "a"))).not.toBe(d1);
  });
});
