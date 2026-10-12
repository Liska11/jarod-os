// Le verdict de la gate B applique les barres figées le 2026-09-30 (DECISIONS) : chaque barre, seule, le fait basculer.
import { describe, expect, it } from "vitest";
import { compare, type DocResult, galleryVerdict, normalizeOutput, type Robustness, tokens } from "../bench/docling-verdict.js";

const H = "a".repeat(64);
const doc = (over: Partial<DocResult> = {}): DocResult => ({
  id: "F01",
  format: "docx",
  recall: 0.99,
  excess: 0.02,
  hashes: [H, H],
  manifestPages: 0,
  manifestTables: 1,
  manifestSections: 2,
  ref: { tables: 1, headings: 2 },
  processFailure: false,
  ...over,
});
const ok: Robustness = { orphans: 0, cleanRefusals: true };

describe("jetons et comparaison", () => {
  it("NFKC, minuscules, sans accents ; lettres et chiffres seulement", () => {
    expect(tokens("Éléphant, N°42 — ﬁn (2e)")).toEqual(["elephant", "n", "42", "fin", "2e"]);
  });

  it("rappel multi-ensemble, insensible à l'ordre ; excès = jetons en trop", () => {
    expect(compare("un deux trois", "trois deux un")).toMatchObject({ recall: 1, excess: 0 });
    expect(compare("un un deux", "un deux").recall).toBeCloseTo(2 / 3);
    const c = compare("un deux", "un deux trois quatre");
    expect(c.recall).toBe(1);
    expect(c.excess).toBeCloseTo(0.5);
    expect(compare("", "x").recall).toBe(1);
    expect(compare("x", "").excess).toBe(0);
  });
});

describe("métrique v2 : artefacts du rendu Markdown retirés de la SORTIE", () => {
  it("le marqueur d'image disparaît, la cible d'un lien aussi ; le texte du lien reste", () => {
    expect(tokens(normalizeOutput("avant <!-- image --> après"))).toEqual(["avant", "apres"]);
    expect(tokens(normalizeOutput("écrire à [Service Accès](mailto:acces@exemple.fr) ou [ici](file:///C:/Users/x/a%20b.pdf)"))).toEqual(["ecrire", "a", "service", "acces", "ou", "ici"]);
    expect(compare("Bonjour le monde", normalizeOutput("Bonjour [le monde](http://x.fr/%20y) <!-- image -->")).excess).toBe(0);
  });

  it("n'efface pas le texte ordinaire : crochets seuls, parenthèses seules, commentaires autres que l'image", () => {
    expect(normalizeOutput("[note] (suite) <!-- autre -->")).toBe("[note] (suite) <!-- autre -->");
  });
});

describe("verdict de la gate B", () => {
  const green = () => galleryVerdict([doc(), doc({ id: "F02", format: "pdf", manifestPages: 3, ref: { pages: 3 } })], ok, 2);

  it("verte quand toutes les barres tiennent", () => {
    expect(green().verdict).toBe("verte");
  });

  it("rappel : un document à 94 % ou à 79 % suffit à la rendre rouge ; 95 % pile passe", () => {
    expect(galleryVerdict([doc({ recall: 0.95 })], ok, 1).verdict).toBe("verte");
    expect(galleryVerdict([doc({ recall: 0.94 })], ok, 1).bars.recall.ok).toBe(false);
    expect(galleryVerdict([doc({ recall: 0.79 })], ok, 1).bars.recall.detail).toContain("F01");
  });

  it("excès > 10 % : rouge ; 10 % pile passe", () => {
    expect(galleryVerdict([doc({ excess: 0.1 })], ok, 1).verdict).toBe("verte");
    expect(galleryVerdict([doc({ excess: 0.11 })], ok, 1).bars.excess.ok).toBe(false);
  });

  it("déterminisme : empreintes différentes ou absentes = rouge", () => {
    expect(galleryVerdict([doc({ hashes: [H, "b".repeat(64)] })], ok, 1).bars.determinism.ok).toBe(false);
    expect(galleryVerdict([doc({ hashes: [H, null] })], ok, 1).bars.determinism.ok).toBe(false);
  });

  it("pages d'un PDF : égalité exacte avec pdfium", () => {
    const pdf = (manifestPages: number, pages?: number) => doc({ format: "pdf", manifestPages, ref: pages === undefined ? {} : { pages } });
    expect(galleryVerdict([pdf(3, 3)], ok, 1).bars.pages.ok).toBe(true);
    expect(galleryVerdict([pdf(2, 3)], ok, 1).bars.pages.ok).toBe(false);
    expect(galleryVerdict([pdf(3)], ok, 1).bars.pages.ok).toBe(false);
    expect(galleryVerdict([doc()], ok, 1).bars.pages.ok).toBe(true); // sans objet : vacuement tenue
  });

  it("structure : tableau, titres (docx) et cellules (xlsx) présents dans la référence ne doivent pas disparaître", () => {
    expect(galleryVerdict([doc({ manifestTables: 0 })], ok, 1).bars.structure.ok).toBe(false);
    expect(galleryVerdict([doc({ manifestSections: 0 })], ok, 1).bars.structure.ok).toBe(false);
    expect(galleryVerdict([doc({ format: "xlsx", ref: { cells: 5 }, manifestTables: 0 })], ok, 1).bars.structure.ok).toBe(false);
    expect(galleryVerdict([doc({ format: "xlsx", ref: { cells: 0 }, manifestTables: 0 })], ok, 1).bars.structure.ok).toBe(true);
    expect(galleryVerdict([doc({ format: "pptx", ref: {}, manifestTables: 0, manifestSections: 0 })], ok, 1).bars.structure.ok).toBe(true);
  });

  it("robustesse : échec de processus, orphelin ou refus non net = rouge", () => {
    expect(galleryVerdict([doc({ processFailure: true })], ok, 1).bars.robustness.ok).toBe(false);
    expect(galleryVerdict([doc()], { orphans: 1, cleanRefusals: true }, 1).bars.robustness.ok).toBe(false);
    expect(galleryVerdict([doc()], { orphans: 0, cleanRefusals: false }, 1).bars.robustness.ok).toBe(false);
  });

  it("incomplète : documents manquants, robustesse non mesurée ou aucun document — jamais une victoire", () => {
    expect(galleryVerdict([doc()], ok, 2).verdict).toBe("incomplète");
    expect(galleryVerdict([doc()], null, 1).verdict).toBe("incomplète");
    expect(galleryVerdict([], ok, 0).verdict).toBe("incomplète");
  });

  it("une barre manquée l'emporte sur l'incomplétude", () => {
    expect(galleryVerdict([doc({ recall: 0.5 })], ok, 9).verdict).toBe("rouge");
  });
});
