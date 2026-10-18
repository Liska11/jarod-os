/**
 * Le dossier des modèles Hugging Face (SPECS-P5-MODELS.md § 4 et § 3.10 (h)) : choisi UNE FOIS dans la boîte native, jamais un chemin du renderer. Règle : il n'est
 * JAMAIS sous le dossier de données du profil ni sous la racine des données (`dataRoot`) — ni égal à l'un d'eux — que ce soit par le chemin CHOISI ou par le chemin RÉEL
 * (liens symboliques et jonctions résolus). Un dossier sous le profil se retrouverait dans les sauvegardes (Q13-2) et dans le dossier que Jarod possède.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type ModelsDirCheck = { ok: true; dir: string } | { ok: false; reason: string };

const MAX_PATH = 1024;
// Windows : le système de fichiers ne distingue pas la casse ; ailleurs la comparaison reste exacte.
const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/** `child` est-il égal à `root` ou dedans ? Comparaison par segments : `donnees-2` n'est pas sous `donnees`. */
function isInside(child: string, root: string): boolean {
  const c = norm(child);
  const r = norm(root);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

function realOrResolved(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export function validateModelsDir(dir: unknown, o: { dataRoot: string; profileDir: string }): ModelsDirCheck {
  const refuse = (reason: string): ModelsDirCheck => ({ ok: false, reason });
  if (typeof dir !== "string" || dir.trim() === "") return refuse("aucun dossier indiqué");
  if (dir.length > MAX_PATH) return refuse(`chemin de plus de ${MAX_PATH} caractères`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, rejects input that contains control characters
  if (/[\u0000-\u001f]/.test(dir)) return refuse("caractère de contrôle dans le chemin");
  if (!isAbsolute(dir)) return refuse("chemin absolu attendu");
  let real: string;
  try {
    real = realpathSync.native(dir);
    if (!statSync(real).isDirectory()) return refuse("ce n'est pas un dossier");
  } catch {
    return refuse("dossier introuvable");
  }
  const chosen = resolve(dir);
  for (const [label, root] of [
    ["le dossier de données du profil", o.profileDir],
    ["la racine des données de Jarod", o.dataRoot],
  ] as const) {
    if (isInside(chosen, resolve(root)) || isInside(real, realOrResolved(root))) {
      return refuse(`le dossier des modèles ne peut pas être dans ${label} (il serait sauvegardé avec le profil) : choisissez un dossier ailleurs`);
    }
  }
  return { ok: true, dir: real };
}
