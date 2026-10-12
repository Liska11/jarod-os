// Portage de packages/core/test/spill.test.ts (rév. 2e180305).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { transcript } from "../src/agent.js";
import { SpillService } from "../src/spill.js";

afterEach(cleanup); // T16 : le dossier de travail est supprimé en fin de test

function setup(threshold = 100) {
  const root = tempDir();
  return { root, spill: new SpillService({ root, threshold }) };
}

describe("déplacer au lieu de jeter", () => {
  it("une sortie courte passe telle quelle, sans écrire de fichier", () => {
    const { spill, root } = setup();
    const kept = spill.keep("s1", "resultat", "court");
    expect(kept.preview).toBe("court");
    expect(kept.locator).toBeNull();
    expect(existsSync(join(root, ".jarod"))).toBe(false);
  });

  it("une sortie longue est écrite en entier, et l'aperçu dit où", () => {
    const { spill } = setup(100);
    const text = "A".repeat(500);
    const kept = spill.keep("s1", "resultat", text);
    expect(kept.locator).toBeTruthy();
    expect(kept.preview).toContain(kept.locator as string);
    expect(kept.preview).toContain("500 caractères au total");
    const name = (kept.locator as string).split("/").pop() as string;
    expect(spill.read("s1", name)).toBe(text);
  });

  it("le repère est relatif au dossier de travail, donc lisible tel quel par l'outil de lecture", () => {
    const { spill, root } = setup(100);
    const kept = spill.keep("s1", "resultat", "B".repeat(300));
    expect(kept.locator?.startsWith(".jarod/spill/s1/")).toBe(true);
    expect(readFileSync(join(root, kept.locator as string), "utf8")).toHaveLength(300);
  });

  it("deux sorties du même nom ne s'écrasent pas", () => {
    const { spill } = setup(10);
    spill.keep("s1", "resultat", "x".repeat(50));
    spill.keep("s1", "resultat", "y".repeat(60));
    expect(spill.list("s1")).toHaveLength(2);
  });

  it("un nom hostile ne sort pas du dossier", () => {
    const { spill, root } = setup(10);
    spill.keep("../../etc", "../../secret", "z".repeat(50));
    expect(existsSync(join(root, "..", "secret"))).toBe(false);
    expect(spill.list("../../etc")).toHaveLength(1);
    expect(spill.read("../../etc", "../../secret")).toBeUndefined();
  });

  it("le repli garde l'ancien comportement quand il n'y a pas de dossier", () => {
    expect(SpillService.fallback("c".repeat(50), 10)).toMatch(/tronqué, 40 caractères de plus/);
  });

  it("dans la compaction, la sortie longue est déplacée — le résumé ne perd plus ce que le modèle n'a pas vu", () => {
    const { spill } = setup(100);
    const messages = [
      {
        id: "1",
        sessionId: "s1",
        role: "tool" as const,
        content: "R".repeat(4000),
        toolName: "run_shell",
        createdAt: 0,
      },
    ] as never;

    const rendered = transcript(messages, 200_000, (text) => spill.preview("s1", "run_shell", text));

    // Le transcript porte un repère relisible, au lieu du seul aveu de la troncature.
    expect(rendered).toMatch(/\.jarod\/spill\/s1\//);
    expect(rendered).toMatch(/4000 caractères au total/);
    // Et la donnée existe : c'est tout ce qui distingue conserver d'enterrer.
    expect(spill.list("s1")).toHaveLength(1);
  });

  it("sans keep, la troncature d'avant reste le comportement par défaut", () => {
    const messages = [
      {
        id: "1",
        sessionId: "s1",
        role: "tool" as const,
        content: "T".repeat(9000),
        toolName: "run_shell",
        createdAt: 0,
      },
    ] as never;
    expect(transcript(messages)).toMatch(/tronqué, 3000 caractères de plus/);
  });
});
