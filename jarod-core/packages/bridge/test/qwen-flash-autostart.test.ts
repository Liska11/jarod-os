// Démarrage automatique de l'IA locale (whisper 8090, LFM3-Omni CPU 8080, Qwen WSL 30000) : réglage dans un fichier de config, mêmes gardes que
// le moteur local, attente du store monté (120 s), échec non fatal, services fils arrêtés par stop(). Aucun vrai processus.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoStartQwenFlash, lfmArgs, whisperArgs } from "../src/main/qwen-flash-autostart.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function config(json: unknown): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "qf-cfg-"));
  dirs.push(dir);
  if (json !== undefined) writeFileSync(join(dir, "qwen-flash.json"), typeof json === "string" ? json : JSON.stringify(json));
  return { JAROD_OS_CONFIG_DIR: dir };
}
const realRoot = join("D:", "Jarod-OS", "data");
const FULL = {
  autoStart: true,
  launcher: "C:\\x\\start.ps1",
  whisper: { bin: "w.exe", model: "m.bin", audioCtx: 768 },
  lfm: { bin: "l.exe", model: "lfm.gguf", mmproj: "mm.gguf" },
};

interface Opts {
  up?: Set<number>;
  storeAfter?: number; // nombre d'interrogations avant que le store soit monté (Infinity : jamais)
  spawnError?: string;
  launchError?: string;
  /** Ce que rend la demande de rattachement (invite UAC) : null = accepté et fait ; un texte = refusé. */
  remount?: { error: string | null; mountsStore?: boolean };
  root?: string;
}
async function run(env: NodeJS.ProcessEnv, o: Opts = {}) {
  const lines: string[] = [];
  const spawned: string[] = [];
  const stopped: string[] = [];
  const launched: string[] = [];
  const slept: number[] = [];
  const remounts: string[] = [];
  let polls = 0;
  let attached = false;
  const handle = await autoStartQwenFlash(o.root ?? realRoot, env, (l) => lines.push(l), join(tmpdir(), "x"), {
    probe: async (url) => o.up?.has(Number(new URL(url).port)) === true,
    spawnChild: (name, bin) => (o.spawnError ? { error: o.spawnError } : (spawned.push(`${name}:${bin}`), { stop: () => void stopped.push(name) })),
    launchQwen: (l) => (launched.push(l), o.launchError ?? null),
    storeMounted: async () => attached || ++polls > (o.storeAfter ?? 0),
    remountStore: async (l) => {
      remounts.push(l);
      attached = o.remount?.error === null && o.remount.mountsStore !== false;
      return o.remount?.error ?? null;
    },
    sleep: async (ms) => void slept.push(ms),
  });
  return { lines, spawned, stopped, launched, slept, remounts, handle, polls: () => polls };
}

describe("autoStartQwenFlash", () => {
  it("lève whisper, LFM3-Omni et Qwen quand rien ne tourne", async () => {
    const r = await run(config(FULL));
    expect(r.spawned.sort()).toEqual(["LFM3-Omni:l.exe", "Whisper:w.exe"]);
    expect(r.launched).toEqual(["C:\\x\\start.ps1"]);
    const log = r.lines.join("\n");
    expect(log).toContain("Whisper : démarrage lancé (port 8090)");
    expect(log).toContain("LFM3-Omni : démarrage lancé (port 8080)");
    expect(log).toContain("Qwen Flash : démarrage lancé");
  });

  it("ne relance pas ce qui répond déjà (moteur 8080 levé par le schéma existant, whisper, Qwen)", async () => {
    const r = await run(config(FULL), { up: new Set([8080, 8090, 30000]) });
    expect(r.spawned).toEqual([]);
    expect(r.launched).toEqual([]);
    expect(r.lines.filter((l) => l.includes("déjà actif"))).toHaveLength(3);
  });

  it("attend le store monté avant de lancer Qwen", async () => {
    const r = await run(config(FULL), { storeAfter: 3 });
    expect(r.polls()).toBe(4);
    expect(r.slept).toEqual([5000, 5000, 5000]);
    expect(r.launched).toHaveLength(1);
  });

  it("abandonne Qwen proprement après 120 s sans store, mais garde whisper et LFM3", async () => {
    const r = await run(config(FULL), { storeAfter: Infinity });
    expect(r.launched).toEqual([]);
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(120_000);
    expect(r.lines.join("\n")).toMatch(/Qwen Flash : abandonné — le store n'est pas monté après 120 s/);
    expect(r.spawned).toHaveLength(2);
  });

  it("remountPrompt : store détaché → une demande de rattachement (UAC), puis Qwen démarre sans attendre", async () => {
    const r = await run(config({ ...FULL, remountPrompt: true }), { storeAfter: Infinity, remount: { error: null } });
    expect(r.remounts).toEqual(["C:\\x\\start.ps1"]);
    expect(r.launched).toHaveLength(1);
    expect(r.slept).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/invite UAC à accepter[\s\S]*store rattaché[\s\S]*Qwen Flash : démarrage lancé/);
  });

  it("remountPrompt : invite refusée → on le dit, on attend le délai habituel puis on abandonne (une seule invite)", async () => {
    const r = await run(config({ ...FULL, remountPrompt: true }), { storeAfter: Infinity, remount: { error: "invite refusée" } });
    expect(r.remounts).toHaveLength(1);
    expect(r.launched).toEqual([]);
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(120_000);
    expect(r.lines.join("\n")).toMatch(/rattachement non fait — invite refusée[\s\S]*abandonné/);
  });

  it("remountPrompt : store déjà monté → aucune invite ; réglage absent ou faux → jamais d'invite", async () => {
    const mounted = await run(config({ ...FULL, remountPrompt: true }));
    expect(mounted.remounts).toEqual([]);
    expect(mounted.launched).toHaveLength(1);
    for (const json of [FULL, { ...FULL, remountPrompt: false }]) {
      const r = await run(config(json), { storeAfter: Infinity });
      expect(r.remounts).toEqual([]);
    }
  });

  it("stop() arrête whisper et LFM3 (fils), pas Qwen", async () => {
    const r = await run(config(FULL));
    r.handle.stop();
    expect(r.stopped.sort()).toEqual(["LFM3-Omni", "Whisper"]);
    r.handle.stop();
    expect(r.stopped).toHaveLength(2);
  });

  it("ne fait rien sans fichier, avec autoStart faux ou avec un fichier illisible", async () => {
    for (const c of [undefined, { ...FULL, autoStart: false }, "{pas du json"]) {
      const r = await run(config(c));
      expect(r.spawned).toEqual([]);
      expect(r.launched).toEqual([]);
      expect(r.lines).toEqual([]);
    }
  });

  it("jamais en mode test ni sur un profil temporaire", async () => {
    const a = await run({ ...config(FULL), JAROD_TEST_MODE: "1" });
    expect([a.spawned, a.launched]).toEqual([[], []]);
    expect(a.lines.at(-1)).toContain("mode test");
    const b = await run(config(FULL), { root: join(tmpdir(), "x", "profil") });
    expect([b.spawned, b.launched]).toEqual([[], []]);
    expect(b.lines.at(-1)).toContain("profil temporaire");
  });

  it("un échec d'un service est journalisé et n'empêche pas les autres", async () => {
    const r = await run(config(FULL), { spawnError: "exécutable introuvable (w.exe)", launchError: "lanceur introuvable (x)" });
    const log = r.lines.join("\n");
    expect(log).toMatch(/Whisper : démarrage abandonné — exécutable introuvable/);
    expect(log).toMatch(/LFM3-Omni : démarrage abandonné/);
    expect(log).toMatch(/Qwen Flash : démarrage abandonné — lanceur introuvable/);
  });

  it("n'agit que sur les sections configurées", async () => {
    const r = await run(config({ autoStart: true, launcher: "", whisper: FULL.whisper }));
    expect(r.spawned).toEqual(["Whisper:w.exe"]);
    expect(r.launched).toEqual([]);
  });
});

describe("arguments des services", () => {
  it("whisper : CPU seul, français, route compatible OpenAI, contexte audio réduit", () => {
    expect(whisperArgs({ bin: "w", model: "m.bin", audioCtx: 768 })).toEqual(["-m", "m.bin", "--host", "127.0.0.1", "--port", "8090", "-t", "16", "-l", "fr", "-ng", "--inference-path", "/v1/audio/transcriptions", "-ac", "768"]);
    expect(whisperArgs({ bin: "w", model: "m.bin" })).not.toContain("-ac");
  });
  it("LFM3 : aucune couche GPU, projecteur non déchargé sur le GPU, contexte 4096", () => {
    const a = lfmArgs({ bin: "l", model: "lfm.gguf", mmproj: "mm.gguf" });
    expect(a).toEqual(expect.arrayContaining(["-ngl", "0", "-c", "4096", "--mmproj", "mm.gguf", "--no-mmproj-offload", "--port", "8080"]));
  });
});
