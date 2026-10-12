// DECISIONS.md (≈ 660 Ko, une entrée par ligne) devient illisible d'un coup d'œil : un index généré (`pnpm decisions:index` → DECISIONS-INDEX.md),
// une ligne par décision avec son numéro de ligne, groupé par mois. Le fichier source n'est ni découpé ni réécrit (des dizaines de renvois « DECISIONS 2026-10-01 » le citent).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDecisions, renderIndex } from "./decisions-index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SAMPLE = [
  "# DECISIONS (chronologique)",
  "",
  "- 2026-09-26 · Workspace : `packages/*` + `packages/plugins/*` · conforme PLAN §1.",
  "| tableau | hors entrée |",
  "- 2026-10-05 · **`web_fetch` AJOUTÉ à `NEVER_ALWAYS` (décision de l'utilisateur).** Un accord permanent…",
  "  - sous-puce : pas une entrée",
  `- 2026-10-06 · ${"mot ".repeat(80)}`,
].join("\n");

describe("index de DECISIONS.md", () => {
  it("une entrée par ligne « - AAAA-MM-JJ · », avec son numéro de ligne (1-based) ; le reste est ignoré", () => {
    const e = parseDecisions(SAMPLE);
    expect(e.map((x) => [x.line, x.date])).toEqual([
      [3, "2026-09-26"],
      [5, "2026-10-05"],
      [7, "2026-10-06"],
    ]);
  });

  it("titre : le premier segment en gras s'il ouvre l'entrée, sinon le début du texte, coupé à un mot (≤ 160 caractères)", () => {
    const [a, b, c] = parseDecisions(SAMPLE);
    expect(b!.title).toBe("`web_fetch` AJOUTÉ à `NEVER_ALWAYS` (décision de l'utilisateur).");
    expect(a!.title).toBe("Workspace : `packages/*` + `packages/plugins/*` · conforme PLAN §1.");
    expect(c!.title.length).toBeLessThanOrEqual(161);
    expect(c!.title.endsWith("…")).toBe(true);
    expect(c!.title).not.toMatch(/mo…$/);
  });

  it("rendu : un titre par mois (le plus récent d'abord), un lien vers la ligne", () => {
    const md = renderIndex(parseDecisions(SAMPLE));
    expect(md.indexOf("## 2026-10")).toBeLessThan(md.indexOf("## 2026-09"));
    expect(md).toContain("- [2026-10-05](DECISIONS.md#L5) · `web_fetch` AJOUTÉ");
    expect(md).toMatch(/3 décisions/);
  });

  it("sur le vrai DECISIONS.md : autant d'entrées que de lignes datées, aucune sans titre", () => {
    const text = readFileSync(join(ROOT, "DECISIONS.md"), "utf8");
    const dated = text.split(/\r?\n/).filter((l) => /^- \d{4}-\d{2}-\d{2} · /.test(l)).length;
    const e = parseDecisions(text);
    expect(e.length).toBe(dated);
    expect(dated).toBeGreaterThan(400);
    for (const x of e) expect(x.title.trim().length, `ligne ${x.line}`).toBeGreaterThan(0);
  });
});
