// Passerelle compatible Hermes (essai) : ce que la section « Hermes & agents » des Réglages de Herald demande — le choix du modèle, le niveau d'autonomie,
// les groupes d'outils, l'endroit où s'exécutent les agents — et les commandes `/`. Tout est une TRADUCTION de réglages et de services que Jarod a déjà :
//   modèle / fournisseurs  ↔ `core.providers`, `activeProvider`, `activeModel`
//   autonomie              ↔ `autoApproveTools` (seul « manuel » se règle d'ici, voir `setApprovalMode`)
//   groupes d'outils       ↔ les outils du registre, regroupés par famille, et `disabledTools`
//   commandes `/`          ↔ `core.commands`
// Pur : des ports minces à la place du noyau, donc testable avec des faux et avec le vrai noyau.

import { redactText } from "@jarod/kernel/redact";
import { NON_CHAT_PROVIDERS } from "./discovery.js";

export interface SettingsPort {
  get(key: string): unknown;
  patch(p: Record<string, unknown>): void;
}

export interface ProviderLike {
  id: string;
  name: string;
  models: readonly string[];
  baseUrl: string;
  local?: boolean;
  configured: boolean;
}

export interface ToolLike {
  name: string;
}

export interface CommandResultLike {
  text?: string;
  action?: string;
  payload?: string;
}

export interface CommandRegistryLike {
  list(): { name: string; description: string; usage?: string }[];
  execute(input: string, ctx: { sessionId: string | null }): Promise<CommandResultLike | null>;
}

/** Une erreur que le serveur renvoie telle quelle au shell (JSON-RPC -32602 ou HTTP 400). */
export class ConfigError extends Error {}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// --- modèle ------------------------------------------------------------------------------------------------

export interface ModelOptionProvider {
  slug: string;
  name: string;
  models: string[];
  total_models: number;
  is_current: boolean;
  authenticated: boolean;
  api_url: string;
  auth_type: "api_key" | "none";
  source: "jarod";
}

/** `model.options` : les fournisseurs (configurés seulement, sauf demande contraire) avec leurs modèles, et le modèle actif. Les fournisseurs qui ne conversent pas (Whisper local) sont absents. */
export function modelOptions(providers: readonly ProviderLike[], settings: SettingsPort, includeUnconfigured: boolean): { providers: ModelOptionProvider[]; model: string; provider: string } {
  const provider = str(settings.get("activeProvider"));
  const model = str(settings.get("activeModel"));
  const rows = providers
    .filter((p) => !NON_CHAT_PROVIDERS.has(p.id) && (includeUnconfigured || p.configured))
    .map((p) => ({
      slug: p.id,
      name: p.name,
      models: [...p.models],
      total_models: p.models.length,
      is_current: p.id === provider,
      authenticated: p.configured,
      api_url: p.baseUrl,
      auth_type: p.local ? ("none" as const) : ("api_key" as const),
      source: "jarod" as const,
    }));
  return { providers: rows, model, provider };
}

/** « fournisseur:modèle », « fournisseur/modèle » ou « modèle » seul → les réglages à écrire. */
export function parseModelChoice(value: string, providers: readonly ProviderLike[], current: string): { activeProvider: string; activeModel: string } {
  const text = value.trim();
  if (!text) throw new ConfigError("Modèle vide");
  for (const sep of [":", "/"]) {
    const i = text.indexOf(sep);
    if (i > 0) {
      const id = text.slice(0, i);
      if (providers.some((p) => p.id === id)) return { activeProvider: id, activeModel: text.slice(i + 1) };
    }
  }
  return { activeProvider: current, activeModel: text };
}

/**
 * Herald choisit un modèle par `/model fournisseur:modèle`, mais `/model` de Jarod lit `fournisseur/modèle`: avec les deux-points il poserait tout le texte comme
 * NOM de modèle sur l'ancien fournisseur (le choix « réussit » et le modèle est inutilisable). On réécrit donc le seul cas sans ambiguïté : un premier segment
 * qui est un identifiant de fournisseur connu. Un nom de modèle qui contient lui-même « : » (`qwen3.5:0.8b`) ou « / » reste intact.
 */
export function normalizeModelCommand(command: string, providers: readonly ProviderLike[]): string {
  const m = /^\/model\s+(\S+)\s*$/i.exec(command);
  if (!m) return command;
  const arg = m[1]!;
  const i = arg.indexOf(":");
  if (i > 0 && i < arg.length - 1 && providers.some((p) => p.id === arg.slice(0, i))) return `/model ${arg.slice(0, i)}/${arg.slice(i + 1)}`;
  return command;
}

// --- autonomie ---------------------------------------------------------------------------------------------

export type ApprovalMode = "manual" | "smart" | "off";

/** L'autonomie que Herald montre : « Ask first » si l'approbation automatique est coupée, « Independent » si elle est allumée. Jarod n'a pas de palier intermédiaire. */
export function approvalMode(settings: SettingsPort): ApprovalMode {
  return settings.get("autoApproveTools") === true ? "off" : "manual";
}

/**
 * Seul « manuel » se règle d'ici. Allumer l'approbation automatique de Jarod (« accord automatique ») est une décision de sécurité qui a sa propre
 * confirmation native dans l'application Jarod ; un clic dans un autre shell ne la remplace pas.
 */
export function setApprovalMode(value: unknown, settings: SettingsPort): ApprovalMode {
  const mode = str(value).toLowerCase();
  if (mode === "manual") {
    settings.patch({ autoApproveTools: false });
    return "manual";
  }
  if (mode === "smart" || mode === "off") {
    throw new ConfigError("Jarod règle l'approbation automatique dans son propre écran de réglages (avec sa confirmation) : à changer dans l'application Jarod. D'ici, seul « Ask first » est possible.");
  }
  throw new ConfigError(`Mode inconnu : ${JSON.stringify(value)} (manual, smart, off)`);
}

// --- config.get / config.set ---------------------------------------------------------------------------------

export function configGet(key: string, settings: SettingsPort, providers: readonly ProviderLike[]): Record<string, unknown> {
  switch (key) {
    case "approvals.mode":
      return { value: approvalMode(settings) };
    case "model":
      return { value: str(settings.get("activeModel")), model: str(settings.get("activeModel")), provider: str(settings.get("activeProvider")) };
    case "provider":
      return {
        model: str(settings.get("activeModel")),
        provider: str(settings.get("activeProvider")),
        providers: providers.map((p) => ({ id: p.id, label: p.name, authenticated: p.configured })),
      };
    case "full":
      return { config: hermesConfig(settings) };
    default:
      throw new ConfigError(`Clé de configuration non portée par la passerelle de Jarod : ${key}`);
  }
}

export function configSet(key: string, value: unknown, settings: SettingsPort, providers: readonly ProviderLike[]): Record<string, unknown> {
  if (key === "approvals.mode") return { key, value: setApprovalMode(value, settings), enabled: true };
  if (key === "model") {
    const choice = parseModelChoice(str(value), providers, str(settings.get("activeProvider")));
    settings.patch(choice);
    return { key, value: `${choice.activeProvider}:${choice.activeModel}`, enabled: true };
  }
  throw new ConfigError(`Clé de configuration non portée par la passerelle de Jarod : ${key}`);
}

// --- GET / PUT /api/config -----------------------------------------------------------------------------------

/** Les parties de la configuration de Hermes que les pages lisent. Le nombre d'agents en parallèle est une borne de Jarod (3), pas un réglage. */
export function hermesConfig(settings: SettingsPort): Record<string, unknown> {
  return {
    model: { provider: str(settings.get("activeProvider")), default: str(settings.get("activeModel")) },
    delegation: { max_concurrent_children: 3 },
    approvals: { mode: approvalMode(settings) },
  };
}

/**
 * `GET /api/config/raw` : le « config.yaml » que le shell lit pour savoir quel fournisseur est actif (`model.provider`). Jarod n'a pas de config.yaml : le
 * modèle est un réglage du profil. Ce YAML en est une VUE en lecture seule, limitée à `model.provider` et `model.default` ; rien d'autre n'y entre (ni
 * adresse, ni clé, ni réglage), et chaque valeur passe par `redactText` au cas où un réglage contiendrait une clé collée par erreur.
 */
export function configRaw(settings: Pick<SettingsPort, "get">): { yaml: string } {
  const quote = (v: string): string => JSON.stringify(redactText(v)); // une chaîne JSON est un scalaire YAML entre guillemets valide
  const provider = str(settings.get("activeProvider"));
  const model = str(settings.get("activeModel"));
  const lines = ["model:", ...(provider ? [`  provider: ${quote(provider)}`] : []), ...(model ? [`  default: ${quote(model)}`] : [])];
  return { yaml: `${lines.join("\n")}\n` };
}

export const CONFIG_RAW_READ_ONLY = "Le config.yaml de Hermes n'existe pas dans Jarod : le modèle se règle par « Preferred model » (ou PUT /api/config). L'écriture du YAML brut n'est pas portée.";

/**
 * `PUT /api/config` : applique ce que la passerelle sait écrire (`model`), refuse le reste par son nom. Rien n'est appliqué si une seule clé est refusée
 * (tout ou rien) : le shell ne doit pas croire qu'un réglage a été pris.
 */
export function applyConfigPatch(patch: unknown, settings: SettingsPort, providers: readonly ProviderLike[]): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConfigError("config doit être un objet");
  const p = patch as Record<string, unknown>;
  const unsupported = Object.keys(p).filter((k) => k !== "model");
  if (unsupported.length) throw new ConfigError(`Non porté par la passerelle de Jarod : ${unsupported.join(", ")}`);
  const m = p.model as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") throw new ConfigError("model doit être un objet");
  const provider = str(m.provider);
  const model = str(m.default) || str(m.model);
  const known = providers.some((x) => x.id === provider);
  if (!known && provider) throw new ConfigError(`Fournisseur inconnu : ${provider}`);
  const next: Record<string, unknown> = {};
  if (provider) next.activeProvider = provider;
  if (model) next.activeModel = model;
  if (Object.keys(next).length === 0) throw new ConfigError("model: ni fournisseur ni modèle donné");
  settings.patch(next);
}

// --- groupes d'outils ------------------------------------------------------------------------------------------

interface Family {
  name: string;
  label: string;
  description: string;
  match: (tool: string) => boolean;
}

const startsWith = (...prefixes: string[]) => (t: string) => prefixes.some((p) => t === p || t.startsWith(p));

/** Dans l'ordre : le premier qui reconnaît le nom l'emporte. Le dernier recueille le reste. */
const FAMILIES: readonly Family[] = [
  { name: "memory", label: "Memory", description: "Remember and recall facts and preferences.", match: startsWith("memory_", "user_profile", "annotat", "state_") },
  { name: "system", label: "This computer", description: "Look at and control this computer: processes, disks, network, apps, volume, files.", match: startsWith("system_") },
  { name: "files", label: "Files", description: "Read, search and edit files in the working folder.", match: startsWith("read_file", "write_file", "edit_file", "list_dir", "search_files", "find_files", "diff_numbered", "rag_") },
  { name: "terminal", label: "Terminal", description: "Run commands.", match: startsWith("run_shell", "android_") },
  { name: "web", label: "Web", description: "Search and fetch the web, call APIs.", match: startsWith("web_", "http_request", "browser_") },
  { name: "agents", label: "Agents", description: "Delegate work to sub-agents.", match: startsWith("delegate_task", "spawn_subagent", "subagent_") },
  { name: "automation", label: "Automation", description: "Scheduled tasks and event rules.", match: startsWith("cronjob", "automation_") },
  { name: "skills", label: "Skills", description: "Load and manage skills.", match: startsWith("load_skill", "read_skill_file", "skill_", "tool_search") },
  { name: "code", label: "Code", description: "Diagnostics and navigation in a codebase.", match: startsWith("code_", "refine") },
  { name: "other", label: "Other tools", description: "Everything else.", match: () => true },
];

export interface ToolsetRow {
  name: string;
  label: string;
  description: string;
  platform: string;
  platform_label: string;
  enabled: boolean;
  available: boolean;
  configured: boolean;
  tools: string[];
}

const familyOf = (tool: string): Family => FAMILIES.find((f) => f.match(tool))!;

/** Les groupes d'outils présents au registre. Un groupe est activé tant qu'aucun de ses outils n'est dans `disabledTools`. */
export function toolsets(tools: readonly ToolLike[], disabled: readonly string[]): ToolsetRow[] {
  const off = new Set(disabled);
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    const f = familyOf(t.name);
    groups.set(f.name, [...(groups.get(f.name) ?? []), t.name]);
  }
  return FAMILIES.filter((f) => groups.has(f.name)).map((f) => {
    const names = groups.get(f.name)!.sort();
    return {
      name: f.name,
      label: f.label,
      description: f.description,
      platform: "jarod",
      platform_label: "Jarod",
      enabled: names.every((n) => !off.has(n)),
      available: true,
      configured: true,
      tools: names,
    };
  });
}

/** Le nouveau `disabledTools` après avoir activé ou coupé un groupe ; les entrées qui ne sont pas de ce groupe sont conservées. */
export function setToolsetEnabled(name: string, enabled: boolean, tools: readonly ToolLike[], disabled: readonly string[]): string[] {
  const members = new Set(tools.filter((t) => familyOf(t.name).name === name).map((t) => t.name));
  if (members.size === 0) throw new ConfigError(`Groupe d'outils inconnu : ${name}`);
  const rest = disabled.filter((d) => !members.has(d));
  return enabled ? rest : [...rest, ...[...members].sort()];
}

// --- où s'exécutent les agents ---------------------------------------------------------------------------------

/** Jarod exécute sur cet ordinateur ; les autres terrains (Docker, SSH, cloud) n'y sont pas portés. */
export function terminalBackends(): { active: string; backends: Record<string, unknown>[] } {
  return { active: "local", backends: [{ name: "local", label: "This device", description: "Runs on this computer.", active: true, status: "ready" }] };
}

export function checkTerminalBackend(body: unknown): void {
  const name = str((body as { backend?: unknown } | null)?.backend);
  if (name !== "local") throw new ConfigError(`Terrain d'exécution non porté par la passerelle de Jarod : ${name || "(vide)"}. Seul « local » existe.`);
}

// --- commandes `/` ---------------------------------------------------------------------------------------------

/** Le résultat d'une commande de Jarod dans la forme de `slash.exec`. Une action d'interface n'a pas d'équivalent : le texte seul est rendu. */
export function slashResult(result: CommandResultLike | null, command: string): Record<string, unknown> {
  if (!result) return { output: `Commande inconnue : ${command}` };
  const out: Record<string, unknown> = { output: result.text ?? "" };
  if (result.action === "send" && result.payload) {
    out.type = "send";
    out.message = result.payload;
  } else if (result.action === "undo" && result.payload) {
    out.type = "prefill";
    out.message = result.payload;
  }
  return out;
}

/**
 * Les commandes `/` qui changent la posture de sécurité de Jarod et ne s'exécutent donc JAMAIS sans la voie gardée (règle, accord, audit) : la confiance donnée
 * aux outils de plugin (`plugin`), l'installation de contenu depuis le réseau (`hub`), la levée du mode Plan (`build`), le dossier où l'agent peut écrire
 * (`workspace`), la suppression de fichiers par retour en arrière (`rewind`), le prompt système (`persona`) et le ménage des skills (`curator`).
 * Les autres (modèle, aide, état, nouvelle conversation…) sont celles du composer : l'utilisateur en est le principal.
 */
export const GUARDED_COMMANDS: ReadonlySet<string> = new Set(["plugin", "hub", "build", "workspace", "rewind", "persona", "curator"]);

/** `commands.catalog` : les commandes de Jarod comme complétions. */
export function commandCatalog(commands: CommandRegistryLike): Record<string, unknown> {
  const list = commands.list();
  return {
    pairs: list.map((c) => [`/${c.name}`, c.description]),
    sub: {},
    canon: {},
    commands: Object.fromEntries(list.map((c) => [c.name, { argument_mode: c.usage ? "text" : null }])),
    categories: [{ name: "Jarod", pairs: list.map((c) => [`/${c.name}`, c.description]) }],
    skills: {},
    skill_count: 0,
  };
}
