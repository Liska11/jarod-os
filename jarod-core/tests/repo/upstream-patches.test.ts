/**
 * SPECS-P5-UI-PARITE.md § 24.3 (HN4) : le correctif AMONT de `Providers.tsx` (`licenses/upstream-patches/0001-providers-remote-panes.patch`) est exactement l'écart voulu — rien
 * d'autre que le masquage de trois éléments derrière `__JAROD_REMOTE_PANES__` — et il s'applique à la révision amont. Le dépôt amont (`S:\SANK-UI`) n'est JAMAIS modifié :
 * le test lit l'amont par `git show` (lecture seule) et applique le correctif sur une COPIE temporaire.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PATCH = join(repoRoot, "licenses", "upstream-patches", "0001-providers-remote-panes.patch");
const REL = "src/renderer/src/screens/Providers/Providers.tsx";
const REV = "20759e7";
const UPSTREAM = "S:/SANK-UI";
const patch = readFileSync(PATCH, "utf8").replace(/\r\n/g, "\n");
const body = patch.split("\n").filter((l) => !l.startsWith("#"));
const added = body.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
const removed = body.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));

describe("HN4 — le correctif amont de Providers.tsx", () => {
  it("ne touche qu'un fichier, le bon, et ne retire qu'UNE ligne (le rendu de l'onglet « Auxiliary », réécrit gardé)", () => {
    expect(body.filter((l) => l.startsWith("diff --git"))).toEqual([`diff --git a/${REL} b/${REL}`]);
    expect(removed).toEqual(['      {activeTab === "auxiliary" && <AuxiliaryTasksSection visible={visible} />}']);
  });

  it("ne fait qu'ajouter des gardes : la constante (gardée par `typeof`), trois blocs `{REMOTE_PANES && (` … `)}` et le rendu de l'onglet", () => {
    expect(added.filter((l) => l.trim() === "{REMOTE_PANES && (").length, "blocs gardés").toBe(3);
    expect(added.filter((l) => l.trim() === ")}").length, "fermetures").toBe(3);
    expect(added).toContain("declare const __JAROD_REMOTE_PANES__: boolean | undefined;");
    expect(added).toContain('const REMOTE_PANES = typeof __JAROD_REMOTE_PANES__ === "undefined" || __JAROD_REMOTE_PANES__;');
    expect(added).toContain('      {REMOTE_PANES && activeTab === "auxiliary" && <AuxiliaryTasksSection visible={visible} />}');
    const other = added.filter((l) => l.trim() !== "" && !l.includes("REMOTE_PANES") && l.trim() !== ")}" && !l.startsWith("//") && !l.startsWith("// "));
    // le seul autre contenu ajouté est le commentaire de la constante ; aucune logique nouvelle.
    expect(other, other.join("\n")).toEqual([]);
  });

  const upstreamHas = existsSync(join(UPSTREAM, ".git")) || existsSync(join(UPSTREAM, "src"));
  it.skipIf(!upstreamHas)("s'applique à la révision amont 20759e7 (copie temporaire ; S:\\SANK-UI lu par `git show`, jamais modifié)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-patch-"));
    try {
      const file = join(dir, ...REL.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, execFileSync("git", ["-C", UPSTREAM, "show", `${REV}:${REL}`], { maxBuffer: 64 * 1024 * 1024 }));
      const p = join(dir, "p.patch");
      writeFileSync(p, patch);
      execFileSync("git", ["apply", "--check", p], { cwd: dir });
      execFileSync("git", ["apply", p], { cwd: dir });
      const after = readFileSync(file, "utf8");
      expect(after).toContain("const REMOTE_PANES = typeof __JAROD_REMOTE_PANES__");
      expect(after.match(/REMOTE_PANES &&/g)?.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
