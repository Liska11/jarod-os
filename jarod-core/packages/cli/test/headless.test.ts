// SPECS-P5-CLI.md §3-§4 (d) : `jarod headless start|status|stop` — processus RÉELS. Arrêt coopératif seulement : délai max de 10 s (décision Q3),
// échec rapporté, JAMAIS de kill. Un faux démon (fixtures/fake-serve.mjs) couvre les cas limites ; un test lance le vrai `jarod serve` via tsx.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive, readSupervisorState, readSupervisorStatus } from "@jarod/plugin-agent";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headlessStart, headlessStatus, headlessStop } from "../src/headless.js";
import { PENDING_COMMANDS, main } from "../src/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-serve.mjs");
const MAIN_TS = join(HERE, "..", "src", "main.ts");
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

const dirs: string[] = [];
const pids: number[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-headless-"));
  dirs.push(d);
  return d;
};
const fake = (root: string, mode = "normal") => ({ execPath: process.execPath, args: [FAKE, root, mode] });

let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  // Nettoyage des SEULS processus lancés par ces tests (le code testé, lui, ne tue jamais).
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* déjà parti */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const track = () => {
  const s = readSupervisorState(lastRoot);
  if (s) pids.push(s.pid);
};
let lastRoot = "";
const base = (root: string) => {
  lastRoot = root;
  return { dataRoot: root, version: "test", pollMs: 50, startTimeoutMs: 15_000, stopTimeoutMs: 10_000 };
};

describe("jarod headless (faux démon, processus réels)", () => {
  it("start → status (0) → stop (≤ 10 s) → status (1) ; l'état disparaît et le processus aussi", { timeout: 60_000 }, async () => {
    const root = temp();
    expect(await headlessStart({ ...base(root), launch: fake(root) })).toBe(0);
    track();
    const state = readSupervisorState(root)!;
    expect(isProcessAlive(state.pid)).toBe(true);
    expect(out.join("\n")).toContain(String(state.pid));
    expect(existsSync(join(root, "headless.log"))).toBe(true);

    expect(headlessStatus({ ...base(root) })).toBe(0);
    const t0 = Date.now();
    expect(await headlessStop({ ...base(root) })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(isProcessAlive(state.pid)).toBe(false);
    expect(readSupervisorState(root)).toBeNull();
    out = [];
    expect(headlessStatus({ ...base(root) })).toBe(1);
    expect(out.join("\n") + err.join("\n")).toMatch(/aucune instance/i);
  });

  it("un second start pendant que la première tourne est refusé, sans lancer un deuxième processus", { timeout: 60_000 }, async () => {
    const root = temp();
    expect(await headlessStart({ ...base(root), launch: fake(root) })).toBe(0);
    track();
    const first = readSupervisorState(root)!.pid;
    expect(await headlessStart({ ...base(root), launch: fake(root) })).toBe(1);
    expect(err.join("\n")).toMatch(/déjà en marche/);
    expect(readSupervisorState(root)!.pid).toBe(first);
    expect(await headlessStop({ ...base(root) })).toBe(0);
  });

  it("stop sans instance → message clair, code 1", async () => {
    const root = temp();
    expect(await headlessStop({ ...base(root) })).toBe(1);
    expect(err.join("\n") + out.join("\n")).toMatch(/aucune instance/i);
  });

  it("stop sur un état périmé (processus disparu) : nettoyé, code 1, rien de tué", async () => {
    const root = temp();
    writeFileSync(join(root, "supervisor.json"), JSON.stringify({ pid: 2147483646, mode: "serve", startedAt: 1, version: "x", profile: "p", dataDir: root, stopRequestedAt: null }));
    expect(await headlessStop({ ...base(root) })).toBe(1);
    expect(readSupervisorState(root)).toBeNull();
  });

  it("instance qui ne répond pas à la demande : échec rapporté au bout du délai, le processus n'est PAS tué", { timeout: 60_000 }, async () => {
    const root = temp();
    expect(await headlessStart({ ...base(root), launch: fake(root, "ignore-stop") })).toBe(0);
    track();
    const pid = readSupervisorState(root)!.pid;
    const t0 = Date.now();
    expect(await headlessStop({ ...base(root), stopTimeoutMs: 1_500 })).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(err.join("\n")).toMatch(/n'a pas répondu/);
    expect(err.join("\n")).toContain(String(pid));
    expect(isProcessAlive(pid)).toBe(true); // jamais de kill
    expect(readSupervisorStatus(root).stopping).toBe(true);
  });

  it("démon qui meurt au démarrage : échec franc qui renvoie au journal", { timeout: 60_000 }, async () => {
    const root = temp();
    expect(await headlessStart({ ...base(root), launch: fake(root, "die") })).toBe(1);
    expect(err.join("\n")).toMatch(/headless\.log/);
    expect(readFileSync(join(root, "headless.log"), "utf8")).toContain("boum");
  });

  it("état périmé laissé par un processus disparu : start le nettoie et démarre", { timeout: 60_000 }, async () => {
    const root = temp();
    writeFileSync(join(root, "supervisor.json"), JSON.stringify({ pid: 2147483646, mode: "serve", startedAt: 1, version: "x", profile: "p", dataDir: root, stopRequestedAt: null }));
    expect(await headlessStart({ ...base(root), launch: fake(root) })).toBe(0);
    track();
    expect(readSupervisorState(root)!.pid).not.toBe(2147483646);
    expect(await headlessStop({ ...base(root) })).toBe(0);
  });

  it("verrou du profil tenu par un autre processus vivant : start refusé avant de lancer quoi que ce soit", async () => {
    const root = temp();
    const pm = new ProfileManager(root);
    pm.create("travail");
    pm.setActive("travail");
    writeFileSync(join(pm.dirFor("travail"), "runtime.lock"), JSON.stringify({ pid: process.pid, mode: "desktop", startedAt: Date.now() }));
    expect(await headlessStart({ ...base(root), launch: fake(root) })).toBe(1);
    expect(err.join("\n")).toMatch(/déjà servi|application de bureau/);
    expect(readSupervisorState(root)).toBeNull();
  });
});

describe("jarod headless (le vrai `jarod serve`, via tsx)", () => {
  it("start → status → stop sur un profil réel de test", { timeout: 180_000 }, async () => {
    const root = temp();
    const pm = new ProfileManager(root);
    pm.create("travail");
    pm.setActive("travail");
    mkdirSync(root, { recursive: true });
    const saved = process.env.JAROD_HOME;
    process.env.JAROD_HOME = root;
    try {
      const opts = { ...base(root), startTimeoutMs: 90_000, launch: { execPath: process.execPath, args: [TSX, MAIN_TS, "serve"], env: { VITEST: "" } } }; // VITEST hérité empêcherait main() de s'exécuter
      expect(await headlessStart(opts), err.join("\n")).toBe(0);
      track();
      expect(readSupervisorState(root)?.mode).toBe("serve");
      expect(headlessStatus(base(root))).toBe(0);
      expect(await headlessStop({ ...base(root), stopTimeoutMs: 10_000 }), err.join("\n")).toBe(0);
      expect(readSupervisorState(root)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.JAROD_HOME;
      else process.env.JAROD_HOME = saved;
    }
  });
});

describe("jarod headless (ligne de commande)", () => {
  it("sans sous-commande ou avec une inconnue : usage, code 2 ; la commande n'est plus « en attente »", async () => {
    expect(PENDING_COMMANDS).not.toContain("headless");
    expect(await main(["headless"])).toBe(2);
    expect(err.join("\n")).toMatch(/start\|status\|stop/);
    err = [];
    expect(await main(["headless", "redemarre"])).toBe(2);
    expect(err.join("\n")).toMatch(/start\|status\|stop/);
  });

  it("status via main : lit l'état du dossier de données", async () => {
    const root = temp();
    const saved = process.env.JAROD_HOME;
    process.env.JAROD_HOME = root;
    try {
      expect(await main(["headless", "status"])).toBe(1);
      expect(out.join("\n") + err.join("\n")).toMatch(/aucune instance/i);
    } finally {
      if (saved === undefined) delete process.env.JAROD_HOME;
      else process.env.JAROD_HOME = saved;
    }
  });
});
