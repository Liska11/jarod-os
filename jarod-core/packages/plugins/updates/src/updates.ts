// Portage de packages/core/src/services/updates.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** A newer installer found in the local update folder. */
export interface UpdateInfo {
  version: string;
  /** Absolute path of the installer. */
  installer: string;
  /** When it was built (ms since epoch). */
  builtAt: number;
  /** sha512 (base64) annoncé par le manifeste du dossier : vérifié sur la COPIE avant tout lancement (AV2-003). */
  sha512: string;
  /** Taille annoncée par le manifeste, égale à celle du fichier. */
  size: number;
}

/** A release channel. `stable` accepts plain versions only; `beta` also accepts pre-releases. */
export type Channel = "stable" | "beta";

/** True for a version carrying a pre-release tag, which is what makes a build a beta. */
export function isPrerelease(version: string): boolean {
  return /-[0-9A-Za-z]/.test(version.replace(/^v/i, ""));
}

/**
 * The channel an installation follows. An explicit setting wins; otherwise it is read from the
 * running version, so a build tagged `-beta` follows betas with nobody having to configure it — and
 * a stable build never receives one by accident.
 */
export function resolveChannel(configured: string | undefined, version: string): Channel {
  if (configured === "stable" || configured === "beta") return configured;
  return isPrerelease(version) ? "beta" : "stable";
}

/** Does `channel` accept that version? The whole point of the channel: a stable user skips betas. */
export function acceptsVersion(channel: Channel, version: string): boolean {
  return channel === "beta" || !isPrerelease(version);
}

/** Compares dotted versions with optional pre-release tags (1.2.0-beta.1 < 1.2.0). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

// electron-builder names: "Jarod-One-1.2.3-setup.exe" (`artifactName` du paquet), "Jarod-One-Setup-1.2.3.exe" or
// "Jarod-One Setup 1.2.3.exe" (older builds). Le nom du paquet courant n'était pas reconnu : le dossier local ne le voyait jamais.
const INSTALLER_RE = /^Jarod-One(?:[- ]Setup[- ](\d+\.\d+\.\d+(?:-[\w.]+)?)|-(\d+\.\d+\.\d+(?:-[\w.]+)?)-setup)\.exe$/i;

/** Ce que le manifeste du dossier dit d'un installeur. */
export interface ManifestEntry {
  sha512: string;
  size: number;
}

/** Manifestes lus dans le dossier : `latest.yml` (stable) et `beta.yml`, format d'electron-updater. */
const MANIFESTS = ["latest.yml", "beta.yml"];

/**
 * Lit `files:` d'un manifeste electron-updater (`- url: … / sha512: … / size: …`). Lecteur volontairement MINIMAL et strict :
 * il ne comprend que ce que `writeChannelManifest` et electron-builder écrivent ; tout le reste est ignoré, jamais deviné.
 */
export function parseManifest(text: string): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>();
  let inFiles = false;
  let cur: { url?: string; sha512?: string; size?: number } | null = null;
  const flush = () => {
    if (cur?.url && cur.sha512 && cur.size !== undefined) out.set(cur.url, { sha512: cur.sha512, size: cur.size });
    cur = null;
  };
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");
  for (const line of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    if (/^\S/.test(line)) {
      flush();
      inFiles = false; // une clé de premier niveau ferme la liste
      continue;
    }
    const item = /^\s*-\s+url:\s*(.+)$/.exec(line);
    if (item) {
      flush();
      let url = unquote(item[1]!);
      try {
        url = decodeURIComponent(url);
      } catch {
        /* nom laissé tel quel */
      }
      cur = { url };
      continue;
    }
    const sha = /^\s+sha512:\s*(.+)$/.exec(line);
    if (sha && cur) cur.sha512 = unquote(sha[1]!);
    const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (size && cur) cur.size = Number(size[1]);
  }
  flush();
  return out;
}

/** Toutes les entrées des manifestes du dossier, par nom de fichier. Un manifeste illisible est ignoré (aucune confiance). */
function readManifests(folder: string): Map<string, ManifestEntry> {
  const all = new Map<string, ManifestEntry>();
  for (const name of MANIFESTS) {
    const file = join(folder, name);
    if (!existsSync(file)) continue;
    try {
      for (const [k, v] of parseManifest(readFileSync(file, "utf8"))) all.set(k, v);
    } catch {
      /* illisible : rien ne s'y fie */
    }
  }
  return all;
}

/**
 * Un `.blockmap` n'est PLUS une simple présence de fichier (un fichier vide suffisait, AV2-003) : c'est le format
 * d'electron-builder — JSON compressé en gzip — dont les blocs couvrent EXACTEMENT les octets de l'installeur.
 */
export function isValidBlockmap(file: string, installerSize: number): boolean {
  try {
    const map = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as {
      version?: unknown;
      files?: { sizes?: unknown; checksums?: unknown }[];
    };
    if (map.version !== "1" && map.version !== "2") return false;
    const f = map.files?.[0];
    if (!f || !Array.isArray(f.sizes) || !Array.isArray(f.checksums)) return false;
    if (f.sizes.length === 0 || f.sizes.length !== f.checksums.length) return false;
    let total = 0;
    for (const n of f.sizes) {
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return false;
      total += n;
    }
    return total === installerSize;
  } catch {
    return false; // absent, pas du gzip, pas du JSON : refusé
  }
}

/** sha512 (base64, comme electron-updater) d'un fichier, lu en flux. */
export function sha512File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("base64")));
  });
}

/**
 * À appeler sur la COPIE qu'on s'apprête à lancer, jamais sur la source (le fichier a pu changer entre-temps).
 * Écart de taille ou de sha512 = erreur : l'installeur n'est PAS exécuté.
 */
export async function verifyInstaller(file: string, expected: ManifestEntry): Promise<void> {
  const size = statSync(file).size;
  if (size !== expected.size) throw new Error(`Installeur refusé : taille ${size} ≠ ${expected.size} annoncée par le manifeste.`);
  const sha = await sha512File(file);
  if (sha !== expected.sha512) throw new Error("Installeur refusé : sha512 différent de celui du manifeste (fichier modifié ou corrompu).");
}

/**
 * Écrit le manifeste du canal (`latest.yml`, ou `beta.yml` pour une préversion) à côté d'un installeur : même format
 * qu'electron-updater, donc utilisable tel quel par un futur flux https. Les installeurs déjà listés restent (un dossier
 * peut en garder plusieurs) ; celui-ci est ajouté ou remplacé et devient `path`. Rend le chemin écrit.
 */
export async function writeChannelManifest(installer: string, version: string): Promise<string> {
  const sha512 = await sha512File(installer);
  const name = basename(installer);
  const manifest = join(dirname(installer), isPrerelease(version) ? "beta.yml" : "latest.yml");
  const entries = existsSync(manifest) ? parseManifest(readFileSync(manifest, "utf8")) : new Map<string, ManifestEntry>();
  entries.set(name, { sha512, size: statSync(installer).size });
  const files = [...entries].map(([url, e]) => `  - url: ${url}
    sha512: ${e.sha512}
    size: ${e.size}
`).join("");
  writeFileSync(manifest, `version: ${version}
files:
${files}path: ${name}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`);
  return manifest;
}

/**
 * Canal de REPLI LOCAL (AV2-003, décision du 2026-10-05) : `dist/latest.yml` appartient à electron-builder (bloc `publish`, flux distant) et
 * n'est JAMAIS réécrit ici. Le dossier à désigner dans « Mises à jour » est `outDir` : l'installeur et son `.blockmap` (lien dur, copie si le
 * volume l'interdit) et un manifeste écrit par `writeChannelManifest`. Rend le chemin du manifeste. Format : docs/MISE-A-JOUR-LOCALE.md.
 */
export async function stageLocalFeed(installer: string, version: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const stage = (src: string): string => {
    const dest = join(outDir, basename(src));
    rmSync(dest, { force: true });
    try {
      linkSync(src, dest);
    } catch {
      copyFileSync(src, dest);
    }
    return dest;
  };
  const staged = stage(installer);
  if (existsSync(`${installer}.blockmap`)) stage(`${installer}.blockmap`);
  return writeChannelManifest(staged, version);
}

/**
 * Looks for an installer newer than the running version in a local folder (the output of
 * `pnpm dist`). An installer only counts once it is trusted enough to be OFFERED (AV2-003): a real
 * `.blockmap` (electron-builder writes it last, so a build in progress is never picked up) AND an entry
 * in the folder's manifest (`latest.yml` / `beta.yml`) whose size is the file's. The sha512 itself is
 * checked later, on the copy about to be run (`verifyInstaller`), not here on every periodic check.
 * This is integrity, not authenticity: whoever can write the folder can write the manifest. Authenticode
 * (AV2-003b) is what will prove who built it.
 */
export function findLocalUpdate(
  currentVersion: string,
  folder: string,
  channel: Channel = "stable",
): UpdateInfo | null {
  if (!folder || !existsSync(folder)) return null;
  const manifest = readManifests(folder);
  let best: UpdateInfo | null = null;
  for (const name of readdirSync(folder)) {
    const m = INSTALLER_RE.exec(name);
    const version = m?.[1] ?? m?.[2];
    // The channel default is the safe one: a caller that forgot to say never ships a beta by accident.
    if (!version || !acceptsVersion(channel, version)) continue;
    if (compareVersions(version, currentVersion) <= 0) continue;
    const installer = join(folder, name);
    const entry = manifest.get(name);
    if (!entry) continue; // pas dans le manifeste : aucune empreinte à vérifier, donc pas proposé
    const stat = statSync(installer);
    if (stat.size !== entry.size) continue;
    if (!isValidBlockmap(`${installer}.blockmap`, stat.size)) continue;
    if (!best || compareVersions(version, best.version) > 0)
      best = { version, installer, builtAt: stat.mtimeMs, sha512: entry.sha512, size: entry.size };
  }
  return best;
}
