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
    // V-14 : une liste `include` de noms exacts devient la liste blanche du serveur ; un `exclude` ou un motif (`*`) demanderait les noms
    // réels des outils (connexion au serveur) : il n'est pas deviné, il est signalé.
    const filter = cfg.tools && typeof cfg.tools === "object" && !Array.isArray(cfg.tools) ? (cfg.tools as Record<string, unknown>) : undefined;
    if (filter) {
      const include = Array.isArray(filter.include) ? filter.include.map(String) : undefined;
      const exact = include?.every((t) => t && !/[*?[\]]/.test(t));
      if (include && exact && Object.keys(filter).every((k) => k === "include")) server.allowedTools = [...new Set(include)].sort();
      else report.notes.push(`${name} : filtre d'outils (${Object.keys(filter).join(", ")}) non repris tel quel : choisir les outils dans Réglages › Serveurs MCP › Outils`);
    }
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

// ───────────────────────── mémoire (V-15) ─────────────────────────

/** Séparateur des entrées de `memories/MEMORY.md` et `USER.md` (Hermes `tools/memory_tool_store.py:23`). */
export const MEMORY_DELIMITER = "\n§\n";

/** Les entrées d'un fichier de mémoire Hermes, sans les vides. */
export function readMemoryEntries(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(MEMORY_DELIMITER)
    .map((e) => e.trim())
    .filter(Boolean);
}

export interface MemoryPlan {
  /** `MEMORY.md` → faits, `USER.md` → préférences (ce que l'agent sait de la personne). */
  add: { content: string; type: "fact" | "preference" }[];
  /** Entrées déjà présentes à l'identique dans Jarod (ou deux fois chez Hermes) : rien n'est ajouté. */
  present: number;
}

export function planMemory(entries: { fact: string[]; preference: string[] }, existing: ReadonlySet<string>): MemoryPlan {
  const plan: MemoryPlan = { add: [], present: 0 };
  const seen = new Set(existing);
  for (const type of ["fact", "preference"] as const)
    for (const content of entries[type]) {
      if (seen.has(content)) plan.present++;
      else (seen.add(content), plan.add.push({ content, type }));
    }
  return plan;
}

// ───────────────────────── persona (V-15) ─────────────────────────

export type PersonaPlan = { action: "write"; chars: number } | { action: "skip"; reason: string };

/** `SOUL.md` de Hermes → persona de Jarod, seulement quand Jarod n'en a pas : une persona existante n'est jamais remplacée. */
export function planPersona(soul: string | undefined, current: string): PersonaPlan {
  const text = soul?.trim() ?? "";
  if (!text) return { action: "skip", reason: "SOUL.md absent ou vide chez Hermes" };
  if (current.trim()) return { action: "skip", reason: "Jarod a déjà une persona (jamais remplacée)" };
  return { action: "write", chars: text.length };
}

// ───────────────────────── tâches planifiées (V-15) ─────────────────────────

type Gateway = "telegram" | "discord" | "slack";
const GATEWAYS: Gateway[] = ["telegram", "discord", "slack"];

/** Ce qu'une tâche Hermes devient : un `Scheduler.save` de Jarod, toujours désactivé. */
export interface CronDraft {
  name: string;
  prompt: string;
  spec: { kind: "cron"; expr: string } | { kind: "interval"; minutes: number } | { kind: "once"; at: number };
  deliver: { gateway: Gateway; chatId: string } | null;
}

export interface CronPlan {
  add: CronDraft[];
  skipped: { name: string; reason: string }[];
  notes: string[];
}

/**
 * `jobs` = le contenu de `cron/jobs.json` (`{ jobs: [...] }`), `existingNames` = les tâches de Jarod (un nom pris n'est jamais remplacé),
 * `home` = le canal d'accueil de chaque passerelle chez Hermes (une livraison « telegram » sans chat va là).
 */
export function planCron(jobs: unknown, existingNames: ReadonlySet<string>, home: Partial<Record<Gateway, string>>): CronPlan {
  const plan: CronPlan = { add: [], skipped: [], notes: [] };
  const list = jobs && typeof jobs === "object" && Array.isArray((jobs as { jobs?: unknown }).jobs) ? ((jobs as { jobs: unknown[] }).jobs as Record<string, unknown>[]) : [];
  const names = new Set([...existingNames].map((n) => n.toLowerCase()));
  let ownModel = 0;
  for (const job of list) {
    if (!job || typeof job !== "object") continue;
    const name = typeof job.name === "string" && job.name.trim() ? job.name.trim() : String(job.id ?? "tâche");
    const prompt = typeof job.prompt === "string" ? job.prompt.trim() : "";
    if (job.script || job.no_agent === true) {
      plan.skipped.push({ name, reason: "script sans agent : Jarod ne lance pas de script planifié" });
      continue;
    }
    if (!prompt) {
      plan.skipped.push({ name, reason: "consigne vide" });
      continue;
    }
    if (names.has(name.toLowerCase())) {
      plan.skipped.push({ name, reason: "une tâche de ce nom existe déjà dans Jarod" });
      continue;
    }
    const s = job.schedule && typeof job.schedule === "object" ? (job.schedule as Record<string, unknown>) : {};
    let spec: CronDraft["spec"] | undefined;
    if (s.kind === "cron" && typeof s.expr === "string" && s.expr.trim().split(/\s+/).length === 5) spec = { kind: "cron", expr: s.expr.trim() };
    else if (s.kind === "interval" && typeof s.minutes === "number" && s.minutes >= 1) spec = { kind: "interval", minutes: Math.round(s.minutes) };
    else if (s.kind === "once" && typeof s.run_at === "string" && !Number.isNaN(Date.parse(s.run_at))) spec = { kind: "once", at: Date.parse(s.run_at) };
    if (!spec) {
      plan.skipped.push({ name, reason: `horaire non repris (${String(s.kind ?? "absent")})` });
      continue;
    }
    let deliver: CronDraft["deliver"] = null;
    const raw = typeof job.deliver === "string" ? job.deliver.trim() : "";
    if (raw && raw !== "local") {
      const [gateway, ...rest] = raw.split(":");
      const chatId = rest.join(":").trim() || home[gateway as Gateway];
      if (GATEWAYS.includes(gateway as Gateway) && chatId) deliver = { gateway: gateway as Gateway, chatId };
      else plan.notes.push(`${name} : livraison « ${raw} » non reprise (${GATEWAYS.includes(gateway as Gateway) ? "pas de canal d'accueil connu" : "passerelle absente de Jarod"}) : la réponse reste dans Jarod`);
    }
    if (typeof job.model === "string" && job.model) ownModel++;
    names.add(name.toLowerCase());
    plan.add.push({ name, prompt, spec, deliver });
  }
  if (ownModel) plan.notes.push(`${ownModel} tâche(s) avaient leur propre modèle chez Hermes : dans Jarod, elles utilisent le modèle actif`);
  return plan;
}

// ───────────────────────── bots (V-15) ─────────────────────────

/** Les seules variables lues dans le `.env` de Hermes : des listes d'identifiants et des canaux. Les jetons ne sont que DÉTECTÉS. */
const BOT_ENV = {
  telegram: { token: "TELEGRAM_BOT_TOKEN", allowed: "TELEGRAM_ALLOWED_USERS", home: "TELEGRAM_HOME_CHANNEL" },
  discord: { token: "DISCORD_BOT_TOKEN", allowed: "DISCORD_ALLOWED_USERS", home: "DISCORD_HOME_CHANNEL" },
  slack: { token: "SLACK_BOT_TOKEN", allowed: "SLACK_ALLOWED_USERS", home: "SLACK_HOME_CHANNEL" },
} as const;

/** `KEY=valeur` d'un `.env`, pour les clés demandées seulement (guillemets retirés). Une clé de jeton n'y figure jamais : voir `hasKey`. */
export function readDotEnv(text: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || !keys.includes(m[1]!)) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** La clé est-elle définie (non vide) dans le `.env` ? La valeur n'est jamais rendue. */
export function hasKey(text: string, key: string): boolean {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*\\S`, "m").test(text);
}

export interface BotPlan {
  /** Listes d'accès à poser : seulement quand celle de Jarod est vide (jamais fusionnée ni remplacée) ; la passerelle reste éteinte. */
  allow: { gateway: Gateway; ids: string[] }[];
  home: Partial<Record<Gateway, string>>;
  notes: string[];
}

export function planBots(envText: string, configHome: Partial<Record<Gateway, string>>, current: Record<Gateway, string[]>): BotPlan {
  const plan: BotPlan = { allow: [], home: { ...configHome }, notes: [] };
  const values = readDotEnv(envText, GATEWAYS.flatMap((g) => [BOT_ENV[g].allowed, BOT_ENV[g].home]));
  for (const g of GATEWAYS) {
    const home = values[BOT_ENV[g].home]?.trim();
    if (home) plan.home[g] = home;
    const ids = [...new Set((values[BOT_ENV[g].allowed] ?? "").split(/[\s,]+/).filter((x) => /^[A-Za-z0-9_@.-]{1,64}$/.test(x)))];
    const token = hasKey(envText, BOT_ENV[g].token);
    if (!token && !ids.length) continue;
    if (ids.length && current[g].length) plan.notes.push(`${g} : Jarod a déjà sa liste d'accès, celle de Hermes n'est pas reprise`);
    else if (ids.length) plan.allow.push({ gateway: g, ids });
    if (token) plan.notes.push(`${g} : jeton présent chez Hermes, NON copié : le saisir dans Réglages › Messagerie pour activer la passerelle`);
  }
  if (plan.allow.some((a) => a.gateway === "telegram")) plan.notes.push("telegram : Hermes liste des utilisateurs, Jarod des chats ; en conversation privée, c'est le même identifiant");
  return plan;
}

/** Le canal d'accueil écrit en clé de premier niveau de `config.yaml` (`TELEGRAM_HOME_CHANNEL: …`). */
export function configHomeChannels(yaml: string): Partial<Record<Gateway, string>> {
  const out: Partial<Record<Gateway, string>> = {};
  for (const g of GATEWAYS) {
    const m = new RegExp(`^${BOT_ENV[g].home}:\\s*(.+?)\\s*$`, "m").exec(yaml);
    const v = m ? scalar(m[1]!) : null;
    if (v !== null && v !== "") out[g] = String(v);
  }
  return out;
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
  /** V-15 : les parties suivantes sont importées quand le cœur les a (absentes : la partie est dite « non disponible »). */
  memory?: { list(): { content: string }[]; add(content: string, type: "fact" | "preference"): unknown };
  persona?: { read(): string; write(text: string): void };
  scheduler?: { list(): { name: string }[]; save(input: CronDraft & { enabled: boolean }): unknown };
  bots?: {
    get(key: Gateway): { allowedChatIds?: string[]; allowedUserIds?: string[] } & Record<string, unknown>;
    set(key: Gateway, value: Record<string, unknown>): void;
  };
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
  /** V-15 : `null` = le cœur n'a pas ce service. */
  memory: (MemoryPlan & { added: number }) | null;
  persona: (PersonaPlan & { written: boolean }) | null;
  cron: (CronPlan & { created: number }) | null;
  bots: (BotPlan & { applied: number }) | null;
}

const readIf = (file: string): string | undefined => {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

const allowKey = (g: Gateway): "allowedChatIds" | "allowedUserIds" => (g === "telegram" ? "allowedChatIds" : "allowedUserIds");

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

  // V-15 : mémoire, persona, bots (avant les tâches : leur canal d'accueil sert aux livraisons), tâches planifiées.
  const memoryDir = join(options.hermesHome, "memories");
  const memory = target.memory
    ? planMemory(
        { fact: readMemoryEntries(readIf(join(memoryDir, "MEMORY.md")) ?? ""), preference: readMemoryEntries(readIf(join(memoryDir, "USER.md")) ?? "") },
        new Set(target.memory.list().map((m) => m.content)),
      )
    : null;
  const persona = target.persona ? planPersona(readIf(join(options.hermesHome, "SOUL.md")), target.persona.read()) : null;
  const yaml = readIf(yamlPath) ?? "";
  const bots = target.bots
    ? planBots(readIf(join(options.hermesHome, ".env")) ?? "", configHomeChannels(yaml), {
        telegram: target.bots.get("telegram").allowedChatIds ?? [],
        discord: target.bots.get("discord").allowedUserIds ?? [],
        slack: target.bots.get("slack").allowedUserIds ?? [],
      })
    : null;
  let jobs: unknown = null;
  try {
    jobs = JSON.parse(readIf(join(options.hermesHome, "cron", "jobs.json")) ?? "null");
  } catch {
    jobs = null;
  }
  const cron = target.scheduler ? planCron(jobs, new Set(target.scheduler.list().map((s) => s.name)), bots?.home ?? configHomeChannels(yaml)) : null;

  const result: ImportResult = {
    skills: { ...plan, copied: 0, disabled: 0 },
    mcp,
    memory: memory && { ...memory, added: 0 },
    persona: persona && { ...persona, written: false },
    cron: cron && { ...cron, created: 0 },
    bots: bots && { ...bots, applied: 0 },
  };
  if (!options.apply) return result;

  if (memory && target.memory && result.memory) for (const m of memory.add) (target.memory.add(m.content, m.type), result.memory.added++);
  if (persona?.action === "write" && target.persona && result.persona) {
    target.persona.write(readIf(join(options.hermesHome, "SOUL.md")) ?? "");
    result.persona.written = true;
  }
  if (bots && target.bots && result.bots)
    for (const a of bots.allow) {
      // La passerelle reste éteinte : la liste d'accès est posée, l'activation et le jeton restent un geste de la personne.
      target.bots.set(a.gateway, { ...target.bots.get(a.gateway), enabled: false, [allowKey(a.gateway)]: a.ids });
      result.bots.applied++;
    }
  if (cron && target.scheduler && result.cron)
    for (const draft of cron.add) {
      try {
        target.scheduler.save({ ...draft, enabled: false });
        result.cron.created++;
      } catch (e) {
        result.cron.skipped.push({ name: draft.name, reason: `refusée par Jarod : ${(e as Error).message}` });
      }
    }

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
