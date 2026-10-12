// Portage de packages/core/src/services/commands.ts (rév. 2e180305).
export type CommandAction = "new-session" | "clear" | "retry" | "undo" | "open-settings" | "refresh" | "send";

export interface CommandResult {
  /** Markdown shown to the user as a local (non-model) notice. */
  text?: string;
  /** UI action to perform after the command. */
  action?: CommandAction;
  /** For `send`: text to send to the model instead of the raw command. */
  payload?: string;
}

export interface CommandContext {
  sessionId: string | null;
}

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  source: "builtin" | "plugin";
  /**
   * La commande ne change rien (affiche, ou action d'interface) — pour toutes ses formes (`true`) ou
   * pour les arguments donnés (fonction). Non déclaré = a un effet : c'est le défaut sûr, et ce que
   * le garde des commandes distantes (passerelles) refuse sans accord.
   */
  readOnly?: boolean | ((args: string) => boolean);
  run(args: string, ctx: CommandContext): CommandResult | Promise<CommandResult>;
}

export function parseCommand(input: string): { name: string; args: string } | null {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() };
}

/** Vrai si la commande, avec ces arguments, est déclarée sans effet. Non déclaré → faux (fail-closed). */
export function isReadOnlyCommand(cmd: Pick<CommandDef, "readOnly">, args: string): boolean {
  const r = cmd.readOnly;
  return typeof r === "function" ? r(args) : r === true;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDef>();

  register(cmd: CommandDef): () => void {
    this.commands.set(cmd.name, cmd);
    return () => {
      if (this.commands.get(cmd.name) === cmd) this.commands.delete(cmd.name);
    };
  }

  unregisterWhere(pred: (c: CommandDef) => boolean): void {
    for (const [k, c] of this.commands) if (pred(c)) this.commands.delete(k);
  }

  list(): { name: string; description: string; usage?: string; source: CommandDef["source"] }[] {
    return [...this.commands.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, usage, source }) => ({ name, description, source, ...(usage ? { usage } : {}) }));
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  /** Déclare (après coup, en un seul endroit par module) ce qu'une commande peut faire sans effet. */
  declareReadOnly(name: string, readOnly: NonNullable<CommandDef["readOnly"]>): void {
    const cmd = this.commands.get(name);
    if (!cmd) throw new Error(`declareReadOnly : commande /${name} inconnue`);
    cmd.readOnly = readOnly;
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }

  async execute(input: string, ctx: CommandContext): Promise<CommandResult | null> {
    const parsed = parseCommand(input);
    if (!parsed) return null;
    const cmd = this.commands.get(parsed.name);
    if (!cmd) return { text: `Commande inconnue : /${parsed.name}. Tapez /help pour la liste.` };
    try {
      return await cmd.run(parsed.args, ctx);
    } catch (e) {
      return { text: `Erreur /${parsed.name} : ${(e as Error).message}` };
    }
  }
}
