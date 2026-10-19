/**
 * Renommage Herald -> Jarod (docs/RENAME-PLAN-JAROD-OS.md, phase 2) : les variables d'environnement s'appellent `JAROD_OS_*` ;
 * l'ancien nom `HERALD_OS_*`, posé par vos scripts, votre `.env` ou une unité, reste LU. Une seule fonction, appelée une fois au
 * démarrage du processus, avant toute lecture : elle recopie `HERALD_OS_X` vers `JAROD_OS_X` quand le nouveau nom est absent. Le
 * nouveau nom l'emporte toujours ; l'ancien n'est ni effacé ni modifié. Aucune VALEUR n'est lue autrement que pour être recopiée,
 * ni rendue, ni journalisée : seuls les NOMS adoptés sont rendus.
 *
 * Copie volontaire dans `jarod-core/packages/kernel/src/legacy-env.ts` (les deux mondes ne s'importent pas ; mêmes cas de test).
 */

const LEGACY = 'HERALD_OS_'
const CURRENT = 'JAROD_OS_'

/**
 * Noms qui ne sont jamais adoptés : `HERALD_OS_DEV_UNSIGNED` est le nom FIGÉ par le contrat c8 (contracts/v1, confiance des images) ;
 * il garde son nom, et aucun second nom ne doit pouvoir autoriser une image non signée.
 */
export const NEVER_ADOPTED: ReadonlySet<string> = new Set(['HERALD_OS_DEV_UNSIGNED'])

/** Recopie chaque `HERALD_OS_X` vers `JAROD_OS_X` absent ; rend les noms adoptés (jamais les valeurs). */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = []

  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY) || NEVER_ADOPTED.has(name)) {
      continue
    }

    const current = CURRENT + name.slice(LEGACY.length)
    const value = env[name]

    if (value === undefined || env[current] !== undefined) {
      continue
    }

    env[current] = value
    adopted.push(current)
  }

  return adopted.sort()
}
