// `jarod diagnostics` (SPECS-P5-CLI.md §3) : archive ZIP MINIMALE à joindre à un rapport de bug (décision Q2 : aucune option pour y ajouter quoi que ce soit).
// Principe : LISTE BLANCHE. Rien n'est « expurgé » d'un contenu sensible — le contenu sensible n'entre jamais. Ni conversations, ni mémoire, ni documents
// indexés, ni journaux (le démon journalise le corps des notifications, qui peut citer une conversation), ni base, ni clés, ni persona, ni chemins de
// travail, ni identifiants de messagerie. Entre : l'état de santé, les versions, la liste des fichiers du dossier de profil (noms et tailles, un seul
// niveau), quelques réglages scalaires (fournisseur et modèle actifs, drapeaux d'activation, drapeaux de l'écosystème).
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, release } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, ecosystemFlags } from "@jarod/contracts";
import { redactText } from "@jarod/kernel/redact";
import { DbKeyError, defaultKeyStores, inspectDbFile, isEncryptedDb, type KeyStore } from "@jarod/plugin-storage";
import { createZip, type ZipEntry } from "@jarod/plugin-rag";
import { collectHealth, type HealthReport } from "./health.js";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const defaultDiagnosticsName = (d = new Date()): string =>
  `jarod-diagnostics-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Le dossier personnel (qui porte le nom de l'utilisateur) devient `~`, dans les deux graphies de séparateurs. */
function homeMasker(home = homedir()): (s: string) => string {
  const variants = [...new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])].filter((v) => v.length > 2);
  const re = variants.length ? new RegExp(variants.map(escapeRegExp).join("|"), "gi") : null;
  return (s) => (re ? s.replace(re, "~") : s);
}

/** Toute chaîne de l'arbre passe par le masque du dossier personnel puis `redactText` (jetons collés dans un texte libre). */
function scrub<T>(value: T, mask: (s: string) => string): T {
  if (typeof value === "string") return redactText(mask(value)) as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, mask)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [mask(k), scrub(v, mask)])) as T;
  return value;
}

const TOP_SCALARS = ["language", "activeProvider", "activeModel", "agentMode", "thinking", "autoApproveTools", "memoryInject", "maxAgentSteps", "compactThreshold"];
const ENABLED_ONLY = ["telegram", "discord", "slack", "email", "whatsapp", "apiServer", "webhooks", "remote", "mobile"];
const RAG_SCALARS = ["enabled", "chunkSize", "chunkOverlap", "maxChunksPerDoc", "topK"];
const SETTING_KEYS = [...TOP_SCALARS, ...ENABLED_ONLY, "rag", "ecosystem"];

const isScalar = (v: unknown): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v);

/** Liste blanche des réglages : seules les clés ci-dessus, seulement leurs sous-champs scalaires nommés. */
function safeSettings(stored: Record<string, unknown>): Record<string, unknown> {
  // La base ne contient que les réglages écrits : les valeurs par défaut du programme complètent (comme le fait `SettingsService.getAll`).
  const raw: Record<string, unknown> = { ...(DEFAULT_SETTINGS as unknown as Record<string, unknown>), ...stored };
  const out: Record<string, unknown> = {};
  for (const k of TOP_SCALARS) if (isScalar(raw[k])) out[k] = raw[k];
  for (const k of ENABLED_ONLY) {
    const v = raw[k] as { enabled?: unknown } | undefined;
    if (v && typeof v.enabled === "boolean") out[k] = { enabled: v.enabled };
  }
  const rag = raw.rag as Record<string, unknown> | undefined;
  if (rag) out.rag = Object.fromEntries(RAG_SCALARS.filter((k) => isScalar(rag[k])).map((k) => [k, rag[k]]));
  out.ecosystem = ecosystemFlags(raw.ecosystem);
  return out;
}

function findKey(dir: string, stores: KeyStore[]): string | null {
  for (const s of stores) {
    try {
      const k = s.load(dir);
      if (k) return k;
    } catch {
      /* magasin suivant */
    }
  }
  return null;
}

/** Noms et tailles à UN niveau : un dossier est résumé (nombre de fichiers, octets), jamais détaillé. */
function folderListing(dir: string): { name: string; kind: "fichier" | "dossier"; bytes: number; fichiers?: number }[] {
  const tally = (d: string): { files: number; bytes: number } => {
    let files = 0;
    let bytes = 0;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        const t = tally(p);
        files += t.files;
        bytes += t.bytes;
      } else {
        files++;
        bytes += statSync(p).size;
      }
    }
    return { files, bytes };
  };
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const t = tally(p);
        return { name: e.name, kind: "dossier" as const, bytes: t.bytes, fichiers: t.files };
      }
      return { name: e.name, kind: "fichier" as const, bytes: statSync(p).size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const NOTICE = `Archive de diagnostic Jarod-One — à joindre à un rapport de bug.

CONTIENT : sante.json (contrôles de l'installation), versions.json (versions de l'application, de Node, du système), dossier.json (noms et
tailles des fichiers du dossier de profil, un seul niveau), reglages.json (fournisseur et modèle actifs, drapeaux d'activation, drapeaux de
l'écosystème : aucune valeur libre).

NE CONTIENT JAMAIS : conversations, mémoire, documents indexés, journaux, base de données, clés et jetons, persona, dossiers de travail,
configuration des serveurs MCP, identifiants de messagerie. Le dossier personnel est remplacé par ~.
`;

export interface DiagnosticsOptions {
  dataRoot: string;
  profile?: string;
  version: string;
  keyStores?: KeyStore[];
  now?: Date;
}

export function buildDiagnostics(opts: DiagnosticsOptions): { entries: ZipEntry[]; report: HealthReport } {
  const mask = homeMasker();
  const stores = opts.keyStores ?? defaultKeyStores();
  const report = collectHealth({ dataRoot: opts.dataRoot, ...(opts.profile ? { profile: opts.profile } : {}), keyStores: stores });
  const json = (v: unknown) => `${JSON.stringify(scrub(v, mask), null, 2)}\n`;

  let settings: Record<string, unknown> = { indisponible: "profil ou base introuvable" };
  let folder: ReturnType<typeof folderListing> = [];
  if (report.profile) {
    const dir = join(opts.dataRoot, "profiles", report.profile);
    folder = folderListing(dir);
    const dbPath = join(dir, "jarod.db");
    if (existsSync(dbPath)) {
      try {
        const key = isEncryptedDb(dbPath) ? findKey(dir, stores) : null;
        if (isEncryptedDb(dbPath) && !key) settings = { indisponible: "base chiffrée, clé introuvable" };
        else settings = safeSettings(inspectDbFile(dbPath, key, undefined, SETTING_KEYS).settings);
      } catch (e) {
        // Le message d'une erreur de base peut citer un chemin, jamais un contenu : il passe de toute façon par scrub().
        settings = { indisponible: e instanceof DbKeyError ? "clé incorrecte" : "base illisible" };
      }
    }
  }
  const entries: ZipEntry[] = [
    { name: "LISEZMOI.txt", data: NOTICE },
    { name: "sante.json", data: json(report) },
    { name: "versions.json", data: json({ jarod: opts.version, node: process.version, platform: process.platform, arch: arch(), systeme: release(), at: (opts.now ?? new Date()).toISOString() }) },
    { name: "dossier.json", data: json(folder) },
    { name: "reglages.json", data: json(settings) },
  ];
  return { entries, report };
}

/** Écrit l'archive ; refuse d'écraser (`wx`). Rend le code de sortie. */
export function diagnosticsCommand(opts: DiagnosticsOptions & { out: string }): number {
  if (!existsSync(opts.dataRoot)) {
    console.error(`Dossier de données introuvable : ${opts.dataRoot} — rien n'a été écrit.`);
    return 1;
  }
  if (existsSync(opts.out)) {
    console.error(`« ${opts.out} » existe déjà : rien n'a été écrit (choisissez un autre nom avec --out).`);
    return 1;
  }
  const { entries } = buildDiagnostics(opts);
  try {
    writeFileSync(opts.out, createZip(entries, opts.now), { flag: "wx" });
  } catch (e) {
    console.error(`Écriture impossible : ${(e as Error).message}`);
    return 1;
  }
  console.log(`Archive de diagnostic écrite : ${opts.out}\nElle ne contient ni conversation, ni mémoire, ni document, ni journal, ni clé (voir LISEZMOI.txt dans l'archive).`);
  return 0;
}
