// Mode maintenance du gateway, lancé par le shell PENDANT que le moteur est arrêté (sauvegarde externe, docs/BACKUP-EXTERNE.md) :
//
//   gateway.mjs --db-snapshot <base source> <copie>
//
// copie cohérente de la base, même clé, sans les valeurs de la table `secrets` (voir `snapshotWithoutSecrets`). La clé est lue dans le
// magasin du dossier de la source (DPAPI sous Windows) ; elle n'est jamais créée ici, jamais écrite ni affichée. Sortie : une ligne JSON
// sur stdout (`{"ok":true,"removed":n}` ou `{"ok":false,"error":"…"}`), code 0 ou 1. Rien d'autre ne démarre (ni cœur, ni réseau).
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { defaultKeyStores, isEncryptedDb, resolveDbKey, snapshotWithoutSecrets } from "@jarod/plugin-storage";

export function maintenanceRequested(argv: readonly string[]): boolean {
  return argv.includes("--db-snapshot");
}

export function runMaintenance(argv: readonly string[]): number {
  const at = argv.indexOf("--db-snapshot");
  const src = argv[at + 1];
  const dest = argv[at + 2];
  const answer = (value: object): void => void process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (!src || !dest || !isAbsolute(src) || !isAbsolute(dest)) throw new Error("chemins absolus attendus : --db-snapshot <source> <copie>");
    if (!existsSync(src)) throw new Error("base source introuvable");
    // Une base en clair n'a pas de clé : n'en jamais créer une ici (resolveDbKey le ferait pour une base non chiffrée).
    const key = isEncryptedDb(src) ? resolveDbKey(dirname(src), defaultKeyStores(), true).key : null;
    const { removed } = snapshotWithoutSecrets(src, dest, key);
    answer({ ok: true, removed });
    return 0;
  } catch (e) {
    answer({ ok: false, error: (e as Error).message.split("\n")[0]?.slice(0, 300) ?? "échec" });
    return 1;
  }
}
