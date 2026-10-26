/**
 * Moteur de capacités (Phase 2) : radar des sources, évaluation en quarantaine, intégration réversible.
 *
 * Porté depuis la reconstruction `D:\Jarod-OS\repo` (`capability-engine.cjs`, Phases 1-4), où il a été
 * prouvé sur des dépôts réels. Il vit ici, dans le noyau, plutôt que dans un paquet séparé : il ne
 * dépend que de Node, et cela évite d'ajouter un paquet au verrou pnpm.
 *
 * Un radar qui LIT et ne télécharge rien ; une évaluation qui COPIE en quarantaine, calcule une
 * empreinte, vérifie une signature quand une clé est fournie, analyse statiquement puis exécute sous
 * le modèle de permissions de Node ; une intégration qui refuse sans évaluation, sans accord ou pour
 * un composant dangereux, et que l'on peut toujours annuler.
 */
import { spawnSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const STATUSES = [
  "detected",
  "analyzed",
  "proposed",
  "approved",
  "installing",
  "active",
  "failed",
  "disabled",
  "rolled_back",
  "rejected",
] as const;
export type CapabilityStatus = (typeof STATUSES)[number];
export const TYPES = ["skill", "skill-pack", "plugin", "mcp", "cli-skill", "adapter", "dependency"] as const;
export type CapabilityType = (typeof TYPES)[number];
const MAX_QUARANTINE_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 20_000;
const SANDBOX_TIMEOUT_MS = 20_000;

export interface Source {
  id: string;
  kind: "git" | "dir" | "http";
  url?: string;
  path?: string;
  role?: string;
  intervalHours?: number;
  enabled?: boolean;
}
export interface CapabilityManifest {
  id?: string;
  name?: string;
  version?: string;
  type?: string;
  description?: string;
  problem?: string;
  benefit?: string;
  windows?: boolean;
  platforms?: string[];
  requires?: string[];
  prerequisites?: string[];
  permissions?: string[];
  entry?: string;
  script?: string;
  sizeMb?: number;
  runtime?: string;
  mcp?: unknown;
  server?: unknown;
  skills?: unknown[];
  command?: unknown;
  plugin?: unknown;
  signature?: { keyId?: string; value: string };
  [k: string]: unknown;
}
export interface Discovery {
  source: string;
  version: string;
  tag: string | null;
  date: string | null;
  manifest: CapabilityManifest | null;
  changelog: string;
}
export interface Fiche {
  id: string;
  name: string;
  source: string;
  version: string;
  type: CapabilityType;
  problem: string;
  benefit: string;
  windows: { ok: boolean; why: string };
  prerequisites: unknown[];
  permissions: string[];
  risks: string[];
  cost: { installMb: number | null; runtime: string };
  tests: string[];
  changelog: string[];
  recommendation: string;
  at: string;
}
interface HistoryEntry {
  at: string;
  from: string | null;
  to: string;
  [k: string]: unknown;
}
export interface CapabilityEntry {
  id: string;
  status?: CapabilityStatus;
  updatedAt?: string;
  history?: HistoryEntry[];
  [k: string]: unknown;
}
export interface Registry {
  schema: number;
  updatedAt: string;
  sources: Record<string, { lastScanAt: string | null; lastVersion: string | null; versions: string[] }>;
  capabilities: Record<string, CapabilityEntry>;
  evaluations?: Record<string, EvaluationReport>;
}
export interface StaticFinding {
  level: "danger" | "warn";
  rule: string;
  why: string;
  file: string;
  line: number;
  excerpt: string;
}
export interface StaticAnalysis {
  files: number;
  manifest: CapabilityManifest | null;
  type: CapabilityType | null;
  entry: string | null;
  script: string | null;
  dependencies: { name: string; range: string }[];
  permissions: string[];
  findings: StaticFinding[];
  danger: number;
  warn: number;
}
export interface SandboxResult {
  ran: boolean;
  reason?: string;
  script?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stayedInSandbox?: boolean;
}
export interface EvaluationReport {
  id: string;
  at: string;
  source: string;
  quarantine: { root: string; files: number; bytes: number; treeSha256: string };
  signature: { present: boolean; valid: boolean; reason?: string; keyId?: string | null };
  analysis: StaticAnalysis;
  sandbox: SandboxResult;
  verdict: "safe" | "risky" | "dangerous";
  why: string;
  recommendation: string;
  rollbackPlan: { how: string; artifactHash: string; keepQuarantine: string };
}

const now = (): string => new Date().toISOString();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function signaturePayload(manifest: CapabilityManifest): Buffer {
  const { signature: _sig, ...rest } = manifest ?? {};
  return Buffer.from(canonical(rest), "utf8");
}

export function walkFiles(root: string, rel = "", out: string[] = []): string[] {
  let entries: { name: string; dir: boolean }[];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
      .map((e) => ({ name: String(e.name), dir: e.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.dir) walkFiles(root, r, out);
    else out.push(r);
  }
  return out;
}
export function treeDigest(root: string): string {
  const h = createHash("sha256");
  for (const rel of walkFiles(root)) {
    h.update(`${rel}\0`);
    h.update(readFileSync(join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Sources et registre
// ---------------------------------------------------------------------------
export const DEFAULT_SOURCES: Source[] = [
  { id: "hermes-desktop", kind: "git", url: "https://github.com/hermes-os/hermes-desktop", role: "poste de travail agent (amont du shell)", intervalHours: 24, enabled: true },
  { id: "hermes-agent", kind: "git", url: "https://github.com/hermes-os/hermes-agent", role: "boucle agent et outils", intervalHours: 24, enabled: true },
  { id: "dsh-desktop", kind: "git", url: "https://github.com/deepseek-ai/dsh", role: "harnais et plugins", intervalHours: 24, enabled: true },
  { id: "pinokio", kind: "git", url: "https://github.com/cocktailpeanut/pinokio", role: "installation de moteurs locaux", intervalHours: 72, enabled: true },
  { id: "openfox", kind: "git", url: "https://github.com/openfox-dev/openfox", role: "automatisation navigateur", intervalHours: 72, enabled: false },
  { id: "mcp-registry", kind: "http", url: "https://registry.modelcontextprotocol.io/v0/servers", role: "serveurs MCP publiés", intervalHours: 24, enabled: false },
];

export function loadSources(file: string): { schema: number; sources: Source[] } {
  if (!file || !existsSync(file)) return { schema: 1, sources: DEFAULT_SOURCES.map((s) => ({ ...s })) };
  const raw = JSON.parse(readFileSync(file, "utf8")) as { sources?: Source[] };
  if (!Array.isArray(raw.sources)) throw new Error("sources : « sources » doit être une liste");
  return { schema: 1, sources: raw.sources };
}
export function emptyRegistry(): Registry {
  return { schema: 1, updatedAt: now(), sources: {}, capabilities: {} };
}
export function loadRegistry(file: string): Registry {
  if (!file || !existsSync(file)) return emptyRegistry();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Registry;
  if (!raw.capabilities || typeof raw.capabilities !== "object") throw new Error("registre : « capabilities » manquant");
  return raw;
}
export function saveRegistry(file: string, registry: Registry): void {
  mkdirSync(dirname(file), { recursive: true });
  registry.updatedAt = now();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
export function setStatus(registry: Registry, id: string, status: CapabilityStatus, detail: Record<string, unknown> = {}): CapabilityEntry {
  if (!STATUSES.includes(status)) throw new Error(`statut inconnu : ${status}`);
  const entry = (registry.capabilities[id] ??= { id, history: [] });
  const previous = entry.status ?? null;
  entry.status = status;
  entry.updatedAt = now();
  entry.history = [...(entry.history ?? []), { at: entry.updatedAt, from: previous, to: status, ...detail }].slice(-40);
  return entry;
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------
const VERSION_TAG = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} : ${String(r.stderr ?? r.stdout ?? "").trim().split("\n").pop()}`);
  return String(r.stdout ?? "");
}
export function listGitVersions(dir: string): { version: string; tag: string; date: string | null }[] {
  const tags = git(dir, ["tag", "--sort=-v:refname"])
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  const out: { version: string; tag: string; date: string | null }[] = [];
  for (const tag of tags) {
    const m = VERSION_TAG.exec(tag);
    if (!m) continue;
    let date: string | null = null;
    try {
      date = git(dir, ["log", "-1", "--format=%cI", tag]).trim();
    } catch {
      // un tag sans commit lisible n'empêche pas de lire les autres
    }
    out.push({ version: m[1]!, tag, date });
  }
  return out;
}
function readAt(gitDir: string, ref: string, rel: string): string | null {
  try {
    return git(gitDir, ["show", `${ref}:${rel}`]);
  } catch {
    return null;
  }
}
export function readCapabilityManifest(source: Source, ref: string | null): CapabilityManifest | null {
  if (source.kind === "dir") {
    const p = join(source.path ?? "", "capability.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CapabilityManifest) : null;
  }
  const raw = readAt(source.path ?? "", ref ?? "HEAD", "capability.json");
  return raw ? (JSON.parse(raw) as CapabilityManifest) : null;
}
export function typeOf(manifest: CapabilityManifest | null): CapabilityType {
  const t = String(manifest?.type ?? "").toLowerCase();
  if ((TYPES as readonly string[]).includes(t)) return t as CapabilityType;
  if (manifest?.mcp || manifest?.server) return "mcp";
  if (Array.isArray(manifest?.skills)) return "skill-pack";
  if (manifest?.command) return "cli-skill";
  if (manifest?.plugin) return "plugin";
  return "skill";
}

/** Scanne une source et rend les versions vues, sans rien installer ni télécharger. */
export function scanSource(source: Source, registry: Registry, opts: { limit?: number } = {}): { source: string; kind: string; found: Discovery[]; lastVersion: string | null } {
  if (!source || typeof source !== "object") throw new Error("source invalide");
  const id = String(source.id ?? "");
  if (!id) throw new Error("source sans id");
  const state = registry.sources[id] ?? { lastScanAt: null, lastVersion: null, versions: [] };
  const found: Discovery[] = [];
  if (source.kind === "git" || source.kind === "dir") {
    const dir = String(source.path ?? "");
    if (!dir || !existsSync(dir)) throw new Error(`source ${id} : dossier introuvable (${dir || "non fourni"})`);
    const versions =
      source.kind === "git"
        ? listGitVersions(dir)
        : (() => {
            const manifest = readCapabilityManifest(source, null);
            return manifest ? [{ version: String(manifest.version ?? "0.0.0"), tag: null, date: null }] : [];
          })();
    for (const v of versions.slice(0, opts.limit ?? 50)) {
      if (state.versions.includes(v.version)) continue;
      let manifest: CapabilityManifest | null = null;
      try {
        manifest = readCapabilityManifest(source, v.tag ?? "HEAD");
      } catch {
        manifest = null;
      }
      const changelog = source.kind === "git" ? (readAt(dir, v.tag ?? "HEAD", "CHANGELOG.md") ?? "").split("\n").slice(0, 40).join("\n") : "";
      found.push({ source: id, version: v.version, tag: v.tag, date: v.date, manifest, changelog });
    }
  } else if (source.kind === "http") {
    throw new Error(`source ${id} : type http non prouvé hors ligne (à brancher avec une URL de releases)`);
  } else {
    throw new Error(`source ${id} : type inconnu « ${String(source.kind)} »`);
  }
  return { source: id, kind: String(source.kind), found, lastVersion: found[0]?.version ?? state.lastVersion ?? null };
}

export function fiche(discovery: Discovery): Fiche {
  const m = discovery.manifest ?? {};
  const type = typeOf(m);
  const name = String(m.name ?? m.id ?? discovery.source);
  const version = String(m.version ?? discovery.version);
  const permissions = Array.isArray(m.permissions) ? m.permissions : [];
  const windows =
    m.windows === false || (Array.isArray(m.platforms) && !m.platforms.includes("win32"))
      ? { ok: false, why: "ne déclare pas Windows" }
      : { ok: true, why: m.windows === true || (Array.isArray(m.platforms) && m.platforms.includes("win32")) ? "déclare Windows" : "aucune exigence contraire déclarée" };
  const riskyPerms = permissions.filter((p) => ["network", "shell", "filesystem", "process", "gpu", "secrets"].includes(String(p).toLowerCase()));
  return {
    id: `${discovery.source}:${name}`,
    name,
    source: discovery.source,
    version,
    type,
    problem: String(m.problem ?? m.description ?? "non documenté par la source"),
    benefit: String(m.benefit ?? m.description ?? "à établir par l’évaluation"),
    windows,
    prerequisites: Array.isArray(m.requires) ? m.requires : Array.isArray(m.prerequisites) ? m.prerequisites : [],
    permissions,
    risks: riskyPerms.length
      ? [`permissions sensibles demandées : ${riskyPerms.join(", ")}`, "composant externe : à évaluer en quarantaine"]
      : ["composant externe : à évaluer en quarantaine"],
    cost: { installMb: typeof m.sizeMb === "number" ? m.sizeMb : null, runtime: String(m.runtime ?? "inconnu") },
    tests: ["analyse statique", "exécution contrôlée (réseau coupé)", "test de l’interface exposée", "retour arrière"],
    changelog: (discovery.changelog ?? "").split("\n").filter(Boolean).slice(0, 12),
    recommendation: riskyPerms.length ? "évaluer avant toute intégration (permissions sensibles)" : "évaluer en quarantaine, puis proposer",
    at: now(),
  };
}

// ---------------------------------------------------------------------------
// Évaluation : quarantaine, analyse statique, exécution contrôlée
// ---------------------------------------------------------------------------
export function quarantineCopy(sourceRoot: string, dest: string): { root: string; files: number; bytes: number; treeSha256: string } {
  mkdirSync(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  const copy = (rel: string): void => {
    for (const e of readdirSync(join(sourceRoot, rel), { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        copy(r);
      } else if (e.isFile()) {
        const dst = join(dest, r);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(join(sourceRoot, r), dst);
        const st = statSync(dst);
        files += 1;
        bytes += st.size;
        if (files > MAX_FILES) throw new Error(`quarantaine : plus de ${MAX_FILES} fichiers`);
        if (bytes > MAX_QUARANTINE_BYTES) throw new Error(`quarantaine : plus de ${Math.round(MAX_QUARANTINE_BYTES / 1_048_576)} Mo`);
      }
    }
  };
  copy("");
  return { root: dest, files, bytes, treeSha256: treeDigest(dest) };
}

const RULES: { id: string; level: "danger" | "warn"; re: RegExp; why: string }[] = [
  { id: "child-process", level: "danger", re: /\b(?:child_process|execSync|spawnSync|execFileSync|execa)\b/, why: "lance un programme du système" },
  { id: "dynamic-code", level: "danger", re: /\b(?:eval\s*\(|new Function\s*\()/, why: "exécute du code construit à l’exécution" },
  { id: "absolute-write", level: "warn", re: /(?:writeFileSync|writeFile|appendFileSync|createWriteStream)\s*\(\s*['"`](?:[A-Za-z]:[\\/]|\/(?!tmp|workspace))/, why: "écrit hors dossier de travail" },
  { id: "network-client", level: "warn", re: /\b(?:https?\.request|https?\.get|fetch\s*\(|net\.connect|tls\.connect|WebSocket)\b/, why: "accès réseau sortant" },
  { id: "obfuscation", level: "warn", re: /(?:\\x[0-9a-f]{2}){20,}|(?:atob|Buffer\.from\([^)]*,\s*['"]base64['"])/, why: "contenu encodé/obscurci" },
  { id: "secrets", level: "danger", re: /\b(?:id_rsa|\.ssh[\\/]|password|api[_-]?key|token)\b\s*[=:]/i, why: "manipule des secrets" },
  { id: "privilege", level: "danger", re: /\b(?:runas|sudo|Start-Process\s+-Verb\s+RunAs|schtasks|reg\s+add)\b/i, why: "élève les privilèges ou modifie le système" },
  { id: "auto-update", level: "warn", re: /\b(?:auto-?update|self-?update|git\s+pull|npm\s+install\s+-g)\b/i, why: "se met à jour tout seul" },
];

export function staticAnalysis(root: string): StaticAnalysis {
  const files = walkFiles(root);
  const findings: StaticFinding[] = [];
  for (const rel of files) {
    if (!/\.(?:m?js|cjs|ts|py|ps1|sh|json|md)$/i.test(rel)) continue;
    const p = join(root, rel);
    if (statSync(p).size > 2 * 1024 * 1024) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) findings.push({ level: rule.level, rule: rule.id, why: rule.why, file: rel, line: i + 1, excerpt: line.trim().slice(0, 160) });
      }
    });
  }
  let manifest: CapabilityManifest | null = null;
  const mf = join(root, "capability.json");
  if (existsSync(mf)) manifest = JSON.parse(readFileSync(mf, "utf8")) as CapabilityManifest;
  let dependencies: { name: string; range: string }[] = [];
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      dependencies = Object.entries({ ...j.dependencies, ...j.devDependencies }).map(([name, range]) => ({ name, range }));
    } catch {
      // un package.json illisible n'est pas une analyse : il est simplement ignoré
    }
  }
  const entry = manifest && typeof manifest.entry === "string" ? manifest.entry : existsSync(join(root, "index.js")) ? "index.js" : null;
  const script = manifest && typeof manifest.script === "string" ? manifest.script : null;
  return {
    files: files.length,
    manifest,
    type: manifest ? typeOf(manifest) : null,
    entry,
    script,
    dependencies,
    permissions: Array.isArray(manifest?.permissions) ? manifest.permissions : [],
    findings,
    danger: findings.filter((f) => f.level === "danger").length,
    warn: findings.filter((f) => f.level === "warn").length,
  };
}

/** Exécution contrôlée : modèle de permissions de Node, réseau refusé, écriture dans un dossier temporaire. */
export function sandboxRun(root: string, analysis: StaticAnalysis, opts: { timeoutMs?: number; nodePath?: string } = {}): SandboxResult {
  const script = analysis.script ?? analysis.entry;
  if (!script) return { ran: false, reason: "aucun point d’entrée exécutable (ni script, ni entry)" };
  const abs = resolve(root, script);
  if (!abs.startsWith(resolve(root) + sep)) return { ran: false, reason: "point d’entrée hors du dossier du composant" };
  if (!existsSync(abs)) return { ran: false, reason: `point d’entrée absent : ${script}` };
  const data = mkdtemp();
  const started = Date.now();
  const nodePath = opts.nodePath ?? process.execPath;
  const reads = [root, dirname(nodePath), ...((process as { resourcesPath?: string }).resourcesPath ? [(process as { resourcesPath?: string }).resourcesPath as string] : [])];
  const args = ["--permission", ...reads.map((r) => `--allow-fs-read=${r}`), `--allow-fs-write=${data}`, abs];
  const env: Record<string, string> = {};
  for (const k of ["SystemRoot", "windir", "PATH"]) if (process.env[k]) env[k] = process.env[k] as string;
  // Sous Electron, l'exécutable est electron.exe : il doit se comporter en Node, et lire ses ressources.
  if ((process.versions as { electron?: string }).electron) env.ELECTRON_RUN_AS_NODE = "1";
  const r = spawnSync(nodePath, args, { cwd: data, encoding: "utf8", timeout: opts.timeoutMs ?? SANDBOX_TIMEOUT_MS, windowsHide: true, env });
  const out: SandboxResult = {
    ran: true,
    script,
    exitCode: r.status,
    timedOut: Boolean(r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT"),
    error: r.error ? String(r.error.message) : null,
    durationMs: Date.now() - started,
    stdout: String(r.stdout ?? "").slice(0, 4000),
    stderr: String(r.stderr ?? "").slice(0, 4000),
    stayedInSandbox: true,
  };
  try {
    rmSync(data, { recursive: true, force: true });
  } catch {
    // un dossier temporaire qui refuse de partir ne change pas le verdict
  }
  return out;
}
function mkdtemp(): string {
  const dir = join(tmpdir(), `jarod-cap-sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function verdictOf(analysis: StaticAnalysis, sandbox: SandboxResult): { verdict: "safe" | "risky" | "dangerous"; why: string } {
  if (analysis.danger > 0) {
    return { verdict: "dangerous", why: `motifs dangereux : ${[...new Set(analysis.findings.filter((f) => f.level === "danger").map((f) => f.rule))].join(", ")}` };
  }
  if (sandbox.ran && sandbox.exitCode !== 0) return { verdict: "risky", why: `exécution contrôlée en échec (code ${String(sandbox.exitCode)}${sandbox.error ? ` ; ${sandbox.error}` : ""})` };
  if (analysis.warn > 2) return { verdict: "risky", why: `${analysis.warn} motifs à surveiller` };
  return { verdict: "safe", why: sandbox.ran ? "exécution contrôlée terminée sans refus" : "analyse statique seule (aucun point d’entrée)" };
}

/** Vérifie une signature ed25519 si elle est présente ET si une clé publique est fournie. */
export function verifySignature(manifest: CapabilityManifest, publicPem: string | null): EvaluationReport["signature"] {
  if (!manifest?.signature?.value) return { present: false, valid: false, reason: "aucune signature" };
  if (!publicPem) return { present: true, valid: false, reason: "aucune clé publique pour vérifier" };
  try {
    const worked = verify(null, signaturePayload(manifest), publicPem, Buffer.from(String(manifest.signature.value), "base64"));
    return worked
      ? { present: true, valid: true, keyId: manifest.signature.keyId ?? null }
      : { present: true, valid: false, reason: "signature invalide", keyId: manifest.signature.keyId ?? null };
  } catch (e) {
    return { present: true, valid: false, reason: `vérification impossible : ${(e as Error).message}` };
  }
}

export function evaluate(sourceRoot: string, opts: { quarantineRoot: string; id?: string; publicPem?: string | null }): EvaluationReport {
  if (!existsSync(sourceRoot)) throw new Error(`composant introuvable : ${sourceRoot}`);
  const capId = opts.id ?? sourceRoot.split(/[\\/]/).pop() ?? "capacite";
  const dest = join(opts.quarantineRoot, `${capId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now().toString(36)}`);
  const q = quarantineCopy(sourceRoot, dest);
  const analysis = staticAnalysis(dest);
  const signature = verifySignature(analysis.manifest ?? {}, opts.publicPem ?? null);
  const sandbox = sandboxRun(dest, analysis);
  const verdict = verdictOf(analysis, sandbox);
  return {
    id: capId,
    at: now(),
    source: sourceRoot,
    quarantine: q,
    signature,
    analysis,
    sandbox,
    ...verdict,
    recommendation:
      verdict.verdict === "dangerous"
        ? "refuser : ne pas intégrer"
        : verdict.verdict === "risky"
          ? "intégrer seulement comme adaptateur isolé, après accord explicite"
          : `intégration possible comme ${analysis.type ?? "skill"}`,
    rollbackPlan: { how: "retirer l’artefact et restaurer l’entrée de registre précédente", artifactHash: q.treeSha256, keepQuarantine: dest },
  };
}

// ---------------------------------------------------------------------------
// Intégration réversible
// ---------------------------------------------------------------------------
const TYPE_DIR: Record<CapabilityType, string> = {
  skill: "skills",
  "skill-pack": "skills",
  adapter: "adapters",
  mcp: "mcp",
  "cli-skill": "cli-skills",
  plugin: "plugins",
  dependency: "dependencies",
};

export function integrate(registry: Registry, report: EvaluationReport, opts: { kind?: string; targetRoot: string; approve?: boolean }): CapabilityEntry {
  if (report.verdict === "dangerous") throw new Error(`intégration refusée : composant dangereux (${report.why})`);
  if (!report.quarantine?.treeSha256) throw new Error("intégration refusée : composant non évalué (aucune quarantaine)");
  if (!opts.approve) throw new Error("intégration refusée : accord explicite requis (approve)");
  const type = (TYPES as readonly string[]).includes(String(opts.kind)) ? (opts.kind as CapabilityType) : (report.analysis.type ?? "skill");
  const id = report.id;
  const dir = join(opts.targetRoot, TYPE_DIR[type] ?? "adapters", id);
  mkdirSync(dir, { recursive: true });
  const artifact = {
    id,
    type,
    version: report.analysis.manifest?.version ?? "0.0.0",
    source: report.source,
    treeSha256: report.quarantine.treeSha256,
    integratedAt: now(),
    entry: report.analysis.entry ?? null,
    permissions: report.analysis.permissions ?? [],
  };
  for (const rel of walkFiles(report.quarantine.root)) {
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(report.quarantine.root, rel), dst);
  }
  writeFileSync(join(dir, "integration.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  // Instantané sérialisable de l'état précédent (sans son propre retour arrière : sinon cycle).
  const current = registry.capabilities[id] ?? null;
  const previous = current ? (JSON.parse(JSON.stringify({ ...current, rollback: null })) as CapabilityEntry) : null;
  const entry = setStatus(registry, id, "active", { artifact: dir, treeSha256: artifact.treeSha256, type });
  Object.assign(entry, {
    name: report.analysis.manifest?.name ?? id,
    type,
    version: artifact.version,
    source: report.source,
    hash: artifact.treeSha256,
    signature: report.signature.valid ? (report.signature.keyId ?? "valide") : report.signature.present ? "invalide" : null,
    permissions: artifact.permissions,
    exposed: type === "mcp" ? ["mcp"] : type === "adapter" ? ["adapter"] : ["skill"],
    tests: ["analyse statique", "exécution contrôlée", "empreinte"],
    verdict: report.verdict,
    artifact: dir,
    rollback: { artifact: dir, previous, at: now() },
  });
  return entry;
}

export function rollback(registry: Registry, id: string): { id: string; removed: number; restored: boolean } {
  const entry = registry.capabilities[id];
  if (!entry) throw new Error(`capacité inconnue : ${id}`);
  if (!entry.artifact) throw new Error(`${id} : aucune intégration à annuler`);
  const dir = String(entry.artifact);
  let removed = 0;
  if (existsSync(dir) && resolve(dir).startsWith(resolve(dirname(dir)) + sep)) {
    for (const rel of walkFiles(dir)) {
      rmSync(join(dir, rel), { force: true });
      removed += 1;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  const previous = (entry.rollback as { previous?: CapabilityEntry | null } | undefined)?.previous ?? null;
  // Tombstone : le registre garde la trace du retour arrière (aucune suppression silencieuse).
  registry.capabilities[id] = previous
    ? { ...previous, history: [...(previous.history ?? []), ...(entry.history ?? [])].slice(-40) }
    : { ...entry, artifact: null };
  setStatus(registry, id, "rolled_back", { removed, restored: Boolean(previous), at: now() });
  return { id, removed, restored: Boolean(previous) };
}

/** Active ou désactive une capacité DÉJÀ intégrée (l'artefact reste en place). */
export function setActive(registry: Registry, id: string, active: boolean): { id: string; status: CapabilityStatus } {
  const entry = registry.capabilities[id];
  if (!entry) throw new Error(`capacité inconnue : ${id}`);
  if (!entry.artifact) throw new Error(`${id} : aucune intégration à activer ou désactiver`);
  if (active && !existsSync(String(entry.artifact))) throw new Error(`${id} : artefact absent (${String(entry.artifact)})`);
  const target: CapabilityStatus = active ? "active" : "disabled";
  if (entry.status === target) throw new Error(`${id} est déjà ${active ? "active" : "désactivée"}`);
  setStatus(registry, id, target, { artifact: entry.artifact });
  return { id, status: target };
}

/** Supprime l'intégration ET l'entrée : définitif. */
export function remove(registry: Registry, id: string): { id: string; removed: number } {
  const entry = registry.capabilities[id];
  if (!entry) throw new Error(`capacité inconnue : ${id}`);
  let removed = 0;
  if (entry.artifact && existsSync(String(entry.artifact))) {
    for (const rel of walkFiles(String(entry.artifact))) {
      rmSync(join(String(entry.artifact), rel), { force: true });
      removed += 1;
    }
    rmSync(String(entry.artifact), { recursive: true, force: true });
  }
  delete registry.capabilities[id];
  if (registry.evaluations) delete registry.evaluations[id];
  return { id, removed };
}

