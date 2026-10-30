// Q6 (analyse du 29/10) : annuler la dernière action réversible. Idée reprise de Mark-LVI `core/undo.py` (principe seulement, aucun code copié).
//
// Agir puis pouvoir défaire vaut mieux que demander « êtes-vous sûr ? » avant chaque geste. Seule l'action sait ce qu'est son inverse (déplacer A
// vers B → remettre B en A), elle l'enregistre donc elle-même juste APRÈS avoir réussi : une fonction sans argument qui rétablit l'état d'avant.
// Ce qui est central ici : la pile, son ordre, sa borne et l'outil que le modèle appelle. La pile vit dans le processus de la passerelle : elle
// ne survit pas à un redémarrage (une fermeture qui tient l'ancien état d'un fichier n'a pas à traîner sur disque).
//
// Ce n'est PAS `/undo` (annule le dernier échange de la conversation, builtin-commands.ts) : ici on défait un effet sur la machine.
import type { ToolDef } from "../registry.js";

export interface UndoEntry {
  /** Ce qui sera défait, en une phrase (« volume → 30 % »). */
  label: string;
  at: number;
  /** Rétablit l'état d'avant ; rend ce qui a été fait, lève si ce n'est pas possible. */
  reverse(): Promise<string>;
}

/** Environ « cette conversation » : assez pour rattraper une erreur vue quelques commandes plus tard, pas assez pour retenir des états périmés. */
export const UNDO_MAX_DEPTH = 10;

export class UndoStack {
  private readonly entries: UndoEntry[] = [];

  constructor(private readonly max = UNDO_MAX_DEPTH, private readonly now: () => number = Date.now) {}

  push(label: string, reverse: () => Promise<string>): void {
    this.entries.push({ label, at: this.now(), reverse });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  peek(): UndoEntry | undefined {
    return this.entries.at(-1);
  }

  /** Du plus récent au plus ancien. */
  list(): string[] {
    return this.entries.map((e) => e.label).reverse();
  }

  /** Défait la plus récente. Retirée de la pile même en cas d'échec : la retenter rejouerait le même échec. */
  async undoLast(): Promise<string> {
    const e = this.entries.pop();
    if (!e) throw new Error("Rien à annuler : aucune action réversible depuis le démarrage de Jarod.");
    return `Annulé : ${e.label}. ${await e.reverse()}`;
  }
}

/** L'outil que le modèle appelle quand l'utilisateur dit « annule ». Il AGIT : un accord est demandé, comme pour l'action d'origine. */
export function undoTool(stack: UndoStack): ToolDef {
  return {
    name: "undo_last_action",
    description:
      "Annule la DERNIÈRE action réversible faite sur cet ordinateur (volume, mode sombre, déplacement ou renommage de fichiers, dossier créé, copie). À utiliser quand l'utilisateur dit « annule », « remets comme avant », « non, pas ça ». Une mise à la corbeille, une fermeture d'application ou un arrêt de processus ne s'annulent pas ainsi. Pour revenir sur un message de la conversation, c'est /undo, pas cet outil.",
    parameters: { type: "object", properties: {} },
    dangerous: true,
    audited: true,
    source: "builtin",
    precheck() {
      const e = stack.peek();
      if (!e) throw new Error("Rien à annuler : aucune action réversible depuis le démarrage de Jarod.");
      return `Annuler : ${e.label}`;
    },
    run: () => stack.undoLast(),
  };
}
