// C3 contre Presidio et B5 contre markitdown (+ OCR/PyMuPDF), moteurs réels dans engines/py. Documents FABRIQUÉS uniquement.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanOutput, detectPii, type ExternalFinding, MARKITDOWN, maskPii, maskPiiWith, planParse } from "../../src/index.js";
import { HAS_PY, PY, PY_DIR, SIDECARS } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "jarod-pyengine-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function presidio(text: string): ExternalFinding[] {
  const out = execFileSync(PY, [join(SIDECARS, "presidio", "analyze.py")], { input: JSON.stringify({ text }), encoding: "utf8", timeout: 120_000 });
  return JSON.parse(out) as ExternalFinding[];
}

describe.skipIf(!HAS_PY)("C3 contre Presidio (moteur réel)", () => {
  const text = "Contact: jean.dupont@example.com, card 4111 1111 1111 1111, IBAN FR1420041010050500013M02606, server 192.168.1.20. Jean Dupont lives in Paris.";

  it("tout ce que notre couche locale masque est aussi reconnu par Presidio (même type, mêmes bornes)", () => {
    const external = presidio(text);
    const map: Record<string, string> = { email: "EMAIL_ADDRESS", card: "CREDIT_CARD", iban: "IBAN_CODE", ip: "IP_ADDRESS" };
    for (const f of detectPii(text)) {
      const hit = external.find((e) => e.entity === map[f.category] && e.start <= f.start && e.end >= f.end);
      expect(hit, `${f.category} reconnu par Presidio`).toBeDefined();
    }
  }, 180_000);

  it("l'union masque en plus les noms et lieux que la couche locale ne voit pas, sans jamais afficher la valeur", () => {
    const local = maskPii(text).text;
    expect(local).toContain("Jean Dupont lives in Paris");
    const both = maskPiiWith(text, presidio(text));
    expect(both.text).not.toMatch(/Jean Dupont|Paris|example\.com|4111/);
    expect(both.counts.PERSON).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(both.counts)).not.toMatch(/Dupont/);
  }, 180_000);

  it("des bornes invalides venant du moteur ne cassent pas le texte", () => {
    const r = maskPiiWith("abc", [{ entity: "PERSON", start: 5, end: 99, score: 1 }, { entity: "bad label", start: 0, end: 2, score: 1 }, { entity: "PERSON", start: 0, end: 2, score: 0.1 }]);
    expect(r.text).toBe("abc");
  });
});

describe.skipIf(!HAS_PY)("B5 contre markitdown (moteur réel, extensions OCR comprises)", () => {
  const env = { ...process.env, PATH: `${PY_DIR};${process.env.PATH}`, PYTHONUTF8: "1" };
  const run = (command: string) => execSync(command, { cwd: dir, env, encoding: "utf8", timeout: 180_000 });

  it("convertit un HTML fabriqué en Markdown par la commande que construit l'adaptateur", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "page.html"), "<html><body><h1>Titre</h1><p>Un <b>paragraphe</b>.</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>");
    const call = planParse(MARKITDOWN, { path: "docs/page.html", sizeBytes: 200 }, true);
    const md = cleanOutput(MARKITDOWN, run(String(call.args.command))).markdown;
    expect(md).toContain("# Titre");
    expect(md).toContain("**paragraphe**");
    expect(md).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
  }, 200_000);

  it("convertit un PDF fabriqué avec PyMuPDF, avec l'option OCR demandée", () => {
    writeFileSync(join(dir, "mk.py"), 'import pymupdf\nd = pymupdf.open()\np = d.new_page()\np.insert_text((72, 72), "Rapport trimestriel: chiffre 42")\nd.save("docs/rapport.pdf")\n');
    execFileSync(PY, [join(dir, "mk.py")], { cwd: dir, timeout: 60_000 });
    const call = planParse(MARKITDOWN, { path: "docs/rapport.pdf", sizeBytes: 5000, ocr: true }, true);
    expect(String(call.args.command)).toContain("--use-plugins");
    const md = cleanOutput(MARKITDOWN, run(String(call.args.command))).markdown;
    expect(md).toContain("Rapport trimestriel");
    expect(md).toContain("42");
  }, 200_000);

  it("une sortie hostile (séquences d'échappement, texte invisible) est nettoyée avant d'aller plus loin", () => {
    writeFileSync(join(dir, "docs", "hostile.html"), "<p>ok‮​ texte</p>");
    const md = cleanOutput(MARKITDOWN, run('markitdown "docs/hostile.html"')).markdown;
    expect(md).not.toMatch(/[‮​]/);
    expect(md).toContain("ok");
  }, 200_000);
});
