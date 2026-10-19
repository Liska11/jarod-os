/**
 * Renommage Herald -> Jarod (docs/RENAME-PLAN-JAROD-OS.md, phase 2) : les variables d'environnement s'appellent `JAROD_OS_*` ;
 * l'ancien nom `HERALD_OS_*` reste LU. Appelée une fois au démarrage d'un processus du noyau (CLI, passerelle), avant toute lecture :
 * recopie `HERALD_OS_X` vers `JAROD_OS_X` quand le nouveau nom est absent. Le nouveau nom l'emporte ; l'ancien n'est ni effacé ni
 * modifié. Ne rend que des NOMS, jamais une valeur.
 *
 * Copie volontaire de `apps/desktop/shared/legacy-env.ts` (le shell et le noyau ne s'importent pas ; mêmes cas de test).
 */

const LEGACY = "HERALD_OS_";
const CURRENT = "JAROD_OS_";

/** `HERALD_OS_DEV_UNSIGNED` est figé par le contrat c8 (confiance des images) : jamais de second nom. */
export const NEVER_ADOPTED: ReadonlySet<string> = new Set(["HERALD_OS_DEV_UNSIGNED"]);

export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY) || NEVER_ADOPTED.has(name)) continue;
    const current = CURRENT + name.slice(LEGACY.length);
    const value = env[name];
    if (value === undefined || env[current] !== undefined) continue;
    env[current] = value;
    adopted.push(current);
  }
  return adopted.sort();
}
