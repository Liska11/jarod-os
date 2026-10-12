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
}

export interface ToolInfo {
  name: string;
  description: string;
  dangerous: boolean;
  source: ToolDef["source"];
  enabled: boolean;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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

  register(tool: ToolDef): () => void {
    if (!NAME_RE.test(tool.name)) throw new Error(`Nom d'outil invalide : ${tool.name}`);
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
