/**
 * Q13-2 — vraie sauvegarde de profil complet (décision utilisateur 2026-09-28) : base chiffrée copiée de façon
 * cohérente (`Db.snapshotTo` : `VACUUM INTO`, MÊME clé, rouverte et vérifiée) + tous les fichiers du profil
 * (skills, SOUL.md, pièces jointes, méta, provenance…), manifeste avec SHA-256 et taille de chaque fichier, puis
 * relecture complète contre le manifeste. La clé de la base (`db.key.dpapi`, liée au compte Windows) n'est JAMAIS
 * copiée : la sauvegarde se restaure avec la clé du profil (même compte Windows), elle ne se lit pas ailleurs.
 * Destination choisie dans la boîte NATIVE du main (jamais un chemin du renderer), sous la garde Q12.
 * Remplace le zip de HERMES_HOME de SANK-UI (`run-hermes-backup`, `installer.ts`).
 */
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const BACKUP_FORMAT = "jarod-profile-backup";
export const BACKUP_VERSION = 1;
export const DB_FILE = "jarod.db";

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  appVersion: string;
  profile: string;
  database: { file: string; schemaVersion: number; encrypted: boolean; keyIncluded: false; note: string };
  files: { path: string; size: number; sha256: string }[];
  excluded: { path: string; reason: string }[];
  totals: { files: number; bytes: number };
}

/** Exclusions, avec leur raison (écrite au manifeste : une omission se voit). */
export function exclusionReason(rel: string, isDir: boolean): string | null {
  const posix = rel.split(sep).join("/");
  const name = posix.split("/").pop() ?? "";
  if (/^jarod\.db(-wal|-shm|-journal)?$/i.test(posix)) return "base vivante : remplacée par l'instantané vérifié";
  if (/\.(dpapi|key)$/i.test(name)) return "clé : jamais copiée (liée au compte Windows)";
  if (posix === "runtime.lock") return "verrou d'exécution";
  if (isDir && posix === "backups") return "copies d'avant migration (anciennes bases)";
  if (isDir && posix === "engine") return "moteur llama.cpp téléchargé (binaire réinstallable)";
  // Le dossier des modèles Hugging Face est choisi HORS du profil (SPECS-P5-MODELS.md § 4) ; par précaution, un modèle ou son `.part` qui s'y trouverait quand même n'est jamais copié.
  if (!isDir && /\.gguf(\.part)?$/i.test(name)) return "modèle GGUF (ou son .part) : jamais sauvegardé avec le profil, rechargeable depuis Hugging Face";
  return null;
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Dossier neuf `<parent>/jarod-sauvegarde-<profil>-<horodatage>` — jamais par-dessus une sauvegarde. */
function freeDir(parent: string, profile: string, now: Date): string {
  const base = join(parent, `jarod-sauvegarde-${profile}-${now.toISOString().replace(/[:.]/g, "-")}`);
  let candidate = base;
  for (let n = 2; existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

export interface BackupInput {
  profileDir: string;
  profile: string;
  appVersion: string;
  destParent: string;
  encrypted: boolean;
  /** Instantané cohérent et vérifié de la base vers ce fichier (`Db.snapshotTo`). */
  snapshot(target: string): { userVersion: number };
  now?: Date;
}

export function createProfileBackup(o: BackupInput): { dir: string; manifest: BackupManifest } {
  const now = o.now ?? new Date();
  const dir = freeDir(o.destParent, o.profile, now);
  mkdirSync(dir, { recursive: true });
  try {
    const files: BackupManifest["files"] = [];
    const excluded: BackupManifest["excluded"] = [];
    const { userVersion } = o.snapshot(join(dir, DB_FILE));
    files.push({ path: DB_FILE, size: statSync(join(dir, DB_FILE)).size, sha256: sha256File(join(dir, DB_FILE)) });

    const walk = (src: string) => {
      for (const e of readdirSync(src, { withFileTypes: true })) {
        const full = join(src, e.name);
        const rel = relative(o.profileDir, full);
        const reason = exclusionReason(rel, e.isDirectory());
        if (reason) {
          excluded.push({ path: rel.split(sep).join("/"), reason });
          continue;
        }
        if (e.isSymbolicLink()) {
          excluded.push({ path: rel.split(sep).join("/"), reason: "lien symbolique (cible hors profil non suivie)" });
          continue;
        }
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const target = join(dir, "profil", rel);
          mkdirSync(join(target, ".."), { recursive: true });
          copyFileSync(full, target);
          files.push({ path: `profil/${rel.split(sep).join("/")}`, size: statSync(target).size, sha256: sha256File(target) });
        }
      }
    };
    walk(o.profileDir);

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      appVersion: o.appVersion,
      profile: o.profile,
      database: {
        file: DB_FILE,
        schemaVersion: userVersion,
        encrypted: o.encrypted,
        keyIncluded: false,
        note: o.encrypted
          ? `Base chiffrée avec la clé du profil « ${o.profile} », NON incluse (liée au compte Windows) : se restaure dans un profil neuf de la machine d'origine, même compte Windows, tant que le profil « ${o.profile} » et sa clé y existent ; ailleurs, la base est illisible.`
          : "Base en clair (profil non chiffré).",
      },
      files,
      excluded,
      totals: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(dir, "manifest.json"), text);
    writeFileSync(join(dir, "manifest.json.sha256"), `${createHash("sha256").update(text).digest("hex")}  manifest.json\n`);
    const problems = verifyProfileBackup(dir);
    if (problems.length) throw new Error(`sauvegarde invalide à la relecture : ${problems.slice(0, 5).join(" ; ")}`);
    return { dir, manifest };
  } catch (e) {
    // Jamais de sauvegarde incomplète laissée pour une sauvegarde valable.
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Relecture : empreinte du manifeste, puis chaque fichier (présent, même taille, même SHA-256), rien en plus. */
export function verifyProfileBackup(dir: string): string[] {
  const problems: string[] = [];
  const text = readFileSync(join(dir, "manifest.json"), "utf8");
  const sumFile = join(dir, "manifest.json.sha256");
  if (!existsSync(sumFile)) return ["manifest.json.sha256 absent"];
  const expected = readFileSync(sumFile, "utf8").split(/\s+/)[0];
  if (createHash("sha256").update(text).digest("hex") !== expected) problems.push("manifest.json modifié");
  const manifest = JSON.parse(text) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) problems.push(`format inconnu : ${String(manifest.format)}`);
  if (!Array.isArray(manifest.files)) return [...problems, "liste des fichiers absente"];
  const listed = new Set<string>();
  for (const f of manifest.files) {
    listed.add(f.path);
    const p = join(dir, ...f.path.split("/"));
    if (!existsSync(p)) problems.push(`absent : ${f.path}`);
    else if (statSync(p).size !== f.size) problems.push(`taille : ${f.path}`);
    else if (sha256File(p) !== f.sha256) problems.push(`empreinte : ${f.path}`);
  }
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (e.isDirectory()) walk(full);
      else if (rel !== "manifest.json" && rel !== "manifest.json.sha256" && !listed.has(rel)) problems.push(`non listé : ${rel}`);
    }
  };
  walk(dir);
  return problems;
}
