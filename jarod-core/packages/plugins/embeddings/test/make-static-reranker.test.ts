// SPECS-P5-RERANKER.md §2.6 (Q5) : outil Node qui fige les formes de l'IR du reranker (lot × longueur) pour le NPU — sans Python, sans
// téléchargement, simulation par défaut, refuse d'écraser. Faux OpenVINO pour la logique ; le VRAI modèle (s'il est là) pour la preuve.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { freezeRerankerShapes, type OvLike, planRerankerFreeze } from "../src/make-static-reranker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mk-static-"));
  dirs.push(d);
  return d;
};

const XML = `<?xml version="1.0"?><net><layers>
<layer id="0" name="input_ids" type="Parameter"><data shape="?,?" element_type="i64"/></layer>
<layer id="1" name="attention_mask" type="Parameter"><data shape="?,?" element_type="i64"/></layer>
</layers></net>`;

/** Un faux IR source : l'XML des paramètres + les fichiers annexes. */
function source(extra: string[] = ["config.json", "tokenizer.json", "tokenizer_config.json", "openvino_tokenizer.xml", "openvino_tokenizer.bin", "openvino_detokenizer.xml", "openvino_detokenizer.bin"]): string {
  const dir = tmp();
  writeFileSync(join(dir, "openvino_model.xml"), XML);
  writeFileSync(join(dir, "openvino_model.bin"), "poids");
  for (const f of extra) writeFileSync(join(dir, f), `annexe ${f}`);
  return dir;
}

function fakeOv() {
  const calls: { reshape?: Map<string, string>; saved?: { path: string; fp16: boolean } } = {};
  const shapes = new Map<string, string>([["input_ids", "?,?"], ["attention_mask", "?,?"]]);
  const model = {
    get inputs() {
      return [...shapes].map(([name, s]) => ({ getAnyName: () => name, getPartialShape: () => s }));
    },
    reshape(m: Map<string, string>) {
      calls.reshape = m;
      for (const [k, v] of m) shapes.set(k, v);
      return model;
    },
  };
  const ov: OvLike = {
    createCore: () => ({ readModelSync: () => model as never }),
    saveModelSync: (_m, path, fp16) => {
      calls.saved = { path, fp16 };
      writeFileSync(path, XML.replace(/shape="\?,\?"/g, `shape="${shapes.get("input_ids")}"`));
      writeFileSync(path.replace(/\.xml$/, ".bin"), "poids");
    },
  };
  return { ov, calls };
}

describe("planRerankerFreeze (simulation)", () => {
  it("lit les noms d'entrée dans l'XML, ne crée rien, annonce lot × longueur et fichiers annexes", () => {
    const src = source();
    const dest = join(tmp(), "static");
    const plan = planRerankerFreeze({ source: src, dest, batch: 8, maxLength: 512 });
    expect(plan.inputs).toEqual(["input_ids", "attention_mask"]);
    expect(plan.shape).toBe("8,512");
    expect(plan.copy).toContain("openvino_tokenizer.xml");
    expect(existsSync(dest)).toBe(false);
  });

  it("refus nets : lot ou longueur invalides, source sans modèle, destination non vide, destination = source", () => {
    const src = source();
    const dest = join(tmp(), "d");
    expect(() => planRerankerFreeze({ source: src, dest, batch: 0, maxLength: 512 })).toThrow(/batch/);
    expect(() => planRerankerFreeze({ source: src, dest, batch: 2.5, maxLength: 512 })).toThrow(/batch/);
    expect(() => planRerankerFreeze({ source: src, dest, batch: 8, maxLength: -1 })).toThrow(/maxLength/);
    expect(() => planRerankerFreeze({ source: join(tmp(), "vide"), dest, batch: 8, maxLength: 512 })).toThrow(/openvino_model\.xml/);
    const busy = tmp();
    writeFileSync(join(busy, "x"), "1");
    expect(() => planRerankerFreeze({ source: src, dest: busy, batch: 8, maxLength: 512 })).toThrow(/existe déjà|non vide/);
    expect(() => planRerankerFreeze({ source: src, dest: src, batch: 8, maxLength: 512 })).toThrow(/source/);
  });

  it("une IR déjà figée (aucun paramètre dynamique) est signalée", () => {
    const src = source();
    writeFileSync(join(src, "openvino_model.xml"), XML.replace(/shape="\?,\?"/g, 'shape="8,512"'));
    expect(() => planRerankerFreeze({ source: src, dest: join(tmp(), "d"), batch: 8, maxLength: 512 })).toThrow(/dynamique|déjà figée/);
  });
});

describe("freezeRerankerShapes", () => {
  it("fige TOUTES les entrées en « lot,longueur » (CHAÎNES : un objet ou des tableaux seraient ignorés), sauvegarde sans compression FP16, copie les annexes", () => {
    const src = source();
    const dest = join(tmp(), "static");
    const { ov, calls } = fakeOv();
    const r = freezeRerankerShapes({ source: src, dest, batch: 8, maxLength: 512 }, ov);
    expect([...calls.reshape!]).toEqual([["input_ids", "8,512"], ["attention_mask", "8,512"]]);
    expect(calls.saved).toEqual({ path: join(dest, "openvino_model.xml"), fp16: false });
    expect(r.inputs).toEqual([{ name: "input_ids", shape: "8,512" }, { name: "attention_mask", shape: "8,512" }]);
    for (const f of ["config.json", "tokenizer.json", "openvino_tokenizer.xml", "openvino_detokenizer.bin"]) expect(existsSync(join(dest, f))).toBe(true);
    expect(readFileSync(join(dest, "tokenizer.json"), "utf8")).toBe("annexe tokenizer.json");
  });

  it("un reshape qui n'a pas pris (formes restées dynamiques) est une erreur franche, rien n'est laissé à moitié", () => {
    const src = source();
    const dest = join(tmp(), "static");
    const { ov } = fakeOv();
    const stubborn: OvLike = { ...ov, createCore: () => ({ readModelSync: () => ({ inputs: [{ getAnyName: () => "input_ids", getPartialShape: () => "?,?" }], reshape: () => undefined }) as never }) };
    expect(() => freezeRerankerShapes({ source: src, dest, batch: 8, maxLength: 512 }, stubborn)).toThrow(/forme|figées|reshape/);
    expect(existsSync(join(dest, "openvino_model.xml"))).toBe(false);
  });

  it("refuse d'écraser une destination non vide", () => {
    const src = source();
    const dest = tmp();
    writeFileSync(join(dest, "x"), "1");
    expect(() => freezeRerankerShapes({ source: src, dest, batch: 8, maxLength: 512 }, fakeOv().ov)).toThrow(/existe déjà|non vide/);
  });
});

// ── Preuve sur le VRAI modèle, ignorée sans lui ─────────────────────────────────────────────────
const REAL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tools", "ov-bge-reranker-int8");
describe.skipIf(!existsSync(join(REAL, "openvino_model.xml")))("vrai modèle (OpenVINO)", () => {
  it("fige l'IR exportée en 2×16, relue par OpenVINO avec des formes statiques identiques", { timeout: 180_000 }, () => {
    const dest = join(tmp(), "static-2x16");
    mkdirSync(dirname(dest), { recursive: true });
    const r = freezeRerankerShapes({ source: REAL, dest, batch: 2, maxLength: 16 });
    expect(r.inputs.map((i) => i.shape)).toEqual(["2,16", "2,16"]);
    expect(existsSync(join(dest, "openvino_model.bin"))).toBe(true);
    expect(readFileSync(join(dest, "openvino_model.xml"), "utf8")).toContain('shape="2,16"');
  });
});
