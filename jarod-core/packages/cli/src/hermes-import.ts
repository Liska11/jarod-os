// Import des skills et des serveurs MCP d'un dossier Hermes dans un profil Jarod.
//
// - Skills : chaque dossier contenant un `SKILL.md` est copié tel quel (arborescence par catégories conservée, comme Jarod la lit) ;
//   aucun skill existant n'est écrasé, et tout ce qui est importé est DÉSACTIVÉ (`disabledSkills`) : on l'active à la demande.
// - MCP : `mcp_servers` de `config.yaml` est traduit vers `mcpServers`, DÉSACTIVÉ lui aussi. Les jetons OAuth de `mcp-tokens/<nom>.json`
//   deviennent l'en-tête `Authorization: Bearer …` des serveurs distants (Jarod n'a pas de flux OAuth : le jeton d'accès est valable
//   tant qu'il n'a pas expiré).
// Rien n'est écrit côté Hermes. Les valeurs secrètes (jetons, variables d'environnement) ne figurent jamais dans le compte rendu.
import { type Dirent, existsSync, readFileSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { McpServerConfig } from "@jarod/contracts";

const MAX_SKILL_DEPTH = 6;

// ───────────────────────── YAML (le sous-ensemble que Hermes écrit pour `mcp_servers`) ─────────────────────────

interface Line {
  indent: number;
  text: string;
}

/** Le bloc de premier niveau `<key>:` d'un `config.yaml`, ses lignes utiles seulement (ni vides ni commentaires). */
function blockLines(yaml: string, key: string): Line[] {
  const out: Line[] = [];
  let inside = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      if (inside) break;
      inside = raw.trimEnd() === `${key}:`;
      continue;
    }
    if (inside) out.push({ indent, text: raw.trim() });
  }
  return out;
}

function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  const plain = s.replace(/\s+#.*$/, "");
  if (plain === "{}") return {};
  if (plain === "[]") return [];
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (plain === "null" || plain === "~" || plain === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain);
  if (/^[[{]/.test(plain)) throw new Error(`YAML en ligne non géré : ${plain.slice(0, 30)}`);
  return plain;
}

function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  let i = start;
  if (lines[i]!.text === "-" || lines[i]!.text.startsWith("- ")) {
    const list: unknown[] = [];
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text === "-" || lines[i]!.text.startsWith("- "))) {
      const item = lines[i]!.text.slice(1).trim();
      if (/^("[^"]*"|'[^']*'|[^\s:][^:]*):(\s|$)/.test(item) && !/^[A-Za-z]:[\\/]/.test(item)) throw new Error("liste d'objets non gérée");
      list.push(scalar(item));
      i++;
    }
    return [list, i];
  }
  const map: Record<string, unknown> = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const m = /^("[^"]*"|'[^']*'|[^\s:][^:]*?):(?:\s+(.*))?$/.exec(lines[i]!.text);
    if (!m) throw new Error(`ligne YAML illisible : ${lines[i]!.text.slice(0, 40)}`);
    const key = String(scalar(m[1]!));
    const rest = m[2]?.trim();
    i++;
    if (rest) {
      map[key] = scalar(rest);
    } else if (i < lines.length && (lines[i]!.indent > indent || (lines[i]!.indent === indent && lines[i]!.text.startsWith("- ")))) {
      const [value, next] = parseBlock(lines, i, lines[i]!.indent);
      map[key] = value;
      i = next;
    } else {
      map[key] = null;
    }
  }
  return [map, i];
}

/** Les entrées de `mcp_servers` : une entrée illisible est rendue comme `{ error }` sans empêcher les autres. */
export function readMcpServers(yaml: string): Record<string, unknown> {
  const lines = blockLines(yaml, "mcp_servers");
  if (lines.length === 0) return {};
  const base = lines[0]!.indent;
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    // une entrée = sa ligne `nom:` et les lignes plus indentées qui la suivent
    const head = lines[i]!;
    if (head.indent !== base) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end]!.indent > base) end++;
    const name = String(scalar(head.text.replace(/:\s*$/, "")));
    try {
      const body = lines.slice(i + 1, end);
      out[name] = body.length === 0 ? {} : parseBlock(body, 0, body[0]!.indent)[0];
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.message : String(e) };
    }
    i = end;
  }
  return out;
}

// ───────────────────────── MCP ─────────────────────────

export interface TokenFile {
  access_token?: unknown;
  token_type?: unknown;
  expires_at?: unknown;
}

export interface McpImportReport {
  servers: McpServerConfig[];
  skipped: { name: string; reason: string }[];
  /** Constats par serveur (sans valeur secrète). */
  notes: string[];
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";

const stringRecord = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && typeof x !== "object").map(([k, x]) => [k, String(x)])) : {};

/**
 * `raw` = `readMcpServers(config.yaml)`, `tokenOf(nom)` = le contenu parsé de `mcp-tokens/<nom>.json` (ou undefined), `existing` = les
 * serveurs déjà configurés dans Jarod (un nom déjà pris n'est jamais remplacé). Tout est importé `enabled: false`.
 */
export function mapMcpServers(raw: Record<string, unknown>, tokenOf: (name: string) => TokenFile | undefined, existing: McpServerConfig[], now = Date.now()): McpImportReport {
  const report: McpImportReport = { servers: [], skipped: [], notes: [] };
  const taken = new Set(existing.map((s) => s.id));
  const names = new Set(existing.map((s) => s.name.toLowerCase()));
  for (const [name, value] of Object.entries(raw)) {
    const cfg = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    if (typeof cfg.error === "string") {
      report.skipped.push({ name, reason: `non lisible (${cfg.error})` });
      continue;
    }
    if (names.has(name.toLowerCase())) {
      report.skipped.push({ name, reason: "un serveur de ce nom existe déjà dans Jarod" });
      continue;
    }
    let id = slug(name);
    for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;

    const url = typeof cfg.url === "string" ? cfg.url : undefined;
    const command = typeof cfg.command === "string" ? cfg.command : undefined;
    if (!url && !command) {
      report.skipped.push({ name, reason: "ni commande ni URL" });
      continue;
    }
    const server: McpServerConfig = {
      id,
      name,
      command: command ?? "",
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: stringRecord(cfg.env),
      enabled: false,
    };
    if (url) {
      server.url = url;
      const headers = stringRecord(cfg.headers);
      const token = cfg.auth === "oauth" ? tokenOf(name) : undefined;
      const access = typeof token?.access_token === "string" ? token.access_token : "";
      if (cfg.auth === "oauth") {
        if (!access) report.notes.push(`${name} : OAuth sans jeton chez Hermes, à reconnecter`);
        else {
          if (!Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) headers.Authorization = `${typeof token?.token_type === "string" && token.token_type ? token.token_type[0]!.toUpperCase() + token.token_type.slice(1).toLowerCase() : "Bearer"} ${access}`;
          const expires = typeof token?.expires_at === "number" ? token.expires_at * 1000 : 0;
          report.notes.push(`${name} : jeton d'accès copié${expires && expires < now ? ` — déjà expiré le ${new Date(expires).toISOString().slice(0, 10)} (Jarod ne le renouvelle pas)` : " (Jarod ne le renouvelle pas)"}`);
        }
      }
      if (Object.keys(headers).length > 0) server.headers = headers;
    } else if (command && isAbsolute(command) && !existsSync(command)) {
      report.notes.push(`${name} : la commande ${command} n'existe pas sur cette machine`);
    }
    const tools = cfg.tools && typeof cfg.tools === "object" ? Object.keys(cfg.tools) : [];
    if (tools.length > 0) report.notes.push(`${name} : filtre d'outils (${tools.join(", ")}) non repris, Jarod n'en a pas`);
    taken.add(id);
    names.add(name.toLowerCase());
    report.servers.push(server);
  }
  return report;
}

// ───────────────────────── skills ─────────────────────────

export interface SkillFolder {
  id: string;
  /** Chemin relatif POSIX depuis la racine des skills ("creative/ascii-art"). */
  rel: string;
  path: string;
}

/** Même découverte que `SkillRegistry` : en largeur, un dossier avec `SKILL.md` est un skill (on n'y descend pas), les dossiers `.xxx` sont ignorés. */
export async function discoverSkillFolders(root: string): Promise<SkillFolder[]> {
  const found: SkillFolder[] = [];
  let level = [""];
  for (let depth = 1; depth <= MAX_SKILL_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    const here: SkillFolder[] = [];
    for (const rel of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(rel ? join(root, ...rel.split("/")) : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const sub = rel ? `${rel}/${e.name}` : e.name;
        const dir = join(root, ...sub.split("/"));
        if (existsSync(join(dir, "SKILL.md"))) here.push({ id: e.name, rel: sub, path: dir });
        else next.push(sub);
      }
    }
    found.push(...here.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)));
    level = next;
  }
  return found;
}

export interface SkillPlan {
  copy: SkillFolder[];
  /** Même identifiant déjà présent (dans Jarod ou dans une source précédente) : rien n'est copié. */
  duplicates: { id: string; rel: string; keptFrom: string }[];
  /** Le dossier d'arrivée existe déjà. */
  present: string[];
}

/** `sources` dans l'ordre de priorité (le premier gagne), `existingIds` = les skills déjà chez Jarod, `exists(rel)` = le dossier d'arrivée existe. */
export function planSkills(sources: { label: string; folders: SkillFolder[] }[], existingIds: Set<string>, exists: (rel: string) => boolean): SkillPlan {
  const plan: SkillPlan = { copy: [], duplicates: [], present: [] };
  const origin = new Map<string, string>();
  for (const { label, folders } of sources) {
    for (const f of folders) {
      if (existingIds.has(f.id)) plan.duplicates.push({ id: f.id, rel: f.rel, keptFrom: "Jarod" });
      else if (origin.has(f.id)) plan.duplicates.push({ id: f.id, rel: f.rel, keptFrom: origin.get(f.id)! });
      else if (exists(f.rel)) plan.present.push(f.rel);
      else {
        origin.set(f.id, `${label}/${f.rel}`);
        plan.copy.push(f);
      }
    }
  }
  return plan;
}

// ───────────────────────── orchestration ─────────────────────────

/** Ce dont l'import a besoin du cœur (un sous-ensemble de `CliCore`, simple à simuler dans les tests). */
export interface ImportTarget {
  settings: {
    get(key: "mcpServers"): McpServerConfig[];
    get(key: "disabledSkills"): string[];
    set(key: "mcpServers", value: McpServerConfig[]): void;
    set(key: "disabledSkills", value: string[]): void;
  };
  skills: { dir: string; list(): { id: string }[]; reload(): Promise<unknown> };
}

export interface ImportOptions {
  hermesHome: string;
  /** Autres dossiers de skills Hermes (`~/.hermes/skills`), après celui de `hermesHome`. */
  extraSkillRoots?: string[];
  apply: boolean;
}

export interface ImportResult {
  skills: SkillPlan & { copied: number; disabled: number };
  mcp: McpImportReport;
}

export async function importFromHermes(target: ImportTarget, options: ImportOptions): Promise<ImportResult> {
  await target.skills.reload();
  const roots = [join(options.hermesHome, "skills"), ...(options.extraSkillRoots ?? [])].filter((r) => existsSync(r));
  const sources = [];
  for (const root of roots) sources.push({ label: root, folders: await discoverSkillFolders(root) });
  const plan = planSkills(sources, new Set(target.skills.list().map((s) => s.id)), (rel) => existsSync(join(target.skills.dir, ...rel.split("/"))));

  const yamlPath = join(options.hermesHome, "config.yaml");
  const raw = existsSync(yamlPath) ? readMcpServers(await readFile(yamlPath, "utf8")) : {};
  const tokenOf = (name: string): TokenFile | undefined => {
    try {
      const file = join(options.hermesHome, "mcp-tokens", `${name}.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as TokenFile) : undefined;
    } catch {
      return undefined;
    }
  };
  const mcp = mapMcpServers(raw, tokenOf, target.settings.get("mcpServers"));

  const result: ImportResult = { skills: { ...plan, copied: 0, disabled: 0 }, mcp };
  if (!options.apply) return result;

  for (const f of plan.copy) {
    await cp(f.path, join(target.skills.dir, ...f.rel.split("/")), { recursive: true, errorOnExist: true, force: false });
    result.skills.copied++;
  }
  const disabled = new Set(target.settings.get("disabledSkills"));
  for (const f of plan.copy) if (!disabled.has(f.id)) (disabled.add(f.id), result.skills.disabled++);
  target.settings.set("disabledSkills", [...disabled]);
  if (mcp.servers.length > 0) target.settings.set("mcpServers", [...target.settings.get("mcpServers"), ...mcp.servers]);
  await target.skills.reload();
  return result;
}
