/**
 * V-06 — la clé LOCALE du profil : ce qui permet à la personne d'approuver un plugin qu'aucun éditeur de confiance n'a signé (le sien, ou un
 * plugin reçu), sans affaiblir la règle « rien ne tourne sans manifeste signé ». Approuver = signer, avec cette clé, le manifeste qui fixe le
 * nom, la version, les permissions et l'EMPREINTE du contenu ; un octet changé invalide l'approbation.
 *
 * La paire Ed25519 vit dans la base du profil (chiffrée quand le profil l'est), jamais dans un fichier que l'agent ou un plugin pourrait réécrire :
 * l'état de la plateforme (`plugin-platform.json`) peut être modifié par un processus de la machine, mais il ne peut pas y forger une signature.
 * Les anciennes clés publiques restent de confiance (un profil restauré ou une clé renouvelée ne rend pas les approbations passées invalides) ;
 * seule la plus récente signe.
 */
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { type PluginManifest, signManifest } from "./manifest.js";

/** Ce que la clé locale lit de la base (plugin-storage `Db`, vu par sa forme). */
export interface KeyDb {
  exec(sql: string): void;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
  run(sql: string, ...params: (string | number | null)[]): { changes: number };
}

export interface LocalKeys {
  /** L'identifiant de la clé qui signe maintenant (`local-<n>`). */
  keyId: string;
  /** Toutes les clés publiques locales (identifiant → PEM), anciennes comprises. */
  publicKeys: Record<string, string>;
  sign(manifest: PluginManifest): PluginManifest;
}

export function localKeys(db: KeyDb, now: () => number = Date.now): LocalKeys {
  db.exec("CREATE TABLE IF NOT EXISTS platform_keys (key_id TEXT PRIMARY KEY, public_pem TEXT NOT NULL, private_pem TEXT NOT NULL, created_at INTEGER NOT NULL)");
  let rows = db.all<{ key_id: string; public_pem: string; private_pem: string }>("SELECT key_id, public_pem, private_pem FROM platform_keys ORDER BY created_at, key_id");
  if (rows.length === 0) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    db.run(
      "INSERT INTO platform_keys (key_id, public_pem, private_pem, created_at) VALUES (?, ?, ?, ?)",
      "local-1",
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      now(),
    );
    rows = db.all("SELECT key_id, public_pem, private_pem FROM platform_keys ORDER BY created_at, key_id");
  }
  const current = rows.at(-1)!;
  return {
    keyId: current.key_id,
    publicKeys: Object.fromEntries(rows.map((r) => [r.key_id, r.public_pem])),
    // La clé privée n'est désérialisée qu'au moment de signer, et ne sort jamais de cet appel.
    sign: (manifest) => signManifest(manifest, current.key_id, createPrivateKey(current.private_pem)),
  };
}
