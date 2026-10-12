// Le fichier `gateway.json` porte le jeton de la passerelle en clair : il ne doit être lisible que par son
// propriétaire. POSIX : `mode 0o600` + `chmodSync` (voir `writeSecretFile`). Windows : ni l'un ni l'autre ne
// restreint quoi que ce soit — le fichier hérite des droits du dossier, où tout compte du poste peut lire.
// On retire donc l'héritage et on n'accorde que le compte courant (`icacls`), et on efface le fichier à
// l'arrêt du serveur : un jeton ne survit pas à la passerelle qui l'a produit.
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";

export interface HardeningResult {
  /** Vrai si une restriction a été posée (Windows avec `icacls`). */
  applied: boolean;
  /** Compte à qui l'accès reste accordé. */
  user?: string;
  error?: string;
}

/**
 * Restreint la lecture d'un fichier de secret au compte courant. Sans effet (documenté) hors Windows, où
 * `0o600` suffit. Ne jette jamais : un fichier de jeton non restreint ne doit pas empêcher la passerelle de
 * servir ; l'appelant journalise `error`.
 */
export function hardenSecretFile(
  file: string,
  opts: { platform?: NodeJS.Platform; user?: string | undefined; run?: typeof spawnSync } = {},
): HardeningResult {
  const platform = opts.platform ?? process.platform;
  const user = opts.user ?? process.env.USERNAME;
  if (platform !== "win32") return { applied: false };

  if (!user) return { applied: false, error: "compte utilisateur inconnu (USERNAME absent)" };

  // `USERDOMAIN\utilisateur` quand on l'a : un compte local et un compte de domaine peuvent porter le même nom.
  const domain = process.env.USERDOMAIN;
  const account = domain ? `${domain}\\${user}` : user;
  const run = opts.run ?? spawnSync;
  // `/inheritance:r` retire les droits hérités, `/grant:r` remplace ceux du compte par un accès complet.
  const result = run("icacls", [file, "/inheritance:r", "/grant:r", `${account}:F`], { stdio: "ignore", windowsHide: true });

  if (result.error) return { applied: false, user: account, error: result.error.message };
  if (result.status !== 0) return { applied: false, user: account, error: `icacls a rendu le code ${result.status}` };
  return { applied: true, user: account };
}

/** Efface un fichier de secret s'il existe encore (arrêt de la passerelle) ; ne jette jamais. */
export function removeSecretFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Un fichier déjà absent est le cas normal ; un échec de suppression ne doit pas retenir l'arrêt.
  }
}

/**
 * Écrit un fichier de secret : contenu, droits du propriétaire (`0o600` là où ils existent, `icacls` sous
 * Windows). C'est le seul chemin d'écriture de `gateway.json` : les deux protections restent ainsi ensemble,
 * et la passerelle démarre même si la restriction échoue (le résultat le dit).
 */
export function writeSecretFile(
  file: string,
  contents: string,
  opts: { platform?: NodeJS.Platform; user?: string | undefined; run?: typeof spawnSync } = {},
): HardeningResult {
  writeFileSync(file, contents, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows : les droits POSIX n'y ont pas de sens (c'est `icacls` qui s'en charge).
  }
  return hardenSecretFile(file, opts);
}
