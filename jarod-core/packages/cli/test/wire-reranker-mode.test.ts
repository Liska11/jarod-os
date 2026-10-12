// SPECS-P5-RERANKER-ACTIVE.md §2-§3 (Q2) : `wire-reranker --mode active|shadow` — SEUL réglage touché : `ecosystem.rerankMode`. Simulation par
// défaut, application FERMÉE exigée (refus si le profil est tenu par un processus vivant), copie du réglage avant écriture, relecture à
// l'identique. Sans `--mode`, le comportement d'avant est inchangé (voir wire-reranker.test.ts, intact). Aucun profil réel n'est touché ici.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarodApp, start, stop } from "@jarod/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { backupEcosystem, changeRerankMode, liveProfileHolder, type ModeSettings, parseModeArgs, RERANK_MODES, setRerankMode } from "../src/wire-reranker.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-wire-mode-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const WIRED = { vectorIndex: "memory", documentParser: "docling", hybrid: "off", reranker: "bge-reranker-v2-m3-npu", rerankTopN: 16, rerankDeadlineMs: 4000, rerankMode: "shadow" };

/** Réglages factices : `get`/`set` de `ecosystem`, avec compte des écritures. */
function fakeSettings(eco: Record<string, unknown>, o: { dropOnSet?: string } = {}) {
  let cur: Record<string, unknown> = structuredClone(eco);
  const writes: unknown[] = [];
  return {
    writes,
    get: (_k: "ecosystem") => structuredClone(cur),
    set: (_k: "ecosystem", v: unknown) => {
      writes.push(structuredClone(v));
      cur = structuredClone(v as Record<string, unknown>);
      if (o.dropOnSet) delete cur[o.dropOnSet]; // relecture différente de ce qui a été écrit
    },
  };
}

describe("RERANK_MODES et parseModeArgs", () => {
  it("deux modes, exactement", () => {
    expect([...RERANK_MODES]).toEqual(["shadow", "active"]);
  });

  it("--mode active / shadow ; simulation par défaut ; --apply l'arme ; profil par défaut = default", () => {
    expect(parseModeArgs(["--mode", "active"])).toEqual({ mode: "active", apply: false, profile: "default" });
    expect(parseModeArgs(["--mode", "shadow", "--apply"])).toEqual({ mode: "shadow", apply: true, profile: "default" });
    expect(parseModeArgs(["--apply", "--mode", "active", "--profile", "autre"])).toEqual({ mode: "active", apply: true, profile: "autre" });
  });

  it("sans --mode : null (le comportement d'avant, inchangé)", () => {
    expect(parseModeArgs([])).toEqual({ mode: null, apply: false, profile: "default" });
    expect(parseModeArgs(["--apply", "--port", "9001"])).toMatchObject({ mode: null, apply: true });
  });

  it("valeur inconnue, absente, ou suivie d'un autre drapeau : refusées avec les valeurs permises", () => {
    for (const bad of [["--mode"], ["--mode", "Active"], ["--mode", "on"], ["--mode", ""], ["--mode", "off"], ["--mode", "--apply"], ["--mode", "active,shadow"]]) {
      expect(() => parseModeArgs(bad), JSON.stringify(bad)).toThrow(/shadow.*active|active.*shadow/);
    }
  });

  it("--mode ne se mêle à aucune option de pose (--port, --model-dir) : « rien d'autre ne change »", () => {
    expect(() => parseModeArgs(["--mode", "active", "--port", "9001"])).toThrow(/--port/);
    expect(() => parseModeArgs(["--mode", "shadow", "--model-dir", "S:/m"])).toThrow(/--model-dir/);
  });
});

describe("setRerankMode", () => {
  it("active posé, shadow rétabli ; TOUTES les autres clés identiques ; l'entrée n'est pas modifiée", () => {
    const before = structuredClone(WIRED);
    const a = setRerankMode(WIRED, "active");
    expect(a).toEqual({ ...WIRED, rerankMode: "active" });
    expect(WIRED).toEqual(before);
    expect(setRerankMode(a, "shadow")).toEqual(WIRED);
  });

  it("idempotent", () => {
    const a = setRerankMode(WIRED, "active");
    expect(setRerankMode(a, "active")).toEqual(a);
  });

  it("refuse si le reranker n'est pas posé ou sans budget complet (activer un reranker éteint n'a pas de sens) : la raison dit quoi faire", () => {
    for (const eco of [{}, { ...WIRED, reranker: "off" }, { ...WIRED, rerankTopN: undefined }, { ...WIRED, rerankDeadlineMs: undefined }]) {
      expect(() => setRerankMode(eco, "active"), JSON.stringify(eco)).toThrow(/wire-reranker.*--apply|pos/i);
    }
  });

  it("refuse une valeur hors des deux modes, même contournée par un cast", () => {
    for (const bad of ["Active", "on", "", undefined, null, 1]) expect(() => setRerankMode(WIRED, bad as never), String(bad)).toThrow(/shadow.*active|active.*shadow/);
  });
});

describe("liveProfileHolder — profil tenu par un processus vivant", () => {
  it("pas de verrou : libre ; verrou d'un processus MORT : libre", () => {
    const d = tmp();
    expect(liveProfileHolder(d)).toBeNull();
    writeFileSync(join(d, "runtime.lock"), JSON.stringify({ pid: 2147483000, mode: "desktop", startedAt: 1 }));
    expect(liveProfileHolder(d)).toBeNull();
  });

  it("verrou d'un processus VIVANT (le nôtre) : refus qui nomme le pid et demande de fermer l'application", () => {
    const d = tmp();
    writeFileSync(join(d, "runtime.lock"), JSON.stringify({ pid: process.pid, mode: "desktop", startedAt: 1 }));
    const m = liveProfileHolder(d);
    expect(m).toMatch(new RegExp(`pid ${process.pid}`));
    expect(m).toMatch(/ferm/i);
  });
});

describe("backupEcosystem", () => {
  it("copie du réglage AVANT écriture, dans le dossier du profil, sans écraser une copie existante", () => {
    const d = tmp();
    const t = new Date("2026-10-02T22:15:30.123Z");
    const a = backupEcosystem(d, WIRED, t);
    const b = backupEcosystem(d, { ...WIRED, rerankMode: "active" }, t);
    expect(a).not.toBe(b);
    expect(JSON.parse(readFileSync(a, "utf8"))).toEqual(WIRED);
    expect(JSON.parse(readFileSync(b, "utf8"))).toEqual({ ...WIRED, rerankMode: "active" });
    expect(readdirSync(d).filter((f) => f.startsWith("ecosystem-avant-mode-"))).toHaveLength(2);
    expect(a.startsWith(d)).toBe(true);
  });
});

describe("changeRerankMode", () => {
  it("SIMULATION (défaut) : rien n'est écrit, ni réglage ni copie ; avant/après rendus", () => {
    const d = tmp();
    const s = fakeSettings(WIRED);
    const r = changeRerankMode({ settings: s, dir: d, mode: "active", apply: false });
    expect(r).toMatchObject({ applied: false, changed: true, before: "shadow", after: "active", backup: null });
    expect(s.writes).toHaveLength(0);
    expect(readdirSync(d)).toEqual([]);
  });

  it("--apply : la copie est écrite AVANT le réglage ; seul rerankMode change ; relu à l'identique", () => {
    const d = tmp();
    const s = fakeSettings(WIRED);
    const r = changeRerankMode({ settings: s, dir: d, mode: "active", apply: true });
    expect(r).toMatchObject({ applied: true, changed: true, before: "shadow", after: "active" });
    expect(s.writes).toEqual([{ ...WIRED, rerankMode: "active" }]);
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual(WIRED);
    expect(s.get("ecosystem")).toEqual({ ...WIRED, rerankMode: "active" });
  });

  it("retour au fantôme : même chemin, symétrique", () => {
    const d = tmp();
    const s = fakeSettings({ ...WIRED, rerankMode: "active" });
    const r = changeRerankMode({ settings: s, dir: d, mode: "shadow", apply: true });
    expect(r).toMatchObject({ applied: true, changed: true, before: "active", after: "shadow" });
    expect(s.get("ecosystem")).toEqual(WIRED);
  });

  it("déjà dans le mode demandé : rien n'est écrit (ni réglage, ni copie)", () => {
    const d = tmp();
    const s = fakeSettings(WIRED);
    const r = changeRerankMode({ settings: s, dir: d, mode: "shadow", apply: true });
    expect(r).toMatchObject({ applied: false, changed: false, backup: null });
    expect(s.writes).toHaveLength(0);
    expect(readdirSync(d)).toEqual([]);
  });

  it("profil tenu par un processus vivant : REFUS avant toute lecture ou écriture, simulation comprise", () => {
    const d = tmp();
    writeFileSync(join(d, "runtime.lock"), JSON.stringify({ pid: process.pid, mode: "desktop", startedAt: 1 }));
    for (const apply of [false, true]) {
      const s = fakeSettings(WIRED);
      let reads = 0;
      const spy = { ...s, get: (k: "ecosystem") => (reads++, s.get(k)) };
      expect(() => changeRerankMode({ settings: spy, dir: d, mode: "active", apply })).toThrow(/pid/);
      expect(reads).toBe(0);
      expect(s.writes).toHaveLength(0);
    }
    expect(readdirSync(d)).toEqual(["runtime.lock"]);
  });

  it("reranker non posé : refus, rien d'écrit", () => {
    const d = tmp();
    const s = fakeSettings({ reranker: "off", rerankMode: "shadow" });
    expect(() => changeRerankMode({ settings: s, dir: d, mode: "active", apply: true })).toThrow(/wire-reranker/);
    expect(s.writes).toHaveLength(0);
    expect(readdirSync(d)).toEqual([]);
  });

  it("relecture différente de ce qui a été écrit : erreur franche (la copie, elle, reste)", () => {
    const d = tmp();
    const s = fakeSettings(WIRED, { dropOnSet: "documentParser" });
    expect(() => changeRerankMode({ settings: s, dir: d, mode: "active", apply: true })).toThrow(/Relecture différente/);
    expect(readdirSync(d).filter((f) => f.startsWith("ecosystem-avant-mode-"))).toHaveLength(1);
  });

  it("ne touche à AUCUN fichier de pose : reranker.json absent reste absent, présent reste identique", () => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "reranker.json"), '{"modelDir":"S:/m","port":8930}\n');
    changeRerankMode({ settings: fakeSettings(WIRED), dir: d, mode: "active", apply: true });
    expect(readFileSync(join(d, "reranker.json"), "utf8")).toBe('{"modelDir":"S:/m","port":8930}\n');
    expect(existsSync(join(d, "reranker.json.bak"))).toBe(false);
  });
});

describe("changeRerankMode sur un VRAI stockage (base chiffrée temporaire, aucun profil réel)", () => {
  const cipher = { encrypt: (s: string) => `ss:${s}`, decrypt: (s: string) => s.slice(3) };

  it("--apply relu à l'identique par les vrais réglages ; seul rerankMode change ; retour symétrique ; simulation n'écrit rien", async () => {
    const dir = tmp();
    const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher } } } as never);
    const started = await start(app);
    try {
      const settings = (app as unknown as { storage: { settings: ModeSettings } }).storage.settings;
      settings.set("ecosystem", { ...settings.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 16, rerankDeadlineMs: 4000, rerankMode: "shadow" });
      const start0 = settings.get("ecosystem");

      expect(changeRerankMode({ settings, dir, mode: "active", apply: false })).toMatchObject({ applied: false, changed: true, before: "shadow", after: "active" });
      expect(settings.get("ecosystem")).toEqual(start0);
      expect(readdirSync(dir).filter((f) => f.startsWith("ecosystem-avant-mode-"))).toEqual([]);

      const on = changeRerankMode({ settings, dir, mode: "active", apply: true });
      expect(on).toMatchObject({ applied: true, changed: true });
      expect(settings.get("ecosystem")).toEqual({ ...start0, rerankMode: "active" });
      expect(JSON.parse(readFileSync(on.backup!, "utf8"))).toEqual(start0);

      const off = changeRerankMode({ settings, dir, mode: "shadow", apply: true });
      expect(off).toMatchObject({ applied: true, before: "active", after: "shadow" });
      expect(settings.get("ecosystem")).toEqual(start0);
      expect(readdirSync(dir).filter((f) => f.startsWith("ecosystem-avant-mode-"))).toHaveLength(2);
    } finally {
      await stop(started);
    }
  });
});
