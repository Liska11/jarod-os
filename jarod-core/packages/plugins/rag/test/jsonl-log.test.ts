// SPECS-P5-RERANKER.md §3 : le rapport fantôme est un JSONL borné — une ligne par recherche, rotation à la taille maximale.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJsonl } from "../src/jsonl-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jl-"));
  dirs.push(d);
  return d;
};

describe("appendJsonl", () => {
  it("une ligne JSON par appel, dans l'ordre", () => {
    const f = join(tmp(), "log.jsonl");
    appendJsonl(f, { a: 1 }, 1_000);
    appendJsonl(f, { a: 2 }, 1_000);
    expect(readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("rotation : au-delà de la taille maximale, l'ancien fichier devient .1 (écrasé s'il existe) et un nouveau commence", () => {
    const f = join(tmp(), "log.jsonl");
    const big = { pad: "x".repeat(60) };
    for (let i = 0; i < 4; i++) appendJsonl(f, big, 200);
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(readFileSync(f, "utf8").length).toBeLessThanOrEqual(200 + 100);
    for (let i = 0; i < 20; i++) appendJsonl(f, big, 200); // plusieurs rotations : un seul .1, jamais .2
    expect(existsSync(`${f}.2`)).toBe(false);
  });

  it("n'échoue jamais : dossier inexistant → rien d'écrit, aucune exception", () => {
    expect(() => appendJsonl(join(tmp(), "absent", "log.jsonl"), { a: 1 }, 1_000)).not.toThrow();
  });
});
