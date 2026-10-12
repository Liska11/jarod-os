// Chantier 2 de SPECS-P5-MODELS.md (§ 3.9 (b), § 5, § 6 cas (8)) : validation des noms de dépôt et de fichier. Barres (2-A), (2-B), (2-E) figées dans DECISIONS
// (2026-10-03) avant ce code. Fonctions pures + confinement du chemin : aucune requête ici (les barres (2-C) et (2-D) sont dans huggingface-names.test.ts).
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HfNameError,
  assertInside,
  encodeRepoPath,
  ensureDirUnder,
  fileNameProblem,
  repoIdProblem,
  resolveUnder,
  validateFileName,
  validateRepoId,
} from "../src/hf-names.js";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { TRAPPED_FILES, TRAPPED_REPOS, VALID_FILES, VALID_REPOS } from "./hf-name-cases.js";

afterEach(async () => {
  await cleanup();
});

const temp = () => tempDir();

describe("(2-A) noms de dépôt", () => {
  it("accepte les identifiants valides, tels quels", () => {
    expect(VALID_REPOS.length).toBeGreaterThanOrEqual(5);
    for (const repo of VALID_REPOS) {
      expect(repoIdProblem(repo), repo).toBeNull();
      expect(validateRepoId(repo)).toBe(repo);
    }
  });

  it("refuse chaque identifiant piégé, avec un code et une raison", () => {
    expect(TRAPPED_REPOS.length).toBeGreaterThanOrEqual(20);
    for (const [why, repo] of TRAPPED_REPOS) {
      expect(repoIdProblem(repo), why).toBeTypeOf("string");
      try {
        validateRepoId(repo);
        throw new Error(`accepté : ${why}`);
      } catch (error) {
        expect(error, why).toBeInstanceOf(HfNameError);
        expect((error as HfNameError).code, why).toBe("INVALID_REPO");
      }
    }
  });

  it("l'encodage de l'adresse est segment par segment", () => {
    expect(encodeRepoPath("acme/tiny-GGUF")).toBe("acme/tiny-GGUF");
  });
});

describe("(2-B) noms de fichier", () => {
  it("accepte les noms valides, sous-dossiers, fragments et .GGUF compris", () => {
    expect(VALID_FILES.length).toBeGreaterThanOrEqual(5);
    for (const file of VALID_FILES) {
      expect(fileNameProblem(file), file).toBeNull();
      expect(validateFileName(file).path).toBe(file);
    }
  });

  it("refuse chaque nom piégé", () => {
    expect(TRAPPED_FILES.length).toBeGreaterThanOrEqual(25);
    for (const [why, file] of TRAPPED_FILES) {
      expect(fileNameProblem(file), why).not.toBeNull();
      expect(() => validateFileName(file), why).toThrow(HfNameError);
    }
  });

  it("le suffixe : UNSUPPORTED_FILE (comme avant) ; tout le reste : INVALID_FILE", () => {
    const code = (f: unknown) => {
      try {
        validateFileName(f);
        return "ok";
      } catch (e) {
        return (e as HfNameError).code;
      }
    };
    expect(code("poids.safetensors")).toBe("UNSUPPORTED_FILE");
    expect(code("x.gguf.exe")).toBe("UNSUPPORTED_FILE");
    expect(code("../x.gguf")).toBe("INVALID_FILE");
    expect(code("CON.gguf")).toBe("INVALID_FILE");
    expect(code(null)).toBe("INVALID_FILE");
  });

  it("rend les segments, sans les recomposer autrement que par /", () => {
    expect(validateFileName("a/b/c.gguf").segments).toEqual(["a", "b", "c.gguf"]);
  });
});

describe("(2-E) confinement du chemin", () => {
  it("assertInside refuse tout chemin qui sort de la racine, ou qui la désigne", () => {
    const root = resolve(temp());
    expect(() => assertInside(root, join(root, "a", "x.gguf"))).not.toThrow();
    expect(() => assertInside(root, resolve(root, "..", "x.gguf"))).toThrow(/PATH_ESCAPES/);
    expect(() => assertInside(root, resolve(root, "a", "..", "..", "x.gguf"))).toThrow(/PATH_ESCAPES/);
    expect(() => assertInside(root, root)).toThrow(/PATH_ESCAPES/);
    expect(() => assertInside(root, `${root}-voisin${"/"}x.gguf`)).toThrow(/PATH_ESCAPES/);
  });

  it("resolveUnder valide le nom PUIS vérifie le chemin résolu", () => {
    const root = temp();
    expect(resolveUnder(root, "sub/m.gguf")).toBe(join(resolve(root), "sub", "m.gguf"));
    expect(() => resolveUnder(root, "../m.gguf")).toThrow(HfNameError);
  });

  it("un lien (jonction) placé dans la destination qui mène dehors est refusé AVANT de créer quoi que ce soit", () => {
    const root = temp();
    const outside = temp();
    symlinkSync(outside, join(root, "lien"), "junction");
    const target = resolveUnder(root, "lien/neuf/m.gguf");
    expect(() => ensureDirUnder(root, target)).toThrow(/PATH_ESCAPES/);
    expect(existsSync(join(outside, "neuf"))).toBe(false);
  });

  it("un sous-dossier ordinaire est créé sous la racine", () => {
    const root = temp();
    mkdirSync(join(root, "deja"));
    const target = resolveUnder(root, "deja/neuf/m.gguf");
    ensureDirUnder(root, target);
    expect(existsSync(join(root, "deja", "neuf"))).toBe(true);
  });
});
