// Lot A ④ : découpeur déterministe d'un document structuré — frontières de section respectées, mêmes sorties à chaque appel.
import type { DocumentManifest } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { BuiltinParser, chunkDocument, chunkTextSpans, markdownSections } from "../src/index.js";

const manifestWith = (sections: DocumentManifest["sections"]): DocumentManifest => ({
  manifestVersion: 1,
  parser: { name: "test", version: "1" },
  source: { sha256: "0".repeat(64), bytes: 0, mime: "text/markdown" },
  language: null,
  pages: null,
  sections,
  tables: [],
  images: [],
  errors: [],
});
const doc = (text: string, sections: DocumentManifest["sections"]) => ({ manifest: manifestWith(sections), text });
const para = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} phrase numéro ${i} du paragraphe, avec quelques mots de plus.`).join("\n");
const sec = (text: string, level: number, title: string, from: number, to: number) => ({ start: from, end: to, page: null, level, title });

/** Texte à trois sections de niveau 1 (~ 300 caractères chacune) et leurs sections. */
function threeSections() {
  const parts = [`# Alpha\n${para("a", 5)}\n`, `# Bêta\n${para("b", 5)}\n`, `# Gamma\n${para("g", 5)}\n`];
  const text = parts.join("");
  const sections = [];
  let at = 0;
  for (const [i, p] of parts.entries()) {
    sections.push(sec(text, 1, ["Alpha", "Bêta", "Gamma"][i]!, at, at + p.length));
    at += p.length;
  }
  return doc(text, sections);
}

describe("chunkDocument", () => {
  it("sans section : exactement le découpage d'origine, section et page inconnues", () => {
    const text = para("x", 30);
    for (const [size, overlap] of [[200, 0], [150, 40], [800, 100]] as const) {
      const got = chunkDocument(doc(text, []), size, overlap);
      expect(got.map(({ text: t, start, end }) => ({ text: t, start, end }))).toEqual(chunkTextSpans(text, size, overlap));
      expect(got.every((c) => c.section === null && c.page === null)).toBe(true);
    }
  });

  it("aucun chunk ne franchit une frontière de section, recouvrement compris ; chaque chunk retrouve son texte", () => {
    const d = threeSections();
    const bounds = d.manifest.sections.map((s) => s.start).filter((o) => o > 0);
    for (const overlap of [0, 60]) {
      const chunks = chunkDocument(d, 200, overlap);
      expect(chunks.length).toBeGreaterThan(3);
      for (const c of chunks) {
        expect(d.text.slice(c.start, c.end)).toBe(c.text);
        expect(c.end - c.start).toBeLessThanOrEqual(200);
        for (const b of bounds) expect(c.start < b && b < c.end, `chunk ${c.start}-${c.end} franchit ${b}`).toBe(false);
      }
      // Chaque section a au moins un chunk qui commence sur son titre, et porte son nom.
      expect(chunks.filter((c) => bounds.includes(c.start) || c.start === 0).map((c) => c.section)).toEqual(["Alpha", "Bêta", "Gamma"]);
    }
  });

  it("aucun caractère utile perdu : tout ce qui n'est pas un blanc est dans au moins un chunk, dans l'ordre du texte", () => {
    const d = threeSections();
    const chunks = chunkDocument(d, 150, 30);
    const covered = new Uint8Array(d.text.length);
    for (const c of chunks) covered.fill(1, c.start, c.end);
    for (let i = 0; i < d.text.length; i++) if (/\S/.test(d.text[i]!)) expect(covered[i], `caractère ${i}`).toBe(1);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.start);
  });

  it("la section d'un chunk est la plus profonde qui contient son début", () => {
    const text = `# A\n${para("a", 4)}\n## A1\n${para("u", 4)}\n## A2\n${para("d", 4)}\n`;
    const d = doc(text, markdownSections(text));
    const byTitle = new Map<string, number>();
    for (const c of chunkDocument(d, 160, 0)) byTitle.set(c.section ?? "∅", (byTitle.get(c.section ?? "∅") ?? 0) + 1);
    expect([...byTitle.keys()].sort()).toEqual(["A", "A1", "A2"]);
    const first = chunkDocument(d, 160, 0)[0]!;
    expect(first).toMatchObject({ start: 0, section: "A" });
  });

  it("un segment trop court (moins d'un quart de la taille) n'est pas un chunk à lui seul : il rejoint la suite", () => {
    const text = `# Titre seul\n## Sous-titre\n${para("p", 4)}\n`;
    const sections = markdownSections(text);
    expect(sections.map((s) => s.title)).toEqual(["Titre seul", "Sous-titre"]);
    const [first] = chunkDocument(doc(text, sections), 400, 0);
    // « # Titre seul\n » (13 caractères) < 100 : la frontière du sous-titre est abandonnée, un seul chunk les réunit.
    expect(first!.text.startsWith("# Titre seul\n## Sous-titre\n")).toBe(true);
    expect(first!.section).toBe("Titre seul");
  });

  it("déterministe : mêmes entrées, mêmes chunks, octet pour octet ; l'ordre des sections du manifeste n'y change rien", () => {
    const d = threeSections();
    const one = JSON.stringify(chunkDocument(d, 180, 20));
    expect(JSON.stringify(chunkDocument(d, 180, 20))).toBe(one);
    const shuffled = doc(d.text, [...d.manifest.sections].reverse());
    expect(JSON.stringify(chunkDocument(shuffled, 180, 20))).toBe(one);
    const other = chunkDocument(d, 90, 20); // un autre réglage donne d'autres chunks (le test ne serait pas trivial)
    expect(JSON.stringify(other)).not.toBe(one);
  });

  it("tolère des sections hors du texte, en double ou à 0 ; un texte vide ou blanc n'a aucun chunk", () => {
    const text = para("t", 6);
    const odd = [sec(text, 1, "Début", 0, 50), sec(text, 1, "Double", 100, 200), sec(text, 1, "Double bis", 100, 200), sec(text, 1, "Dehors", 99999, 100000)];
    const chunks = chunkDocument(doc(text, odd), 120, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text);
    expect(chunkDocument(doc("", odd), 120, 0)).toEqual([]);
    expect(chunkDocument(doc("  \n\t ", []), 120, 0)).toEqual([]);
  });

  it("sur un vrai document Markdown passé par le parseur builtin : sections repérées, chunks alignés, deux passes identiques", async () => {
    const md = `# Guide\n${para("i", 5)}\n\n## Installation\n${para("n", 5)}\n\n## Usage\n${para("u", 5)}\n`;
    const parsed = await new BuiltinParser().parse({ bytes: new TextEncoder().encode(md), name: "guide.md" });
    const chunks = chunkDocument(parsed, 200, 0);
    expect(chunks.map((c) => c.section)).toContain("Installation");
    expect(chunks.map((c) => c.section)).toContain("Usage");
    for (const c of chunks) expect(parsed.text.slice(c.start, c.end)).toBe(c.text);
    expect(JSON.stringify(chunkDocument(await new BuiltinParser().parse({ bytes: new TextEncoder().encode(md), name: "guide.md" }), 200, 0))).toBe(JSON.stringify(chunks));
  });
});
