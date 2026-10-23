// Portage de packages/core/src/tools/registry.ts (rév. 2e180305).
import type { ToolSpec } from "@jarod/contracts";
import type { ShellApprover, ShellPolicy } from "@jarod/plugin-permissions";
import type { VaultService } from "@jarod/plugin-rag";

export interface ToolContext {
  sessionId: string;
  workspace: string | null;
  signal?: AbortSignal;
  /**
   * La porte d'approbation EXISTANTE du cœur (celle des outils `dangerous`), quand l'appelant en a
   * une. Un outil qui doit demander un accord nommé la traverse au lieu d'en inventer une seconde.
   */
  approve?: ShellApprover;
  /** Le réglage du garde du shell (Paramètres → `shellGuard`), quand l'appelant le connaît. */
  shellGuard?: Partial<ShellPolicy>;
  /** The credential vault: names for the model, values only where their owner allowed them. */
  vault?: VaultService;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Side-effecting tools (writes, shell…) require user approval unless auto-approve is on. */
  dangerous?: boolean;
  /**
   * Tant que cela rend faux, `ToolRegistry.specs()` ne rend pas l'outil : le modèle ne le voit ni dans sa liste, ni dans `tool_search`,
   * ni dans celle d'un sous-agent (SPECS-P5-UI-PARITE.md § 19). Relu à chaque appel de `specs()` ; une lecture qui lève vaut « absent ».
   * L'outil reste dans `all()` / `info()` / `get()` : seule l'offre au modèle change.
   */
  available?(): boolean;
  /**
   * Un outil qui ne demande aucun accord (pas `dangerous`) mais dont chaque appel laisse une ligne d'audit : qui l'a demandé, avec quels
   * arguments, et si cela a réussi. Pour les lectures qui voient la machine entière (outils système).
   */
  audited?: boolean;
  /**
   * Garde propre à l'outil, appelé APRÈS la validation des arguments et AVANT toute demande d'accord. Lever refuse l'appel sans rien demander
   * (un chemin protégé, une cible interdite : l'utilisateur n'a pas à trancher ce que la politique interdit). Rendre un texte le substitue à la
   * description de l'outil dans la demande d'accord : « Arrêter chrome (pid 123) » dit mieux ce qui va se passer que le mode d'emploi de l'outil.
   * Doit être sans effet de bord : il ne lit que.
   */
  precheck?(args: Record<string, unknown>, ctx: ToolContext): Promise<string | void> | string | void;
  source: "builtin" | "mcp" | "plugin" | "skill";
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /**
   * Crochet appelé APRÈS un `write_file` / `edit_file` réussi (SPECS-P5-LSP.md § 2.1, G2).
   * Reçoit le chemin absolu du fichier modifié ; retourne une note à ajouter au résultat,
   * ou une chaîne vide. Ne doit JAMAIS démarrer un serveur (G2) : n'utiliser que les
   * serveurs déjà lancés. Une erreur dans le crochet ne fait jamais échouer l'écriture.
   */
  after?(file: string, ctx: ToolContext): Promise<string>;
  /**
   * Cockpit, lot 2 : la CIBLE de l'appel (un chemin, une application, une adresse, une commande), lue dans les arguments, pour les règles
   * de permissions par cible. Sans effet de bord. Lever ou rendre une chaîne vide vaut « cible inconnue » : une règle ciblée deny ou ask
   * s'applique alors telle quelle (fail-closed).
   */
  targetOf?(args: Record<string, unknown>): string | undefined;
  /**
   * Autonomie configurable : TOUTES les cibles d'un appel qui en touche plusieurs (un lot de fichiers : sources et destinations). Remplace
   * `targetOf` quand il est présent. Une règle qui autorise ne joue que si elle les couvre toutes ; une règle qui refuse dès qu'elle en couvre une.
   * Lever ou rendre une liste vide vaut « cibles inconnues ».
   */
  targetsOf?(args: Record<string, unknown>): string[];
  /**
   * Autonomie configurable : l'OPÉRATION de l'appel (« metadata », « subtitles », « query »…), pour les règles bornées à une opération. Sans
   * effet de bord ; lever ou rendre une chaîne vide vaut « opération inconnue ».
   */
  operationOf?(args: Record<string, unknown>): string | undefined;
  /**
   * Les opérations que l'outil sait faire mais qu'il n'offre qu'avec une permission EXPLICITE (une règle de l'utilisateur qui couvre l'appel) :
   * sans elle, l'appel est refusé avec la raison et la commande qui l'accorderait. Clé = opération, valeur = pourquoi elle est réservée.
   */
  restrictedOperations?: Readonly<Record<string, string>>;
  /**
   * Cockpit, lot 2 : la PREUVE de l'effet, constatée APRÈS une exécution réussie (un code de retour positif ne suffit pas). Lit seulement.
   * `failed` rend l'appel en erreur ; `unverifiable` dit pourquoi on ne peut pas constater ; lever vaut `unverifiable`.
   */
  verify?(args: Record<string, unknown>, output: string, ctx: ToolContext): Promise<Proof>;
}

/** La preuve d'une action : constatée, en échec, ou impossible à constater — avec ce qui a été observé. */
export interface Proof {
  status: "verified" | "failed" | "unverifiable";
  evidence: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  dangerous: boolean;
  source: ToolDef["source"];
  enabled: boolean;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const SOURCES: ReadonlySet<string> = new Set(["builtin", "mcp", "plugin", "skill"]);

/**
 * Les outils qui ne déclarent PAS `dangerous` et dont l'absence d'accord a été REVUE (2026-10-22) : lectures, état propre de Jarod (mémoire, état,
 * annotations, sous-agents qui repassent par la même porte), lectures auditées du système, accès réseau en lecture que la politique réseau gouverne
 * (`web_search`, `remote_exec` passe par la porte nommée de `ctx.approve`). Un outil NOUVEAU qui oublie de déclarer son risque ne figure pas ici :
 * le registre le tient pour `dangerous` (accord demandé) au lieu de lui accorder silencieusement le privilège d'une lecture. Pour l'ajouter à
 * cette liste : le déclarer explicitement `dangerous: false` est préférable ; la liste ne sert qu'à ne pas réécrire l'historique.
 */
export const REVIEWED_WITHOUT_APPROVAL: ReadonlySet<string> = new Set([
  "android_devices", "browser_back", "browser_close", "browser_handoff", "browser_read", "browser_scroll", "browser_wait", "connected_browser", "annotate_line", "annotation_remove", "annotations_list", "artifact_list", "artifact_register", "automation_get",
  "automation_list", "code_diagnostics", "code_navigate", "cronjob_list", "delegate_task", "diff_numbered", "find_files", "list_dir",
  "load_skill", "memory_save", "memory_search", "output_read", "output_search", "permissions_explain", "pinokio_logs", "pinokio_open",
  "pinokio_search", "pinokio_status", "present", "rag_index", "rag_search", "read_file", "read_skill_file", "refine_history",
  "remote_exec", "search_files", "session_read", "session_search", "skill_hub_search", "spawn_subagent", "state_delete", "state_get",
  "state_list", "state_set", "subagent_cancel", "subagent_list", "subagent_result", "system_apps", "system_disk_usage",
  "system_files_plan", "system_find_files", "system_info", "system_logs", "system_network", "system_processes", "system_state",
  "task_status", "tool_search", "user_profile", "vault_list", "web_search",
]);

/** Sans `available`, toujours offert ; avec, relu maintenant ; une lecture qui lève vaut « absent » (fail-closed). */
function isAvailable(t: ToolDef): boolean {
  if (!t.available) return true;
  try {
    return t.available() === true;
  } catch {
    return false;
  }
}

export const toolName = (raw: string): string => raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  /** Les outils enregistrés sans déclarer leur risque et absents de la liste revue : tenus pour `dangerous`. Pour les tests et le diagnostic. */
  readonly defaultedToDangerous: string[] = [];

  register(tool: ToolDef): () => void {
    if (!NAME_RE.test(tool.name)) throw new Error(`Nom d'outil invalide : ${tool.name}`);
    if (typeof tool.description !== "string" || !tool.description.trim()) throw new Error(`Outil ${tool.name} : description obligatoire`);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) throw new Error(`Outil ${tool.name} : paramètres (schéma JSON) obligatoires`);
    if (!SOURCES.has(tool.source)) throw new Error(`Outil ${tool.name} : origine inconnue (${String(tool.source)})`);
    if (typeof tool.run !== "function") throw new Error(`Outil ${tool.name} : fonction run obligatoire`);
    // Risque non déclaré : jamais un privilège accordé par omission. Un outil revu (liste ci-dessus) garde son comportement historique ;
    // tout autre est tenu pour dangereux, donc soumis à l'accord et aux règles de permissions.
    if (tool.dangerous === undefined && !REVIEWED_WITHOUT_APPROVAL.has(tool.name)) {
      tool.dangerous = true;
      this.defaultedToDangerous.push(tool.name);
    }
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  unregisterWhere(pred: (t: ToolDef) => boolean): void {
    for (const [name, t] of this.tools) if (pred(t)) this.tools.delete(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  specs(disabled: string[]): ToolSpec[] {
    const off = new Set(disabled);
    return this.all()
      .filter((t) => !off.has(t.name) && isAvailable(t))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  info(disabled: string[]): ToolInfo[] {
    const off = new Set(disabled);
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      dangerous: Boolean(t.dangerous),
      source: t.source,
      enabled: !off.has(t.name),
    }));
  }
}

/**
 * Checks model-produced arguments against the top level of a JSON schema (required keys and
 * primitive types). Tool inputs are untrusted output: a truncated or malformed call must be
 * rejected before anything runs.
 */
export function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  if ("__invalid_json__" in args) return "Arguments JSON invalides.";
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (args[key] === undefined || args[key] === null) return `Argument requis manquant : ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = props[key]?.type;
    if (!expected || value === undefined || value === null) continue;
    const types = Array.isArray(expected) ? expected : [expected];
    const actual = Array.isArray(value)
      ? "array"
      : typeof value === "number" && Number.isInteger(value)
        ? "integer"
        : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return `Type invalide pour ${key} : attendu ${types.join("|")}, reçu ${actual}`;
  }
  return null;
}
