// E2 — démarrage du navigateur jetable : cas déterministes (faux processus, fausse horloge, faux point d'entrée DevTools).
// Aucun vrai navigateur ici ; le moteur réel est joué par test/engines/browser.engine.test.ts.
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type LaunchDeps, launchDisposableBrowser, parseDevToolsActivePort } from "../src/index.js";

const GUID = "/devtools/browser/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  kill() {
    this.killed = true;
    this.exitCode ??= 0;
    this.emit("exit", this.exitCode);
    return true;
  }
}

/** Une horloge qui n'avance que quand `sleep` est appelé : le délai se joue sans attendre. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

interface Harness {
  deps: LaunchDeps;
  child: FakeChild;
  profiles: string[];
  killed: string[];
  /** Appelé à chaque tour de `sleep` avec le temps écoulé : lance les scénarios (fichier de port qui apparaît, lanceur qui sort…). */
  onTick: (fn: (elapsed: number, userData: string) => void) => void;
}

function harness(over: Partial<LaunchDeps> = {}): Harness {
  const c = clock();
  const child = new FakeChild();
  let userData = "";
  let tick: (elapsed: number, userData: string) => void = () => {};
  const t0 = c.now();
  const killed: string[] = [];
  const profiles: string[] = [];
  const spawnFn = ((_bin: string, args: string[]) => {
    userData = (args.find((a) => a.startsWith("--user-data-dir=")) ?? "").slice("--user-data-dir=".length);
    mkdirSync(userData, { recursive: true });
    profiles.push(userData);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const deps: LaunchDeps = {
    spawn: spawnFn,
    now: c.now,
    sleep: async (ms) => {
      await c.sleep(ms);
      tick(c.now() - t0, userData);
    },
    fetchBrowserPath: async () => GUID,
    profileHasProcess: () => false,
    killProfile: (dir) => (killed.push(dir), 0),
    ...over,
  };
  return { deps, child, profiles, killed, onTick: (fn) => (tick = fn) };
}

const writePort = (userData: string, body: string) => writeFileSync(join(userData, "DevToolsActivePort"), body);
const opts = { chromeBin: process.execPath, timeoutMs: 5_000 };

describe("parseDevToolsActivePort", () => {
  it("n'accepte qu'un fichier complet et valide", () => {
    expect(parseDevToolsActivePort(`9222\n${GUID}\n`)).toEqual({ port: 9222, browserPath: GUID });
    expect(parseDevToolsActivePort(`9222\r\n${GUID}`)).toEqual({ port: 9222, browserPath: GUID });
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("9222")).toBeNull();
    expect(parseDevToolsActivePort("9222\n")).toBeNull();
    expect(parseDevToolsActivePort("9222\n/devtools/browser/")).toBeNull();
    expect(parseDevToolsActivePort(`0\n${GUID}`)).toBeNull();
    expect(parseDevToolsActivePort(`70000\n${GUID}`)).toBeNull();
    expect(parseDevToolsActivePort(`92x2\n${GUID}`)).toBeNull();
    expect(parseDevToolsActivePort("9222\n/json/other")).toBeNull();
  });
});

describe("launchDisposableBrowser — attente bornée", () => {
  it("1. le lanceur sort avant que le navigateur soit prêt : on attend le fichier de port, sans conclure à l'échec", async () => {
    const h = harness({ profileHasProcess: () => true });
    h.onTick((elapsed, ud) => {
      if (elapsed === 300) {
        h.child.exitCode = 0;
        h.child.emit("exit", 0);
      }
      if (elapsed === 1500) writePort(ud, `9333\n${GUID}\n`);
    });
    const b = await launchDisposableBrowser(opts, h.deps);
    expect(b.cdpUrl).toBe("http://127.0.0.1:9333");
    expect(h.killed).toEqual([]);
    await b.close();
    expect(existsSync(h.profiles[0] ?? "")).toBe(false);
  });

  it("1b. le lanceur sort et plus rien ne porte le profil : échec de lancement, profil nettoyé", async () => {
    const h = harness({ profileHasProcess: () => false });
    h.onTick((elapsed) => {
      if (elapsed === 200) h.child.exitCode = 3;
    });
    await expect(launchDisposableBrowser(opts, h.deps)).rejects.toThrow(/s'est arrêté avant de démarrer \(code 3\)/);
    expect(h.killed).toHaveLength(1);
    expect(existsSync(h.profiles[0] ?? "")).toBe(false);
  });

  it("2. le navigateur ne démarre jamais : délai dépassé, navigateur et profil nettoyés", async () => {
    const h = harness();
    await expect(launchDisposableBrowser({ ...opts, timeoutMs: 2_000 }, h.deps)).rejects.toThrow(/délai dépassé/);
    expect(h.child.killed).toBe(true);
    expect(h.killed).toHaveLength(1);
    expect(existsSync(h.profiles[0] ?? "")).toBe(false);
  });

  it("3. fichier de port incomplet puis valide : on n'utilise pas la version tronquée", async () => {
    const seen: number[] = [];
    const h = harness({
      fetchBrowserPath: async (port) => (seen.push(port), GUID),
    });
    h.onTick((elapsed, ud) => {
      if (elapsed === 200) writePort(ud, "9444");
      if (elapsed === 400) writePort(ud, "9444\n");
      if (elapsed === 600) writePort(ud, "9444\n/devtools/br");
      if (elapsed === 800) writePort(ud, `9555\n${GUID}\n`);
    });
    const b = await launchDisposableBrowser(opts, h.deps);
    expect(b.cdpUrl).toBe("http://127.0.0.1:9555");
    expect(seen).toEqual([9555]);
    await b.close();
  });

  it("4. annulation pendant le démarrage : nettoyage, pas de navigateur orphelin", async () => {
    const ac = new AbortController();
    const h = harness();
    h.onTick((elapsed) => {
      if (elapsed === 500) ac.abort();
    });
    await expect(launchDisposableBrowser({ ...opts, signal: ac.signal }, h.deps)).rejects.toThrow(/annulé/);
    expect(h.child.killed).toBe(true);
    expect(h.killed).toHaveLength(1);
    expect(existsSync(h.profiles[0] ?? "")).toBe(false);
  });

  it("4b. annulation avant le lancement : rien n'est lancé", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness();
    await expect(launchDisposableBrowser({ ...opts, signal: ac.signal }, h.deps)).rejects.toThrow(/annulé/);
    expect(h.profiles).toEqual([]);
  });

  it("5. délai dépassé alors que le fichier de port est resté incomplet", async () => {
    const h = harness();
    h.onTick((elapsed, ud) => {
      if (elapsed === 100) writePort(ud, "9666\n");
    });
    await expect(launchDisposableBrowser({ ...opts, timeoutMs: 1_500 }, h.deps)).rejects.toThrow(/n'a pas démarré/);
    expect(h.killed).toHaveLength(1);
  });

  it("6. endpoint incorrect : un autre navigateur répond sur ce port, il n'est jamais adopté", async () => {
    const h = harness({ fetchBrowserPath: async () => "/devtools/browser/ffffffff-0000-0000-0000-000000000000" });
    h.onTick((elapsed, ud) => {
      if (elapsed === 200) writePort(ud, `9777\n${GUID}\n`);
    });
    await expect(launchDisposableBrowser({ ...opts, timeoutMs: 2_000 }, h.deps)).rejects.toThrow(/n'annonce pas le navigateur attendu/);
    expect(h.child.killed).toBe(true);
    expect(h.killed).toHaveLength(1);
    expect(existsSync(h.profiles[0] ?? "")).toBe(false);
  });

  it("7. échec de connexion après découverte du port : nettoyage et raison précise", async () => {
    const h = harness({
      fetchBrowserPath: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    h.onTick((elapsed, ud) => {
      if (elapsed === 200) writePort(ud, `9888\n${GUID}\n`);
    });
    await expect(launchDisposableBrowser({ ...opts, timeoutMs: 2_000 }, h.deps)).rejects.toThrow(/connexion au point d'entrée DevTools impossible \(ECONNREFUSED\)/);
    expect(h.child.killed).toBe(true);
    expect(h.killed).toHaveLength(1);
    expect(existsSync(h.profiles[0] ?? "")).toBe(false);
  });

  it("7b. le point d'entrée met du temps à répondre : nouvel essai, puis succès", async () => {
    let calls = 0;
    const h = harness({
      fetchBrowserPath: async () => {
        if (++calls < 3) throw new Error("ECONNREFUSED");
        return GUID;
      },
    });
    h.onTick((elapsed, ud) => {
      if (elapsed === 200) writePort(ud, `9999\n${GUID}\n`);
    });
    const b = await launchDisposableBrowser(opts, h.deps);
    expect(b.cdpUrl).toBe("http://127.0.0.1:9999");
    expect(calls).toBe(3);
    await b.close();
  });

  it("l'échec du lancement du processus lui-même est rapporté et nettoyé", async () => {
    const h = harness();
    h.onTick((elapsed) => {
      if (elapsed === 100) h.child.emit("error", new Error("spawn EACCES"));
    });
    await expect(launchDisposableBrowser(opts, h.deps)).rejects.toThrow(/n'a pas pu être lancé : spawn EACCES/);
    expect(h.killed).toHaveLength(1);
  });
});
