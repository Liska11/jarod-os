// Lot A ① : le parseur texte actuel, sous le contrat `DocumentParser` — même texte que l'ancienne lecture, manifeste déterministe.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentManifest } from "@jarod/contracts";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BuiltinParser, listTextFiles, markdownSections, TEXT_EXT } from "../src/index.js";

afterEach(cleanup);

const parser = new BuiltinParser();
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("BuiltinParser — contrat", () => {
  it("se déclare disponible, avec un moteur nommé et versionné", () => {
    expect(parser.available).toBe(true);
    expect(parser.info()).toEqual({ name: "builtin", version: "1", device: "CPU" });
  });

  it("accepte exactement les extensions texte d'origine, et les types texte ; refuse le reste", () => {
    for (const ext of TEXT_EXT) expect(parser.accepts(`fichier${ext}`), ext).toBe(true);
    expect(parser.accepts("NOTES.MD")).toBe(true);
    expect(parser.accepts("data", "text/csv")).toBe(true);
    expect(parser.accepts("data", "application/json; charset=utf-8")).toBe(true);
    for (const refuse of ["rapport.pdf", "tableau.xlsx", "diapo.pptx", "lettre.docx", "image.png", "sans-extension"]) {
      expect(parser.accepts(refuse), refuse).toBe(false);
    }
    expect(parser.accepts("rapport", "application/pdf")).toBe(false);
  });

  it("rend un manifeste valide pour le contrat, avec le hash, la taille et le type des octets lus", async () => {
    const b = bytes("# Titre\n\nCorps en français : é à ç.\n");
    const { manifest, text } = await parser.parse({ bytes: b, name: "note.md" });
    expect(DocumentManifest.parse(manifest)).toEqual(manifest);
    expect(manifest.source).toEqual({ sha256: sha(b), bytes: b.length, mime: "text/markdown" });
    expect(manifest.parser).toEqual({ name: "builtin", version: "1" });
    expect(manifest).toMatchObject({ manifestVersion: 1, language: null, pages: null, tables: [], images: [], errors: [] });
    expect(text).toBe("# Titre\n\nCorps en français : é à ç.\n");
  });

  it("le type vient de l'appelant s'il en donne un, sinon de l'extension, sinon text/plain", async () => {
    const mime = async (name: string, m?: string) =>
      (await parser.parse({ bytes: bytes("x"), name, ...(m ? { mime: m } : {}) })).manifest.source.mime;
    expect(await mime("a.json")).toBe("application/json");
    expect(await mime("a.html")).toBe("text/html");
    expect(await mime("a.ts")).toBe("text/plain");
    expect(await mime("a")).toBe("text/plain");
    expect(await mime("a.txt", "Text/CSV; charset=utf-8")).toBe("text/csv");
  });
});

describe("BuiltinParser — texte identique à l'ancienne lecture", () => {
  it("chemin et octets rendent le même résultat, et le texte de readFileSync(chemin, 'utf8')", async () => {
    const dir = tempDir();
    const path = join(dir, "n.md");
    // BOM, octet invalide, fins de ligne Windows : rien n'est « corrigé ».
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# A\r\ntexte "), Buffer.from([0xff]), Buffer.from("\r\n")]);
    writeFileSync(path, raw);
    const fromPath = await parser.parse({ path });
    const fromBytes = await parser.parse({ bytes: raw, name: "n.md" });
    expect(fromPath.text).toBe(readFileSync(path, "utf8"));
    expect(fromPath.text.startsWith("﻿")).toBe(true);
    expect(fromPath.text).toContain("�");
    expect(fromBytes).toEqual(fromPath);
  });

  it("un caractère NUL est signalé dans le manifeste (le texte reste celui qu'on a lu)", async () => {
    const { manifest, text } = await parser.parse({ bytes: bytes("a\u0000b"), name: "x.md" });
    expect(manifest.errors).toEqual([{ code: "NUL_CHARACTER", page: null }]);
    expect(text).toBe("a\u0000b");
  });

  it("une annulation demandée avant la lecture interrompt l'analyse", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(parser.parse({ bytes: bytes("x"), name: "x.md" }, ac.signal)).rejects.toThrow();
  });

  it("listTextFiles retient toujours les mêmes fichiers (la liste d'extensions a été déplacée, pas modifiée)", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "sub"), { recursive: true });
    for (const f of ["a.md", "b.PS1", "sub/c.ts", "d.pdf", "e.docx", "f"]) writeFileSync(join(dir, f), "x");
    expect(listTextFiles(dir).map((p) => p.slice(dir.length + 1).replace(/\\/g, "/")).sort()).toEqual(["a.md", "b.PS1", "sub/c.ts"]);
  });
});

describe("BuiltinParser — déterminisme", () => {
  it("même contenu, même manifeste (octet pour octet) ; contenu différent, hash différent", async () => {
    const one = await parser.parse({ bytes: bytes("# A\ntexte\n## B\nsuite"), name: "a.md" });
    const two = await parser.parse({ bytes: bytes("# A\ntexte\n## B\nsuite"), name: "autre-nom.md" });
    expect(JSON.stringify(two.manifest)).toBe(JSON.stringify(one.manifest));
    const three = await parser.parse({ bytes: bytes("# A\ntexte\n## B\nsuite."), name: "a.md" });
    expect(three.manifest.source.sha256).not.toBe(one.manifest.source.sha256);
  });
});

describe("markdownSections", () => {
  const slice = (text: string) => markdownSections(text).map((s) => [s.level, s.title, text.slice(s.start, s.end)]);

  it("repère les titres ATX avec leur niveau ; une section englobe ses sous-sections", () => {
    const text = "# Un\ntexte\n## Deux\nsuite\n### Trois\nfin\n## Quatre\nx\n# Cinq\ny";
    expect(slice(text)).toEqual([
      [1, "Un", "# Un\ntexte\n## Deux\nsuite\n### Trois\nfin\n## Quatre\nx\n"],
      [2, "Deux", "## Deux\nsuite\n### Trois\nfin\n"],
      [3, "Trois", "### Trois\nfin\n"],
      [2, "Quatre", "## Quatre\nx\n"],
      [1, "Cinq", "# Cinq\ny"],
    ]);
  });

  it("ignore les titres dans les blocs de code balisés, les « # » sans espace et les lignes en retrait de 4 espaces", () => {
    const text = "```sh\n# commentaire\n```\n#hashtag\n    # code en retrait\n~~~\n# encore du code\n~~~\n# Vrai titre\n";
    expect(markdownSections(text).map((s) => s.title)).toEqual(["Vrai titre"]);
  });

  it("nettoie le titre (espaces, dièses de fermeture) et accepte les fins de ligne Windows", () => {
    const text = "#   Titre fermé ##  \r\ncorps\r\n## Autre\r\n";
    const s = markdownSections(text);
    expect(s.map((x) => x.title)).toEqual(["Titre fermé", "Autre"]);
    expect(text.slice(s[1]!.start)).toBe("## Autre\r\n");
  });

  it("un document sans titre, ou vide, n'a aucune section ; un titre sans texte est une section vide de titre", () => {
    expect(markdownSections("")).toEqual([]);
    expect(markdownSections("juste du texte")).toEqual([]);
    expect(markdownSections("#\n").length).toBe(0);
    expect(markdownSections("# \nx").map((x) => x.title)).toEqual([""]);
  });

  it("les sections d'un fichier .md sont dans le manifeste ; celles d'un autre type ne sont pas cherchées", async () => {
    const md = await parser.parse({ bytes: bytes("# A\ntexte\n"), name: "a.md" });
    expect(md.manifest.sections).toEqual([{ start: 0, end: 10, page: null, level: 1, title: "A" }]);
    const ts = await parser.parse({ bytes: bytes("# A\ntexte\n"), name: "a.py" });
    expect(ts.manifest.sections).toEqual([]);
  });
});
