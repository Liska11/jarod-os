/**
 * Registre Discover (Q11 = A, conditions de l'utilisateur) : lecture du catalogue public `hermes-registry` PAR LE
 * MAIN SEUL et préparation vérifiée d'un paquet avant toute installation. Sources SANK-UI :
 * `src/main/registry.ts:26-86` (dépôt, URL, `IndexEntry`, `EntryManifest`), `:88-161` (`fetchRegistry` : cache
 * 5 min, erreur → catalogue vide + `error`), `:163-199` (`fetchModelRegistry`), `:250-322` (`buildSpec`,
 * `fetchRegistryDetail`), `:324-370` (arbre git récursif, téléchargement du dossier) ; `shared/registry.ts`
 * (types) — rév. 3aaadb0, MIT © github.com/fathah.
 *
 * Écarts (conditions Q11, DECISIONS 2026-09-28) :
 * - catalogue, détail et `models.json` lus ici, jamais par le renderer ; `icon` non transmise (servie par
 *   `registry.hermesone.org` : la CSP L3 bloque les images distantes, réouverture seulement par un proxy du main) ;
 * - préparation d'une installation : l'entrée est RELUE dans le catalogue par (type, id) — aucun champ du renderer
 *   n'est cru ; révision ÉPINGLÉE (commit de la branche résolu par l'API GitHub), fichiers lus à ce commit et
 *   vérifiés contre l'empreinte git de l'arbre (`blob <taille>\0…`, SHA-1) ; limites 100 fichiers, 1 Mo par
 *   fichier, 5 Mo au total ; chemins relatifs sans remontée ;
 * - REFUS (jamais d'installation partielle) : licence absente ; `permissions` non déclarées (`manifest.json`,
 *   liste de chaînes — absente = refus) ; tout fichier hors liste documentaire (code, binaire, script : Jarod-One
 *   n'exécute du code tiers que sous l'isolation U2, et un paquet du registre n'est pas un plugin U2) ; serveur
 *   MCP local (commande : s'exécuterait hors isolation), MCP SSE ou non HTTPS, MCP à en-têtes ; workflows
 *   (code Hermes) ; skill sans `SKILL.md` ; agent sans fichier de persona ;
 * - empreinte du paquet = SHA-256 de la liste triée `chemin\0sha256(contenu)\n` (affichée à la confirmation et
 *   consignée avec la provenance).
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { RegistryCatalog, RegistryDetail, RegistryDetailRow, RegistryItem, RegistryKind, ModelRegistry } from "../sank/src/shared/registry.js";

export interface RegistrySource {
  /** `propriétaire/dépôt`. */
  repo: string;
  branch: string;
  /** Base des fichiers bruts (`https://raw.githubusercontent.com`). */
  rawBase: string;
  /** Base de l'API GitHub (`https://api.github.com`). */
  apiBase: string;
}

/** SANK-UI `registry.ts:32-40`. */
export const HERMES_REGISTRY: RegistrySource = {
  repo: "fathah/hermes-registry",
  branch: "main",
  rawBase: "https://raw.githubusercontent.com",
  apiBase: "https://api.github.com",
};

/** `registry.ts:43-58`. */
interface IndexEntry {
  id: string;
  type: "agent" | "mcp" | "skill" | "workflow";
  category?: string;
  name: string;
  version?: string;
  description?: string;
  tags?: string[];
  author?: string | { name?: string };
  license?: string;
  platforms?: string[];
  path?: string;
  icon?: string;
}

/** `registry.ts:61-78`. */
export interface EntryManifest {
  description?: string;
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  permissions?: string[];
  entry?: string;
  requires?: string[];
  model?: string;
  tools?: string[];
  license?: string;
  compatibility?: { hermes?: string; desktop?: string } | null;
}

const TYPE_TO_KIND: Record<IndexEntry["type"], RegistryKind> = { skill: "skills", mcp: "mcps", agent: "agents", workflow: "workflows" };
const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 5_000_000;
/** Seuls fichiers admis dans un paquet : documentation et données, jamais de code (liste fermée). */
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOC_NAMES = new Set(["LICENSE", "LICENCE", "NOTICE", "COPYING"]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface PreparedFile {
  /** Chemin dans le dossier du paquet (POSIX). */
  path: string;
  data: Buffer;
  sha256: string;
  gitBlob: string;
}

export interface PreparedPackage {
  kind: RegistryKind;
  id: string;
  name: string;
  category?: string;
  repo: string;
  revision: string;
  path: string;
  /** Adresse lisible de la source épinglée (dépôt, révision, dossier). */
  source: string;
  license: string;
  permissions: string[];
  manifest: EntryManifest | null;
  files: PreparedFile[];
  sha256: string;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const gitBlobSha = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

function authorName(author: IndexEntry["author"]): string | undefined {
  if (!author) return undefined;
  return typeof author === "string" ? author : author.name;
}

/** `registry.ts:98-118` (`toItem`), sans `icon` (CSP L3). */
function toItem(e: IndexEntry, src: RegistrySource): RegistryItem {
  const item: RegistryItem = { id: e.id, name: e.name || e.id, description: e.description || "" };
  const author = authorName(e.author);
  if (author) item.author = author;
  if (e.category) item.category = e.category;
  if (e.tags) item.tags = e.tags;
  if (e.version) item.version = e.version;
  if (e.license) item.license = e.license;
  if (e.platforms) item.platforms = e.platforms;
  if (e.path) {
    item.path = e.path;
    item.homepage = `https://github.com/${src.repo}/tree/${src.branch}/${e.path}`;
  }
  return item;
}

/** Chemin relatif sûr (POSIX, sans remontée ni racine). */
function safeRel(p: string): string {
  const norm = posix.normalize(p.replace(/\\/g, "/"));
  if (!norm || norm === "." || norm.startsWith("/") || norm.startsWith("..") || /^[a-zA-Z]:/.test(norm) || norm.includes("/../"))
    throw new Error(`Chemin refusé : ${p}`);
  return norm;
}

/** Empreinte du paquet : SHA-256 de `chemin\0sha256\n` triés par chemin. */
export function packageSha256(files: { path: string; sha256: string }[]): string {
  return sha256(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `${f.path}\0${f.sha256}\n`)
      .join(""),
  );
}

/** Pourquoi un paquet préparé est refusé (null = installable sous réserve de confirmation). */
export function refusal(p: Omit<PreparedPackage, "sha256">): string | null {
  if (!p.license.trim()) return "licence non déclarée : provenance et règles de licence (L) impossibles à tenir";
  const m = p.manifest;
  if (!m || !Array.isArray(m.permissions) || !m.permissions.every((x) => typeof x === "string"))
    return "le paquet ne déclare pas ses permissions (manifest.json › permissions)";
  for (const f of p.files) {
    const base = posix.basename(f.path);
    const ext = posix.extname(base).toLowerCase();
    if (!(DOC_EXTENSIONS.has(ext) || DOC_NAMES.has(base)))
      return `fichier « ${f.path} » hors documentation : Jarod-One n'exécute du code tiers que sous l'isolation U2 (plugin à permissions déclarées), ce paquet n'en est pas un`;
  }
  switch (p.kind) {
    case "workflows":
      return "les workflows Hermes sont du code : ils ne s'exécutent pas sous l'isolation U2 de Jarod-One";
    case "skills":
      return p.files.some((f) => f.path === "SKILL.md") ? null : "skill sans SKILL.md";
    case "agents": {
      const entry = m.entry || "AGENT.md";
      return p.files.some((f) => f.path === entry) ? null : `agent sans fichier de persona (${entry})`;
    }
    case "mcps": {
      if (m.command || (!m.url && m.transport !== "http" && m.transport !== "sse"))
        return "serveur MCP local (commande) : il s'exécuterait hors de l'isolation U2";
      if (m.transport === "sse") return "transport MCP SSE non pris en charge par Jarod-One (HTTP « streamable » seulement)";
      if (!m.url || !/^https:\/\//i.test(m.url)) return "serveur MCP distant sans URL https://";
      if (m.headers && Object.keys(m.headers).length) return "serveur MCP à en-têtes (jetons) : à configurer à la main dans Capacités › MCP";
      return null;
    }
    default:
      return "type d'entrée inconnu";
  }
}

export class RegistryClient {
  private cache: { at: number; data: RegistryCatalog; entries: IndexEntry[] } | null = null;
  private modelCache: { at: number; data: ModelRegistry } | null = null;

  constructor(
    readonly src: RegistrySource,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async get(url: string, accept = "application/json"): Promise<Response> {
    const res = await this.http(url, { headers: { Accept: accept, "user-agent": "Jarod-One" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`Registry returned ${res.status}`), { status: res.status });
    return res;
  }

  private rawUrl(ref: string, path: string): string {
    return `${this.src.rawBase}/${this.src.repo}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  private get branchRef(): string {
    return `refs/heads/${this.src.branch}`;
  }

  /** `fetchRegistry` (registry.ts:131-161) : cache 5 min ; échec → catalogue vide + `error`, jamais une exception. */
  async catalog(force = false): Promise<RegistryCatalog & { error?: string }> {
    const c = this.cache;
    if (!force && c && this.now() - c.at < CACHE_TTL_MS) return c.data;
    try {
      const raw = (await (await this.get(this.rawUrl(this.branchRef, "index.json"))).json()) as { entries?: IndexEntry[] };
      const data: RegistryCatalog = { skills: [], mcps: [], agents: [], workflows: [] };
      const entries = (raw.entries ?? []).filter((e) => e && typeof e.id === "string" && TYPE_TO_KIND[e.type]);
      for (const e of entries) data[TYPE_TO_KIND[e.type]].push(toItem(e, this.src));
      this.cache = { at: this.now(), data, entries };
      return data;
    } catch (err) {
      return { skills: [], mcps: [], agents: [], workflows: [], error: err instanceof Error ? err.message : "Failed to load registry" };
    }
  }

  /** `fetchModelRegistry` (registry.ts:169-199). */
  async models(force = false): Promise<ModelRegistry> {
    const c = this.modelCache;
    if (!force && c && this.now() - c.at < CACHE_TTL_MS) return c.data;
    try {
      const raw = (await (await this.get(this.rawUrl(this.branchRef, "models.json"))).json()) as ModelRegistry;
      const data: ModelRegistry = { providers: Array.isArray(raw.providers) ? raw.providers : [] };
      if (raw.schemaVersion !== undefined) data.schemaVersion = raw.schemaVersion;
      if (raw.generated !== undefined) data.generated = raw.generated;
      if (raw.providerCount !== undefined) data.providerCount = raw.providerCount;
      if (raw.modelCount !== undefined) data.modelCount = raw.modelCount;
      this.modelCache = { at: this.now(), data };
      return data;
    } catch (err) {
      return { providers: [], error: err instanceof Error ? err.message : "Failed to load models" };
    }
  }

  /** L'entrée du CATALOGUE pour (type, id) — jamais celle que décrit le renderer. */
  private async entry(kind: unknown, id: unknown): Promise<IndexEntry> {
    if (typeof kind !== "string" || !Object.values(TYPE_TO_KIND).includes(kind as RegistryKind)) throw new Error("Type d'entrée inconnu");
    if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error("Identifiant d'entrée invalide");
    let found = this.cache?.entries.find((e) => TYPE_TO_KIND[e.type] === kind && e.id === id);
    if (!found) {
      const fresh = await this.catalog(true);
      if (fresh.error) throw new Error(`Registre injoignable : ${fresh.error}`);
      found = this.cache?.entries.find((e) => TYPE_TO_KIND[e.type] === kind && e.id === id);
    }
    if (!found) throw new Error(`Entrée « ${id} » absente du registre`);
    return found;
  }

  private async text(ref: string, path: string): Promise<string> {
    try {
      const t = await (await this.get(this.rawUrl(ref, path), "text/plain")).text();
      return t.trim() ? t : "";
    } catch {
      return "";
    }
  }

  private async manifestAt(ref: string, path: string): Promise<EntryManifest | null> {
    try {
      return (await (await this.get(this.rawUrl(ref, `${path}/manifest.json`))).json()) as EntryManifest;
    } catch {
      return null;
    }
  }

  /** `fetchRegistryDetail` + `buildSpec` (registry.ts:250-322), sur l'entrée du catalogue. */
  async detail(kind: unknown, item: unknown): Promise<RegistryDetail> {
    const e = await this.entry(kind, (item as { id?: unknown } | null)?.id);
    const it = toItem(e, this.src);
    if (!e.path) return { description: it.description };
    const path = safeRel(e.path);
    if (kind === "skills") {
      for (const file of ["SKILL.md", "README.md"]) {
        const text = await this.text(this.branchRef, `${path}/${file}`);
        if (text) return { markdown: text };
      }
      return { description: it.description };
    }
    const m = await this.manifestAt(this.branchRef, path);
    const detail = buildSpec(kind as RegistryKind, it, m);
    const doc = await this.text(this.branchRef, `${path}/${kind === "agents" ? "AGENT.md" : "README.md"}`);
    if (doc) detail.markdown = doc;
    return detail;
  }

  /**
   * Prépare un paquet : révision épinglée, fichiers vérifiés, règles appliquées. Lève avec le motif du refus ;
   * ne touche jamais au disque.
   */
  async prepare(kind: unknown, id: unknown): Promise<PreparedPackage> {
    const e = await this.entry(kind, id);
    if (!e.path) throw new Error("Entrée sans dossier dans le registre");
    const path = safeRel(e.path);
    const api = `${this.src.apiBase}/repos/${this.src.repo}`;
    const gh = "application/vnd.github+json";
    const revision = ((await (await this.get(`${api}/commits/${encodeURIComponent(this.src.branch)}`, gh)).json()) as { sha?: string }).sha ?? "";
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Révision du registre illisible");
    const tree = (await (await this.get(`${api}/git/trees/${revision}?recursive=1`, gh)).json()) as {
      tree?: { path: string; type: string; sha: string; size?: number }[];
      truncated?: boolean;
    };
    if (tree.truncated) throw new Error("Arbre du registre tronqué : contenu non vérifiable");
    const blobs = (tree.tree ?? []).filter((b) => b.type === "blob" && b.path.startsWith(`${path}/`));
    if (!blobs.length) throw new Error("Aucun fichier pour cette entrée");
    if (blobs.length > MAX_FILES) throw new Error(`Trop de fichiers (${blobs.length})`);
    const files: PreparedFile[] = [];
    let total = 0;
    for (const b of blobs) {
      if ((b.size ?? 0) > MAX_FILE_BYTES) throw new Error(`Fichier trop gros : ${b.path}`);
      const rel = safeRel(b.path.slice(path.length + 1));
      const data = Buffer.from(await (await this.get(this.rawUrl(revision, b.path), "application/octet-stream")).arrayBuffer());
      if (data.length > MAX_FILE_BYTES) throw new Error(`Fichier trop gros : ${b.path}`);
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw new Error("Paquet trop volumineux");
      const gitBlob = gitBlobSha(data);
      if (gitBlob !== b.sha) throw new Error(`Contenu altéré : ${rel} ne correspond pas à l'arbre git ${revision.slice(0, 12)}`);
      files.push({ path: rel, data, sha256: sha256(data), gitBlob });
    }
    const manifestFile = files.find((f) => f.path === "manifest.json");
    let manifest: EntryManifest | null = null;
    if (manifestFile) {
      try {
        manifest = JSON.parse(manifestFile.data.toString("utf8")) as EntryManifest;
      } catch {
        throw new Error("manifest.json illisible");
      }
    }
    const kindOk = kind as RegistryKind;
    const base: Omit<PreparedPackage, "sha256"> = {
      kind: kindOk,
      id: e.id,
      name: e.name || e.id,
      ...(e.category ? { category: e.category } : {}),
      repo: this.src.repo,
      revision,
      path,
      source: `https://github.com/${this.src.repo}/tree/${revision}/${path}`,
      license: (manifest?.license || e.license || "").trim(),
      permissions: Array.isArray(manifest?.permissions) ? manifest!.permissions.filter((x) => typeof x === "string") : [],
      manifest,
      files,
    };
    const why = refusal(base);
    if (why) throw new Error(`Installation refusée : ${why}.`);
    return { ...base, sha256: packageSha256(files) };
  }
}

/** `buildSpec` (registry.ts:250-297), corps repris. */
function buildSpec(kind: RegistryKind, item: RegistryItem, m: EntryManifest | null): RegistryDetail {
  const rows: RegistryDetailRow[] = [];
  if (kind === "mcps" && m) {
    rows.push({ label: "Transport", value: m.transport || (m.url ? "http" : "stdio") });
    if (m.url) rows.push({ label: "URL", value: m.url, mono: true });
    if (m.command) rows.push({ label: "Command", value: [m.command, ...(m.args ?? [])].join(" "), mono: true });
    if (m.env && Object.keys(m.env).length) rows.push({ label: "Environment", chips: Object.keys(m.env) });
    if (m.permissions?.length) rows.push({ label: "Permissions", chips: m.permissions });
  } else if (kind === "agents" && m) {
    if (m.model) rows.push({ label: "Model", value: m.model, mono: true });
    if (m.tools?.length) rows.push({ label: "Tools", chips: m.tools });
  } else if (kind === "workflows" && m) {
    if (m.entry) rows.push({ label: "Entry", value: m.entry, mono: true });
    if (m.requires?.length) rows.push({ label: "Requires", chips: m.requires });
  }
  if (item.category) rows.push({ label: "Category", value: item.category });
  if (item.platforms?.length) rows.push({ label: "Platforms", chips: item.platforms });
  if (item.tags?.length) rows.push({ label: "Tags", chips: item.tags });
  const license = m?.license || item.license;
  if (license) rows.push({ label: "License", value: license });
  if (item.author) rows.push({ label: "Author", value: item.author });
  if (item.version) rows.push({ label: "Version", value: item.version });
  const compat = m?.compatibility;
  if (compat?.hermes) rows.push({ label: "Requires Hermes", value: compat.hermes, mono: true });
  return { description: m?.description || item.description || "", rows };
}
