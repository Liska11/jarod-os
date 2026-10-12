// SPECS-P5-RERANKER.md §2.1, §3 : câblage du reranker dans un profil — `reranker.json` + drapeaux `ecosystem` EN MODE FANTÔME. Simulation par
// défaut, sauvegarde `.bak`, refus d'une IR à formes dynamiques (le NPU la refuse) ou d'un autre lot ; jamais le mode « active » (décision à part).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRerankerFlags,
  checkRerankerModel,
  DEFAULT_RERANKER_DEADLINE_MS,
  DEFAULT_RERANKER_PORT,
  DEFAULT_RERANKER_TOP_N,
  rerankerConfigFor,
  writeRerankerFile,
} from "../src/wire-reranker.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-wire-rr-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const xml = (shape: string) => `<net><layers><layer id="0" name="input_ids" type="Parameter"><data shape="${shape}" element_type="i64"/></layer><layer id="1" name="attention_mask" type="Parameter"><data shape="${shape}" element_type="i64"/></layer></layers></net>`;
function model(shape: string): string {
  const d = tmp();
  writeFileSync(join(d, "openvino_model.xml"), xml(shape));
  return d;
}

describe("valeurs de la spec", () => {
  it("port 8930 (Q3), N = 16 (Q2), échéance 4 000 ms (barre (b))", () => {
    expect([DEFAULT_RERANKER_PORT, DEFAULT_RERANKER_TOP_N, DEFAULT_RERANKER_DEADLINE_MS]).toEqual([8930, 16, 4000]);
  });
});

describe("rerankerConfigFor", () => {
  it("par défaut : l'IR figée du dépôt (tools/ov-bge-reranker-int8-b8x512, chemin absolu), port 8930, lot 8, longueur 512", () => {
    const c = rerankerConfigFor();
    expect(isAbsolute(c.modelDir)).toBe(true);
    expect(c.modelDir.split(String.fromCharCode(92)).join("/").endsWith("/tools/ov-bge-reranker-int8-b8x512")).toBe(true);
    expect(c).toMatchObject({ port: 8930, batch: 8, maxLength: 512 });
  });

  it("valeurs explicites ; port hors bornes, lot ou longueur non entiers, dossier relatif : refusés", () => {
    expect(rerankerConfigFor({ port: 9001, modelDir: tmpdir(), batch: 4, maxLength: 256 })).toEqual({ modelDir: tmpdir(), port: 9001, batch: 4, maxLength: 256 });
    for (const port of [0, 70000, 8930.5, Number.NaN]) expect(() => rerankerConfigFor({ port })).toThrow(/port/);
    for (const batch of [0, 2.5]) expect(() => rerankerConfigFor({ batch })).toThrow(/batch/);
    expect(() => rerankerConfigFor({ maxLength: 0 })).toThrow(/maxLength/);
    expect(() => rerankerConfigFor({ modelDir: "relatif/modele" })).toThrow(/absolu/);
  });
});

describe("checkRerankerModel", () => {
  it("dossier absent, sans openvino_model.xml : raison dite", () => {
    const d = tmp();
    expect(checkRerankerModel(join(d, "absent"), 8, 512)).toMatch(/introuvable/);
    expect(checkRerankerModel(d, 8, 512)).toMatch(/openvino_model\.xml/);
  });

  it("IR à formes DYNAMIQUES : refusée avec la marche à suivre (le NPU la refuse)", () => {
    expect(checkRerankerModel(model("?,?"), 8, 512)).toMatch(/dynamique.*make-static-reranker/);
  });

  it("IR figée à un AUTRE lot ou une AUTRE longueur : refusée (le worker enverrait des tenseurs de mauvaise taille)", () => {
    expect(checkRerankerModel(model("4,512"), 8, 512)).toMatch(/4,512.*8,512|lot|forme/);
    expect(checkRerankerModel(model("8,256"), 8, 512)).toMatch(/8,256.*8,512|longueur|forme/);
  });

  it("IR figée au bon lot et à la bonne longueur : acceptée", () => {
    expect(checkRerankerModel(model("8,512"), 8, 512)).toBeNull();
  });
});

describe("writeRerankerFile", () => {
  const cfg = () => ({ modelDir: tmp(), port: 8930, batch: 8, maxLength: 512 });

  it("simulation : rien n'est écrit ; --apply : fichier posé, relisible", () => {
    const profile = tmp();
    const c = cfg();
    expect(writeRerankerFile(profile, c, false)).toEqual({ written: false, path: join(profile, "reranker.json"), backup: null });
    expect(existsSync(join(profile, "reranker.json"))).toBe(false);
    const r = writeRerankerFile(profile, c, true);
    expect(r.written).toBe(true);
    expect(JSON.parse(readFileSync(r.path, "utf8"))).toEqual(c);
  });

  it("un fichier existant est sauvegardé en .bak (jamais écrasé sans trace)", () => {
    const profile = tmp();
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "reranker.json"), JSON.stringify({ modelDir: "S:\\ancien", port: 1234 }));
    const r = writeRerankerFile(profile, cfg(), true);
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual({ modelDir: "S:\\ancien", port: 1234 });
  });
});

describe("applyRerankerFlags", () => {
  it("allume le reranker en mode FANTÔME avec le budget complet ; ne touche à AUCUNE autre clé", () => {
    const before = { vectorIndex: "memory", vectorShadow: null, documentParser: "docling", reranker: "off", rerankMode: "shadow" };
    const after = applyRerankerFlags(before);
    expect(after).toEqual({ ...before, reranker: "bge-reranker-v2-m3-npu", rerankTopN: 16, rerankDeadlineMs: 4000, rerankMode: "shadow" });
    expect(before.reranker).toBe("off"); // l'entrée n'est pas modifiée
  });

  it("n'active JAMAIS le mode « active » de lui-même (absent = shadow) et ne rétrograde JAMAIS un choix déjà fait", () => {
    expect(applyRerankerFlags({}).rerankMode).toBe("shadow");
    expect(applyRerankerFlags({ rerankMode: "shadow" }).rerankMode).toBe("shadow");
    expect(applyRerankerFlags({ rerankMode: "active" }).rerankMode).toBe("active");
  });

  it("idempotent : rejouer donne le même résultat", () => {
    const once = applyRerankerFlags({ documentParser: "docling" });
    expect(applyRerankerFlags(once)).toEqual(once);
  });
});
