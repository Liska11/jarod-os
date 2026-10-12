// Portage de packages/core/test/annotations.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { AnnotationService, parseUnifiedDiff } from "../src/annotations.js";
import { makeCore } from "./helpers.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export {};",
  "\\ No newline at end of file",
  "diff --git a/src/new.ts b/src/new.ts",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const n = 1;",
  "+export const m = 2;",
].join("\n");

const MOVED = DIFF.replace("+const c = 4;", "+const c = 44; // modifié depuis la note");

async function service(): Promise<{ annotations: AnnotationService; core: Awaited<ReturnType<typeof makeCore>> }> {
  const core = await makeCore();
  return { core, annotations: new AnnotationService({ db: core.db, events: core.events }) };
}

describe("annotations — lire un diff", () => {
  it("donne à chaque ligne ses deux numéros, sans confondre ajout et suppression", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/new.ts"]);
    expect([files[0]?.added, files[0]?.removed]).toEqual([2, 1]);
    expect([files[1]?.added, files[1]?.removed]).toEqual([2, 0]);

    const lines = files[0]?.hunks.flatMap((h) => h.lines) ?? [];
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ]);
    // La note « pas de saut de ligne » n'est pas une ligne du fichier.
    expect(files[0]?.hunks[0]?.lines).toHaveLength(5);
  });

  it("ne rend pas un texte qui n'est pas un diff", () => {
    expect(parseUnifiedDiff("bonjour\nà tous")).toEqual([]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("annotations — les notes vivent dans la base", () => {
  it("est idempotent : deux fois la même note sur la même ligne = une note", async () => {
    const { annotations } = await service();
    const first = annotations.add("revue", "src/a.ts", 3, "  pourquoi 4 ?  ", { anchor: "const c = 4;" });
    const again = annotations.add("revue", "src/a.ts", 3, "pourquoi 4 ?", { anchor: "const c = 4;" });
    expect(first.id).toBe(again.id);
    expect(annotations.list("revue")).toHaveLength(1);
    expect(annotations.list("revue")[0]?.text).toBe("pourquoi 4 ?");
  });

  it("refuse une note vide ou une ligne qui n'en est pas une", async () => {
    const { annotations } = await service();
    expect(() => annotations.add("revue", "src/a.ts", 1, "   ")).toThrow("ANNOTATION_EMPTY");
    expect(() => annotations.add("revue", "src/a.ts", 2.5, "note")).toThrow("ANNOTATION_BAD_LINE");
  });

  it("se relit depuis une autre instance : rien n'est gardé en mémoire du service", async () => {
    const core = await makeCore();
    new AnnotationService({ db: core.db, events: core.events }).add("revue", "src/a.ts", 2, "deux", {
      anchor: "const b = 2;",
    });
    // Une seconde instance sur la même base voit la note : c'est la base qui la porte.
    const relu = new AnnotationService({ db: core.db }).list("revue");
    expect(relu.map((a) => [a.file, a.line, a.text])).toEqual([["src/a.ts", 2, "deux"]]);
    const row = core.db.get<{ n: number }>("SELECT count(*) AS n FROM annotations WHERE ref = ?", "revue");
    expect(row?.n).toBe(1);
  });

  it("range les notes par fichier puis par ligne, et sait en retirer une", async () => {
    const { annotations } = await service();
    annotations.add("revue", "src/b.ts", 10, "b10");
    annotations.add("revue", "src/a.ts", 20, "a20");
    annotations.add("revue", "src/a.ts", 5, "a5");
    expect(annotations.list("revue").map((a) => `${a.file}:${a.line}`)).toEqual([
      "src/a.ts:5",
      "src/a.ts:20",
      "src/b.ts:10",
    ]);
    const id = annotations.list("revue")[0]?.id ?? "";
    expect(annotations.remove(id)).toBe(true);
    expect(annotations.remove(id)).toBe(false);
    expect(annotations.list("revue")).toHaveLength(2);
  });
});

describe("annotations — une note dont la ligne a bougé", () => {
  it("reste lisible et se signale détachée, au lieu de pointer ailleurs en silence", async () => {
    const { annotations } = await service();
    annotations.add("revue", "src/a.ts", 3, "pourquoi 4 ?", { anchor: "const c = 4;" });

    const intact = annotations.review("revue", DIFF);
    expect(intact[0]?.detached).toBeUndefined();

    const apres = annotations.review("revue", MOVED);
    expect(apres[0]?.detached).toBe(true);
    // La note et son ancre sont conservées : on montre que le code a bougé, on n'efface rien.
    expect(apres[0]?.text).toBe("pourquoi 4 ?");
    expect(apres[0]?.anchor).toBe("const c = 4;");
  });

  it("signale aussi une ligne qui n'existe plus dans le diff", async () => {
    const { annotations } = await service();
    annotations.add("revue", "src/parti.ts", 3, "note orpheline");
    expect(annotations.review("revue", DIFF)[0]?.detached).toBe(true);
  });

  it("écrit pour l'agent la note, la ligne et son contenu", async () => {
    const { annotations } = await service();
    annotations.add("revue", "src/a.ts", 3, "pourquoi 4 ?", { anchor: "const c = 4;" });
    annotations.add("revue", "src/a.ts", 2, "identifiant peu clair", { anchor: "const b = 3;" });
    const texte = annotations.format("revue", DIFF);
    expect(texte).toContain("## src/a.ts");
    expect(texte).toContain("src/a.ts:3 (new)");
    expect(texte).toContain("> const c = 4;");
    expect(texte).toContain("pourquoi 4 ?");
    expect(texte.indexOf(":2 (new)")).toBeLessThan(texte.indexOf(":3 (new)"));
    expect(annotations.format("vide")).toBe("");
  });
});
