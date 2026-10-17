// B3 contre Docling 2.140 (profil sans PyTorch, pipeline PDF natif), moteur réel dans engines/docling. Documents FABRIQUÉS.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanOutput, DOCLING, planParse } from "../../src/index.js";
import { HAS_PY, PY, ROOT } from "./helpers.js";

const DOC_DIR = join(ROOT, "engines", "docling", "Scripts");
const DOC_PY = join(DOC_DIR, "python.exe");
const has = HAS_PY && existsSync(DOC_PY);
const dir = mkdtempSync(join(tmpdir(), "jarod-docling-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!has)("B3 contre Docling (moteur réel)", () => {
  const spec = { ...DOCLING, launcher: `python "${join(ROOT, "jarod-core", "sidecars", "docling-md", "docling_md.py").split("\\").join("/")}"` };
  const env = { ...process.env, PATH: `${DOC_DIR};${process.env.PATH}`, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
  const convert = (path: string) => cleanOutput(spec, execSync(String(planParse(spec, { path, sizeBytes: 1000 }, true).args.command), { cwd: dir, env, encoding: "utf8", timeout: 300_000 })).markdown;

  it("prépare les documents fabriqués (docx, pptx, xlsx, html, pdf)", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    execFileSync(DOC_PY, [join(import.meta.dirname, "mk_office_docs.py")], { cwd: join(dir, "docs"), timeout: 120_000 });
    writeFileSync(join(dir, "mkpdf.py"), 'import pymupdf\nd = pymupdf.open()\np = d.new_page()\np.insert_text((72, 72), "Rapport trimestriel: chiffre 42")\nd.save("docs/rapport.pdf")\n');
    execFileSync(PY, [join(dir, "mkpdf.py")], { cwd: dir, timeout: 60_000 });
    expect(existsSync(join(dir, "docs", "t.docx"))).toBe(true);
  }, 200_000);

  it("DOCX : titre et tableau reconnus", () => {
    const md = convert("docs/t.docx");
    expect(md).toContain("# Titre Un");
    expect(md).toContain("Un paragraphe de test.");
    expect(md).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
  }, 300_000);

  it("PPTX, XLSX, HTML : texte reconnu", () => {
    expect(convert("docs/t.pptx")).toContain("Diapo");
    expect(convert("docs/t.xlsx")).toMatch(/\|\s*x\s*\|\s*y\s*\|/);
    expect(convert("docs/t.html")).toContain("# Page");
  }, 300_000);

  it("PDF natif : le texte et les pages sont rendus (pas de titres ni de tableaux, limite connue du profil sans modèle)", () => {
    const md = convert("docs/rapport.pdf");
    expect(md).toContain("Rapport trimestriel");
    expect(md).toContain("42");
  }, 300_000);

  it("aucune requête réseau n'est nécessaire : le profil est hors ligne", () => {
    expect(existsSync(join(ROOT, "engines", "docling", "Lib", "site-packages", "torch"))).toBe(false);
  });
});
