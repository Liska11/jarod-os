// Bench Q16 multilingue (B19) : la barre figée le 2026-09-29 (DECISIONS) est codée telle quelle — chaque ligne testée à sa
// frontière, aucune victoire par défaut ; les dérivations du banc (jetons spéciaux, allowzero) ne touchent que ce qu'elles disent.
import { describe, expect, it } from "vitest";
import { patchAllowZero, renameSpecials, SPECIAL_IDS } from "../bench/q16-ml-bundle.js";
import { type Q16MlMeasures, q16MlVerdict } from "../bench/q16-ml-verdict.js";

const above: Q16MlMeasures = {
  frIntent: { laya: 45, bge: 34, total: 60 },
  frMedianConfidence: 0.3,
  frReminder: { hits: 8, total: 12 },
};

describe("verdict Q16 multilingue — barre figée", () => {
  it("toutes les lignes exactement à la barre : fantôme", () => {
    const v = q16MlVerdict(above);
    expect(v.verdict).toBe("fantôme");
    expect(v.lines.map((l) => l.ok)).toEqual([true, true, true, true]);
  });

  it("intent FR 44/60 : clôture", () => {
    const v = q16MlVerdict({ ...above, frIntent: { laya: 44, bge: 34, total: 60 } });
    expect(v.verdict).toBe("clôture");
    expect(v.lines[0]).toMatchObject({ ok: false, detail: "44/60" });
  });

  it("écart au baseline < +5 requêtes : clôture, même avec l'intent à 45 (bge-m3 à 41)", () => {
    const v = q16MlVerdict({ ...above, frIntent: { laya: 45, bge: 41, total: 60 } });
    expect(v.verdict).toBe("clôture");
    expect(v.lines.map((l) => l.ok)).toEqual([true, false, true, true]);
    expect(q16MlVerdict({ ...above, frIntent: { laya: 46, bge: 41, total: 60 } }).verdict).toBe("fantôme");
  });

  it("confiance médiane 0,2999 : clôture ; rappels 7/12 : clôture", () => {
    expect(q16MlVerdict({ ...above, frMedianConfidence: 0.2999 }).verdict).toBe("clôture");
    expect(q16MlVerdict({ ...above, frReminder: { hits: 7, total: 12 } }).verdict).toBe("clôture");
  });

  it("une seule ligne sous la barre suffit, quelle que soit la marge des autres", () => {
    const v = q16MlVerdict({ frIntent: { laya: 60, bge: 34, total: 60 }, frMedianConfidence: 0.99, frReminder: { hits: 7, total: 12 } });
    expect(v.verdict).toBe("clôture");
  });

  it("mesure absente : incomplet, jamais fantôme ; une ligne sous la barre reste une clôture", () => {
    expect(q16MlVerdict({ ...above, frMedianConfidence: null }).verdict).toBe("incomplet");
    expect(q16MlVerdict({ ...above, frIntent: null }).verdict).toBe("incomplet");
    expect(q16MlVerdict({ frIntent: { laya: 10, bge: 34, total: 60 }, frMedianConfidence: null, frReminder: null }).verdict).toBe("clôture");
  });
});

describe("dérivations du banc Q16 multilingue", () => {
  it("renameSpecials : noms des jetons spéciaux (clés et valeurs exactes) seulement ; le reste de l'arbre est intact", () => {
    const src = {
      added_tokens: [{ id: 2, content: "<bos>", special: true }, { id: 9, content: "<unused2>", special: false }],
      post_processor: { single: [{ SpecialToken: { id: "<bos>" } }], special_tokens: { "<bos>": { id: "<bos>", ids: [2], tokens: ["<bos>"] } } },
      model: { vocab: { "<pad>": 0, "<eos>": 1, "<mask>": 4, bonjour: 1234 }, merges: [["a", "b"]] },
    };
    const { json, renamed } = renameSpecials(src);
    expect(json.added_tokens[0]).toEqual({ id: 2, content: "[CLS]", special: true });
    expect(json.added_tokens[1]).toEqual(src.added_tokens[1]);
    expect(json.model.vocab).toEqual({ "[PAD]": 0, "[SEP]": 1, "[MASK]": 4, bonjour: 1234 });
    expect(json.model.merges).toEqual(src.model.merges);
    expect(json.post_processor.special_tokens).toEqual({ "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] } });
    expect(renamed).toBe(1 + 1 + 3 + 3); // added_tokens, single, special_tokens (clé, id, tokens), vocab ×3
    expect(SPECIAL_IDS).toEqual({ "[CLS]": 2, "[SEP]": 1, "[MASK]": 4, "[PAD]": 0 });
    expect(src.model.vocab["<pad>"]).toBe(0); // l'entrée n'est pas modifiée
  });

  it("patchAllowZero : n'abaisse que `allowzero` = 1 (champ varint), compte exactement, rend une copie", () => {
    const attr = (v: number) => Buffer.concat([Buffer.from("allowzero"), Buffer.from([0x18, v])]);
    const src = Buffer.concat([Buffer.from([1, 2]), attr(1), Buffer.from("xx"), attr(0), Buffer.from("yy"), attr(1), Buffer.from("allowzeroZ")]);
    const { model, patched } = patchAllowZero(src);
    expect(patched).toBe(2);
    expect(Buffer.from(model).toString("latin1")).toBe(
      Buffer.concat([Buffer.from([1, 2]), attr(0), Buffer.from("xx"), attr(0), Buffer.from("yy"), attr(0), Buffer.from("allowzeroZ")]).toString("latin1"),
    );
    expect(src.includes(attr(1))).toBe(true); // l'original garde ses `1`
  });
});
