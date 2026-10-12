/**
 * B3 — garde du dépôt : le jeton Telegram vit dans le coffre chiffré du profil (`gateway:telegram:token`), nulle part
 * ailleurs. (1) Aucun fichier suivi ou à suivre (non ignoré) ne contient une chaîne de la forme d'un jeton de bot réel
 * (`<id 8-10 chiffres>:<35 car.>`) ; les jetons de test sont manifestement fictifs (`000000:jarod-…`). (2) Aucun code
 * (packages/, tests/, scripts/) ne lit plus `backup-hermes/.env` — sauvegarde Hermes locale, hors périmètre.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = ":(exclude)tests/repo/b3-telegram-token.test.ts";

/** `git grep` (lecture seule) : lignes trouvées, [] si rien (code 1). */
function grep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", "-n", "-I", "--untracked", ...args, SELF], { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

describe("B3 — jeton Telegram : coffre du profil seulement", () => {
  it("aucun jeton de bot réel dans les fichiers suivis ou à suivre", () => {
    // Ne rapporte que l'emplacement, jamais la valeur.
    expect(grep(["-l", "-E", "[0-9]{8,10}:[A-Za-z0-9_-]{35}"])).toEqual([]);
  });

  it("aucune lecture de backup-hermes/.env dans le code, les scripts et les tests", () => {
    const code = ["--", "packages/*.ts", "packages/*.tsx", "packages/*.mjs", "packages/*.cjs", "tests/*.ts", "scripts/*"];
    expect(grep(["-E", "backup-hermes[\"'`]?[[:space:]]*[,/\\\\][[:space:]]*[\"'`]?\\.env", ...code])).toEqual([]);
  });
});
