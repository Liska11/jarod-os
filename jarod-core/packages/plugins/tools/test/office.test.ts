// B2 : création de documents Word, Excel, PowerPoint et PDF. On relit les octets écrits (ZIP et XML pour Office, table des références pour le PDF) :
// ce qu'un lecteur strict verrait, pas ce que le code croit avoir écrit.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as nodeCrc32, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDocx } from "../src/office/docx.js";
import { parseInline, parseMarkdown } from "../src/office/markdown.js";
import { buildPdf, PDF_MAX_PAGES } from "../src/office/pdf.js";
import { buildPptx } from "../src/office/pptx.js";
import { buildDocument, officeTools } from "../src/office/tool.js";
import { buildXlsx, checkFormula, columnName, XLSX_MAX_ROWS } from "../src/office/xlsx.js";
import { xmlText } from "../src/office/xml.js";
import { crc32, listZip, zip } from "../src/office/zip.js";

/** Un lecteur de ZIP indépendant de l'écrivain : répertoire central, puis inflation de chaque partie. */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const n = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + n);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = method === 8 ? inflateRawSync(buf.subarray(dataAt, dataAt + csize)) : buf.subarray(dataAt, dataAt + csize);
    expect(raw.length, name).toBe(usize);
    expect(crc32(raw) >>> 0, name).toBe(crc);
    out.set(name, raw.toString("utf8"));
    p += 46 + n + extra + comment;
  }
  return out;
}

/** Le XML est bien formé : balises appariées, rien d'ouvert à la fin. */
function wellFormed(xml: string): void {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, "").matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) expect(stack.pop(), `fermeture </${name}>`).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  // aucun « < » ni « & » nu dans le texte
  expect(xml.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|apos|#\d+);/g, "")).not.toMatch(/[<&]/);
}

describe("ZIP et XML", () => {
  it("le CRC est celui de Node, l'archive se relit et refuse les noms dangereux ou en double", () => {
    const data = Buffer.from("bonjour ".repeat(500));
    expect(crc32(data)).toBe(nodeCrc32(data) >>> 0);
    const z = zip([{ name: "a/b.txt", data: "un" }, { name: "c.bin", data }]);
    expect(listZip(z)).toEqual(["a/b.txt", "c.bin"]);
    expect([...unzip(z).keys()]).toEqual(["a/b.txt", "c.bin"]);
    for (const bad of ["../x", "/x", "a\\b", ""]) expect(() => zip([{ name: bad, data: "x" }]), bad).toThrow(/invalide/);
    expect(() => zip([{ name: "x", data: "1" }, { name: "x", data: "2" }])).toThrow(/double/);
    expect(zip([{ name: "x", data: "1" }]).equals(zip([{ name: "x", data: "1" }]))).toBe(true); // pas d'horloge dans l'archive
  });

  it("un texte ne peut pas fermer une balise ; les caractères interdits en XML disparaissent, les émojis restent", () => {
    expect(xmlText("</w:t><w:evil/> & \"x\"")).toBe("&lt;/w:t&gt;&lt;w:evil/&gt; &amp; \"x\"");
    expect(xmlText("a\u0000b\u0008c\u000bd￾e\ud800f")).toBe("abcdef");
    expect(xmlText("ok 😀 é\ttab\nligne")).toBe("ok 😀 é\ttab\nligne");
  });
});

describe("Markdown de documents", () => {
  it("lit titres, listes, tableaux, code et mises en forme — et rien d'autre", () => {
    const blocks = parseMarkdown("# T\n\npara **gras** et *it* `c`\nsuite\n\n- a\n1. b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n[lien](http://x) ![img](y)");
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "li", "li", "table", "code", "p"]);
    expect(blocks[1]).toMatchObject({ runs: [{ text: "para " }, { text: "gras", bold: true }, { text: " et " }, { text: "it", italic: true }, { text: " " }, { text: "c", code: true }, { text: " suite" }] });
    expect((blocks[6] as { runs: Array<{ text: string }> }).runs[0]!.text).toContain("[lien](http://x)"); // un lien reste du texte
    expect(parseInline("").length).toBe(1);
    expect(() => parseMarkdown("x".repeat(400_001))).toThrow(/trop long/);
  });
});

describe("Word", () => {
  it("produit les parties d'un .docx, du XML bien formé, et échappe le contenu", () => {
    const z = unzip(buildDocx({ title: "Rapport <1>", markdown: "## Bilan\n\nTexte </w:t><x/> & suite\n\n- puce\n\n| a | b |\n|---|---|\n| </w:tc> | 2 |", now: new Date("2026-03-01T10:00:00Z") }));
    expect([...z.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/styles.xml", "word/document.xml", "docProps/core.xml"]);
    for (const [name, xml] of z) wellFormed(xml), expect(name).toBeTruthy();
    const doc = z.get("word/document.xml")!;
    expect(doc).toContain("Texte &lt;/w:t&gt;&lt;x/&gt; &amp; suite");
    expect(doc).not.toContain("<x/>");
    expect(doc).toContain('w:pStyle w:val="Heading2"');
    expect(doc).toContain("<w:tbl>");
    expect(z.get("docProps/core.xml")).toContain("2026-03-01T10:00:00Z");
  });
});

describe("Excel", () => {
  it("écrit nombres, textes, booléens et formules ; un texte qui ressemble à une formule reste un texte", () => {
    const z = unzip(
      buildXlsx({
        sheets: [
          { name: "Dépenses", rows: [["Mois", "Montant"], ["Mars", 1200], ["=cmd|' /C calc'!A0", 3.5], ["@SUM(1)", { formula: "SUM(B2:B3)" }], [true, null]] },
          { name: "Dépenses", rows: [["x"]] },
        ],
      }),
    );
    for (const xml of z.values()) wellFormed(xml);
    const s1 = z.get("xl/worksheets/sheet1.xml")!;
    expect(s1).toContain('<c r="B2"><v>1200</v></c>');
    expect(s1).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">=cmd|&apos; /C calc&apos;!A0</t></is></c>'.replace(/&apos;/g, "'"));
    expect(s1).toContain('<c r="A4" t="inlineStr">'); // « @SUM » : du texte
    expect(s1).toContain("<f>SUM(B2:B3)</f>");
    expect(s1).toContain('t="b"><v>1</v>');
    expect(s1).toContain('s="1"'); // en-tête en gras
    expect(z.get("xl/workbook.xml")).toContain('name="Dépenses"');
    expect(z.get("xl/workbook.xml")).toContain('name="Dépenses (2)"'); // nom unique
  });

  it("refuse les formules qui sortent du classeur ou qui ne sont pas des formules", () => {
    expect(checkFormula("=SUM(A1:A9)")).toBe("SUM(A1:A9)");
    expect(checkFormula('IF(A1>0,"oui","non")')).toBe('IF(A1>0,"oui","non")');
    for (const bad of ['HYPERLINK("http://x","y")', 'WEBSERVICE("http://x")', "cmd|' /C calc'!A0", "'[autre.xlsx]Feuille1'!A1", 'DDE("a","b","c")', "exec (1)", "SUM(A1", 'A1&"x', "", "x".repeat(1001), "A1;B1\u0000"]) {
      expect(() => checkFormula(bad), bad.slice(0, 30)).toThrow();
    }
  });

  it("borne feuilles, lignes, colonnes ; nomme les colonnes ; nettoie les noms de feuille", () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
    expect(() => buildXlsx({ sheets: [] })).toThrow(/Au moins/);
    expect(() => buildXlsx({ sheets: [{ name: "a", rows: Array.from({ length: XLSX_MAX_ROWS + 1 }, () => []) }] })).toThrow(/trop de lignes/);
    expect(() => buildXlsx({ sheets: [{ name: "a", rows: [Array.from({ length: 101 }, () => 1)] }] })).toThrow(/colonnes/);
    expect(() => buildXlsx({ sheets: [{ name: "a", rows: [[Number.NaN]] }] })).toThrow(/invalide/);
    const z = unzip(buildXlsx({ sheets: [{ name: "[a]:b*c?/d\\e".padEnd(40, "x"), rows: [["1"]] }] }));
    const name = /name="([^"]+)"/.exec(z.get("xl/workbook.xml")!)![1]!;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });
});

describe("PowerPoint", () => {
  it("écrit une maquette, une diapositive par entrée, du XML bien formé et le texte échappé", () => {
    const z = unzip(buildPptx({ slides: [{ title: "Bienvenue" }, { title: "Points <clés>", bullets: ["Un & deux", "</a:t><x/>", "  "] }] }));
    for (const xml of z.values()) wellFormed(xml);
    expect([...z.keys()].filter((k) => /slides\/slide\d+\.xml$/.test(k))).toEqual(["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]);
    const s2 = z.get("ppt/slides/slide2.xml")!;
    expect(s2).toContain("Points &lt;clés&gt;");
    expect(s2).toContain("Un &amp; deux");
    expect(s2).not.toContain("<x/>");
    expect(s2.match(/<a:p>/g)).toHaveLength(3); // titre + 2 puces (la puce blanche est retirée)
    expect(z.get("ppt/presentation.xml")).toContain('<p:sldId id="257"');
  });

  it("refuse une présentation vide, sans titre, ou démesurée", () => {
    expect(() => buildPptx({ slides: [] })).toThrow(/Au moins/);
    expect(() => buildPptx({ slides: [{ title: "  " }] })).toThrow(/title/);
    expect(() => buildPptx({ slides: Array.from({ length: 101 }, () => ({ title: "t" })) })).toThrow(/Trop de diapositives/);
    expect(() => buildPptx({ slides: [{ title: "t", bullets: Array.from({ length: 21 }, () => "b") }] })).toThrow(/puces/);
  });
});

describe("PDF", () => {
  const objects = (pdf: Buffer) => {
    const text = pdf.toString("latin1");
    const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const [, head] = /xref\n0 (\d+)\n/.exec(text.slice(xref))!;
    const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(Number(head) - 1);
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length), `objet ${i + 1}`).toBe(`${i + 1} 0 obj`));
    return { text, count: offsets.length };
  };

  it("écrit un PDF dont la table des références pointe sur chaque objet, avec ses pages numérotées", () => {
    const pdf = buildPdf({ title: "Rapport", markdown: "# Titre\n\nTexte accentué éàç.\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```" });
    expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    const { text } = objects(pdf);
    expect(text).toContain("/Count 1");
    expect(text).toContain("<31202f2031>"); // « 1 / 1 », le pied de page
    expect(text).not.toMatch(/\/JS|\/JavaScript|\/OpenAction|\/URI|\/Launch/);
  });

  it("passe à la page suivante, coupe les mots trop longs, et plafonne le nombre de pages", () => {
    const long = buildPdf({ markdown: "mot ".repeat(6000) });
    const { text } = objects(long);
    const pages = Number(/\/Count (\d+)/.exec(text)![1]);
    expect(pages).toBeGreaterThan(3);
    expect(text).toContain(`<${[...`${pages} / ${pages}`].map((c) => c.charCodeAt(0).toString(16)).join("")}>`);
    const oneWord = buildPdf({ markdown: "x".repeat(400) });
    expect(objects(oneWord).text).toMatch(/\/Count 1\b/); // 400 caractères sans espace ne débordent pas la page
    expect(() => buildPdf({ markdown: ("ligne\n\n").repeat(PDF_MAX_PAGES * 60) })).toThrow(/trop long/);
  });

  it("encode le français en WinAnsi et remplace ce qui n'existe pas par « ? »", () => {
    const text = buildPdf({ markdown: "é€—😀" }).toString("latin1");
    expect(text).toContain("<e98097" + "3f>"); // é (e9), € (80), — (97), puis « ? » (3f) pour l'émoji
  });
});

describe("document_create", () => {
  let ws: string;
  const tool = () => officeTools()[0]!;
  const ctx = () => ({ sessionId: "s1", workspace: ws });
  beforeEach(() => void (ws = mkdtempSync(join(tmpdir(), "jarod-office-"))));
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("est un seul outil, dangereux (accord demandé), classé par son chemin", () => {
    expect(officeTools()).toHaveLength(1);
    expect(tool()).toMatchObject({ name: "document_create", dangerous: true });
    expect(tool().targetOf?.({ path: "a.docx" })).toBe("a.docx");
  });

  it("crée un classeur Excel ouvrable, le fichier relu est celui annoncé", async () => {
    const args = { path: "Budget mars.xlsx", sheets: [{ name: "Mars", rows: [["Poste", "€"], ["Loyer", 700]] }] };
    const out = await tool().run(args, ctx());
    expect(out).toMatch(/^Document Excel créé : Budget mars\.xlsx \(\d+ octets\)$/);
    const bytes = readFileSync(join(ws, "Budget mars.xlsx"));
    expect(listZip(bytes)).toContain("xl/worksheets/sheet1.xml");
    expect(await tool().verify!(args, out, ctx())).toMatchObject({ status: "verified" });
  });

  it("la demande d'accord nomme le fichier ; une demande mal formée est refusée avant toute demande", () => {
    expect(tool().precheck!({ path: "sous/rapport.docx", markdown: "# Salut" }, ctx())).toMatch(/^Créer le document Word « sous[\\/]rapport\.docx » \(\d+ Ko\)$/);
    expect(() => tool().precheck!({ path: "x.txt", markdown: "a" }, ctx())).toThrow(/\.docx, \.xlsx, \.pptx ou \.pdf/);
    expect(() => tool().precheck!({ path: "x.docx" }, ctx())).toThrow(/markdown/);
    expect(() => tool().precheck!({ path: "x.xlsx", sheets: [{ name: "a", rows: [[{ formula: 'HYPERLINK("http://x")' }]] }] }, ctx())).toThrow(/Formule refusée/);
    expect(() => tool().precheck!({ path: "x.pptx", slides: [] }, ctx())).toThrow(/slides/);
  });

  it("ne sort jamais du dossier de travail (chemin relatif, absolu, lien)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "jarod-outside-"));
    try {
      symlinkSync(outside, join(ws, "lien"), "junction");
      for (const path of ["../evasion.pdf", join(outside, "abs.pdf"), "lien/dedans.pdf"]) {
        await expect(tool().run({ path, markdown: "x" }, ctx()), path).rejects.toThrow(/hors du dossier de travail/);
      }
      expect(() => tool().precheck!({ path: "../evasion.pdf", markdown: "x" }, ctx())).toThrow(/hors du dossier/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ne remplace jamais un fichier existant, ni avant l'accord, ni à l'écriture", async () => {
    mkdirSync(join(ws, "d"));
    writeFileSync(join(ws, "d", "x.pdf"), "précieux");
    expect(() => tool().precheck!({ path: "d/x.pdf", markdown: "neuf" }, ctx())).toThrow(/existe déjà/);
    await expect(tool().run({ path: "d/x.pdf", markdown: "neuf" }, ctx())).rejects.toThrow(/existe déjà/);
    expect(readFileSync(join(ws, "d", "x.pdf"), "utf8")).toBe("précieux");
  });

  it("sans dossier de travail, refuse", async () => {
    await expect(tool().run({ path: "a.pdf", markdown: "x" }, { sessionId: "s1", workspace: null })).rejects.toThrow(/Aucun dossier de travail/);
  });

  it("buildDocument donne les mêmes octets pour le même contenu et la même date (reproductible)", () => {
    const now = new Date("2026-01-02T03:04:05Z");
    const a = buildDocument({ path: "a.pdf", markdown: "# A\n\nb" }, now).bytes;
    expect(a.equals(buildDocument({ path: "a.pdf", markdown: "# A\n\nb" }, now).bytes)).toBe(true);
  });
});
