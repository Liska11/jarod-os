// 2026-10-22 — la politique réseau des points d'entrée AUTONOMES (jarod serve, ask, MCP, ACP) : trouvée, appliquée avant la première connexion,
// prudente si le fichier est illisible, absente = comme avant. Chaque scénario sur un dossier temporaire ; la garde est retirée après chacun.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyNetworkPolicyForEntry, DEFAULT_POLICY, OFFLINE_CODE, resolvePolicyFile, setActivePolicy, uninstallNetworkGuard } from "../src/network.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-net-entry-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  uninstallNetworkGuard();
  setActivePolicy(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const policy = (internet: boolean) => JSON.stringify({ version: 1, internet, remoteMachines: false, remoteHosts: [], localCommands: false });

describe("resolvePolicyFile", () => {
  it("le fichier nommé par JAROD_NETWORK_POLICY l'emporte, même s'il n'existe pas (alors lu prudemment)", () => {
    expect(resolvePolicyFile({ JAROD_NETWORK_POLICY: "X:/absent.json" }, "win32", tmp())).toBe("X:/absent.json");
  });

  it("sinon le dossier de configuration du shell : JAROD_OS_CONFIG_DIR puis %APPDATA%", () => {
    const cfg = tmp();
    writeFileSync(join(cfg, "network-policy.json"), policy(false));
    expect(resolvePolicyFile({ JAROD_OS_CONFIG_DIR: cfg }, "win32", tmp())).toBe(join(cfg, "network-policy.json"));
    const roaming = tmp();
    mkdirSync(join(roaming, "Jarod-OS", "config"), { recursive: true });
    writeFileSync(join(roaming, "Jarod-OS", "config", "network-policy.json"), policy(true));
    expect(resolvePolicyFile({ APPDATA: roaming }, "win32", tmp())).toBe(join(roaming, "Jarod-OS", "config", "network-policy.json"));
  });

  it("aucun fichier : pas d'interrupteur configuré", () => {
    expect(resolvePolicyFile({ APPDATA: tmp() }, "win32", tmp())).toBeNull();
    expect(resolvePolicyFile({}, "linux", tmp())).toBeNull();
  });
});

describe("applyNetworkPolicyForEntry", () => {
  it("sans fichier, ne pose rien : les connexions restent permises comme avant", () => {
    const env: NodeJS.ProcessEnv = { APPDATA: tmp() };
    expect(applyNetworkPolicyForEntry(env)).toBeNull();
    expect(env.JAROD_NETWORK_POLICY).toBeUndefined();
  });

  it("Internet coupé : une connexion hors boucle locale est refusée AVANT d'être tentée, la boucle locale passe", async () => {
    const cfg = tmp();
    const file = join(cfg, "network-policy.json");
    writeFileSync(file, policy(false));
    const env: NodeJS.ProcessEnv = { JAROD_OS_CONFIG_DIR: cfg };
    expect(applyNetworkPolicyForEntry(env)).toBe(file);
    expect(env.JAROD_NETWORK_POLICY).toBe(file);

    const code = await new Promise<string | undefined>((resolve) => {
      const s = net.connect({ host: "203.0.113.9", port: 9 });
      s.once("error", (e) => resolve((e as NodeJS.ErrnoException).code));
      s.once("connect", () => resolve("connecté"));
    });
    expect(code).toBe(OFFLINE_CODE);

    const server = net.createServer((c) => c.end()).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    const ok = await new Promise<string>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => (s.destroy(), resolve("connecté")));
      s.once("error", (e) => resolve(String((e as NodeJS.ErrnoException).code)));
    });
    server.close();
    expect(ok).toBe("connecté");
  });

  it("fichier illisible : Internet coupé, jamais un « permis » silencieux", async () => {
    const cfg = tmp();
    writeFileSync(join(cfg, "network-policy.json"), "{pas du json");
    expect(applyNetworkPolicyForEntry({ JAROD_OS_CONFIG_DIR: cfg })).not.toBeNull();
    const code = await new Promise<string | undefined>((resolve) => {
      const s = net.connect({ host: "203.0.113.9", port: 9 });
      s.once("error", (e) => resolve((e as NodeJS.ErrnoException).code));
    });
    expect(code).toBe(OFFLINE_CODE);
    expect(DEFAULT_POLICY.internet).toBe(true);
  });

  it("le fichier réécrit passe Internet à « actif » : la requête suivante est permise (persistance, relecture)", async () => {
    const cfg = tmp();
    const file = join(cfg, "network-policy.json");
    writeFileSync(file, policy(false));
    applyNetworkPolicyForEntry({ JAROD_OS_CONFIG_DIR: cfg });
    const attempt = () =>
      new Promise<string>((resolve) => {
        const s = net.connect({ host: "203.0.113.9", port: 9 });
        s.once("error", (e) => resolve(String((e as NodeJS.ErrnoException).code)));
        s.once("connect", () => resolve("connecté"));
        setTimeout(() => (s.destroy(), resolve("tenté")), 300);
      });
    expect(await attempt()).toBe(OFFLINE_CODE);
    writeFileSync(file, `${policy(true)}

`); // taille différente : relu
    expect(await attempt()).not.toBe(OFFLINE_CODE);
  });
});

describe("ordre de démarrage du binaire", () => {
  it("cli/src/main.ts applique la politique avant d'appeler main()", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)), "utf8");
    const apply = src.indexOf("applyNetworkPolicyForEntry(process.env);");
    const run = src.indexOf("main().then(");
    expect(apply).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(apply);
  });
});
