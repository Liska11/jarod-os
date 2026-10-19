// À importer EN PREMIER par chaque point d'entrée d'un processus du noyau (CLI, passerelle, bundle) : les imports ESM sont évalués
// dans l'ordre, donc les anciens noms de variables sont adoptés avant qu'un plugin ne lise process.env au chargement.
import { adoptLegacyEnv } from "./legacy-env.js";

/** Les noms adoptés à ce démarrage (jamais une valeur), pour qui veut les journaliser. */
export const ADOPTED_LEGACY_ENV: readonly string[] = adoptLegacyEnv();
