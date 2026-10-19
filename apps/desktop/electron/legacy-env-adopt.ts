// Premier import de main.ts (voir shared/legacy-env.ts) : les anciens noms de variables sont adoptés AVANT que le moindre module
// ne lise process.env au chargement. Rend les noms adoptés, pour le journal ; jamais une valeur.
import { adoptLegacyEnv } from '../shared/legacy-env.ts'

export const ADOPTED_LEGACY_ENV: readonly string[] = adoptLegacyEnv()
