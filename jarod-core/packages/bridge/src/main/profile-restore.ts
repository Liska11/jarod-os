/**
 * Q14 — restauration d'une sauvegarde complète (`profile-backup.ts`) dans un profil NEUF (décision utilisateur
 * 2026-09-28) : jamais par-dessus le profil servi ni un profil existant. Étapes, toutes avant que le profil
 * n'apparaisse dans la liste :
 * 1. relecture de la sauvegarde contre son manifeste (`verifyProfileBackup`) ;
 * 2. clé : celle du profil d'ORIGINE de cette machine (même compte Windows) — la sauvegarde ne la contient pas ;
 *    absente = refus, rien n'est créé. La MÊME clé est reprise (et non une clé neuve) : les pièces jointes sont
 *    chiffrées par une clé dérivée de celle de la base ;
 * 3. copie dans un dossier de travail HORS de `profiles/` (invisible de la liste), chaque fichier recontrôlé
 *    contre le manifeste (taille + SHA-256), base rouverte avec la clé (`quick_check`, même version de schéma) ;
 * 4. renommage en `profiles/<origine>-restaure[-n]`, puis adoption de la clé par ce dossier ; tout échec
 *    supprime ce qui a été créé.
 * Les fichiers restaurés sont identiques octet pour octet à ceux du manifeste (y compris `profile-meta.json` :
 * le nom affiché reste celui de l'origine ; l'id du profil, lui, est neuf).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupManifest, DB_FILE, exclusionReason, sha256File, verifyProfileBackup } from "./profile-backup.js";

/** Accès aux clés et au contrôle de base du kernel servi (plugin-storage), jamais transmis au renderer. */
export interface RestoreKeys {
  findKey(dataDir: string): string | null;
  adoptKey(dataDir: string, key: string): string;
  checkDatabaseFile(path: string, key: string | null): { userVersion: number };
}

export interface RestoreInput {
  /** Dossier de la sauvegarde (celui de `manifest.json`). */
  backupDir: string;
  dataRoot: string;
  /** Profil servi : jamais une cible. */
  activeProfile: string;
  keys: RestoreKeys;
  now?: Date;
}

export interface RestoreResult {
  profile: string;
  dir: string;
  manifest: BackupManifest;
  /** Magasin de la clé adoptée (null : profil en clair). */
  keyStore: string | null;
}

export class RestoreRefused extends Error {}

/** Lit et contrôle le manifeste d'une sauvegarde complète (relecture intégrale comprise). */
export function readBackupManifest(backupDir: string): BackupManifest {
  const problems = verifyProfileBackup(backupDir);
  if (problems.length) throw new RestoreRefused(`sauvegarde invalide : ${problems.slice(0, 5).join(" ; ")}`);
  const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new RestoreRefused(`format de sauvegarde non pris en charge : ${String(manifest.format)} v${String(manifest.version)}`);
  }
  return manifest;
}

/** `<origine>-restaure`, puis `-2`, `-3`… : un nom libre, jamais un profil existant. */
export function restoredProfileName(profiles: ProfileManager, origin: string): string {
  const existing = new Set(profiles.list());
  const base = `${origin}-restaure`;
  let name = base;
  for (let n = 2; existing.has(name) || existsSync(profiles.dirFor(name)); n++) name = `${base}-${n}`;
  return name;
}

/** Chemin, dans un profil, d'un fichier du manifeste (`jarod.db` ou `profil/<rel>`). */
function targetOf(root: string, path: string): string {
  if (path === DB_FILE) return join(root, DB_FILE);
  if (!path.startsWith("profil/")) throw new RestoreRefused(`entrée de manifeste inattendue : ${path}`);
  const rel = path.slice("profil/".length).split("/");
  if (rel.some((s) => s === "" || s === "." || s === "..")) throw new RestoreRefused(`chemin refusé : ${path}`);
  // Ce qu'une sauvegarde n'emporte jamais (clé, base vivante, verrou…) n'est pas davantage restauré.
  for (let i = 1; i <= rel.length; i++) {
    const reason = exclusionReason(join(...rel.slice(0, i)), i < rel.length);
    if (reason) throw new RestoreRefused(`entrée refusée (${reason}) : ${path}`);
  }
  return join(root, ...rel);
}

export function restoreProfileBackup(o: RestoreInput): RestoreResult {
  const manifest = readBackupManifest(o.backupDir);
  const profiles = new ProfileManager(o.dataRoot);
  const origin = manifest.profile;

  // Clé : celle du profil d'origine sur CETTE machine (même compte Windows) — sinon refus, avant toute écriture.
  let key: string | null = null;
  if (manifest.database.encrypted) {
    const originDir = profiles.list().includes(origin) ? profiles.dirFor(origin) : null;
    key = originDir ? o.keys.findKey(originDir) : null;
    if (!key) {
      throw new RestoreRefused(
        `clé du profil « ${origin} » introuvable sur cette machine pour ce compte Windows : la base sauvegardée ne s'ouvre qu'avec elle (la clé n'est jamais dans la sauvegarde).`,
      );
    }
  }

  const name = restoredProfileName(profiles, origin);
  if (name === o.activeProfile) throw new RestoreRefused("le profil servi n'est jamais une cible de restauration");
  const target = profiles.dirFor(name);
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const work = join(o.dataRoot, `restauration-${name}-${stamp}`);
  mkdirSync(work, { recursive: true });
  let moved = false;
  try {
    for (const f of manifest.files) {
      const from = join(o.backupDir, ...f.path.split("/"));
      const to = targetOf(work, f.path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      if (statSync(to).size !== f.size || sha256File(to) !== f.sha256) throw new RestoreRefused(`copie non conforme au manifeste : ${f.path}`);
    }
    const { userVersion } = o.keys.checkDatabaseFile(join(work, DB_FILE), key);
    if (userVersion !== manifest.database.schemaVersion) {
      throw new RestoreRefused(`version de schéma ${userVersion} ≠ ${manifest.database.schemaVersion} (manifeste)`);
    }
    if (existsSync(target)) throw new RestoreRefused(`le profil « ${name} » existe déjà`);
    renameSync(work, target);
    moved = true;
    const keyStore = key ? o.keys.adoptKey(target, key) : null;
    if (key && o.keys.findKey(target) !== key) throw new RestoreRefused("clé du profil restauré non relue");
    return { profile: name, dir: target, manifest, keyStore };
  } catch (e) {
    rmSync(moved ? target : work, { recursive: true, force: true });
    throw e;
  }
}
