// Portage de packages/core/src/services/spill.ts (rév. 2e180305).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truncate } from "@jarod/kernel/util";

/** Au-delà de ça, une sortie ne va plus dans le contexte : elle va sur le disque. */
export const SPILL_THRESHOLD = 6000;

export interface Spilled {
  /** Ce que le modèle voit : l'aperçu, plus l'endroit où lire le reste. */
  preview: string;
  /** Le chemin RELATIF au dossier de travail, appelable tel quel par `read_file`. */
  locator: string | null;
  bytes: number;
}

/**
 * Déplace au lieu de jeter.
 *
 * Une sortie d'outil trop longue était tronquée : « … [tronqué, 12 000 caractères de plus] ». La
 * mention était honnête, et l'information perdue — le modèle savait qu'il ne savait pas, sans aucun
 * moyen d'aller voir. Une troncature qui perd la donnée est indistinguable d'une panne.
 *
 * Ici, la sortie complète est écrite sous `.jarod/spill/` dans le dossier de travail, et l'aperçu
 * porte un `locator` **relatif au dossier de travail** — donc directement lisible par l'outil de
 * lecture de fichiers. Un fichier qu'on ne peut pas relire serait un mensonge de plus.
 */
export class SpillService {
  constructor(private readonly d: { root: string; threshold?: number; previewChars?: number }) {}

  /** Le seuil est celui du transcript de compaction : 6 000 caractères perdus hier. */
  private threshold(): number {
    return this.d.threshold ?? SPILL_THRESHOLD;
  }

  /** Écrit la sortie si elle dépasse le seuil, et rend toujours de quoi l'afficher. */
  keep(sessionId: string, label: string, text: string): Spilled {
    if (text.length <= this.threshold()) {
      return { preview: text, locator: null, bytes: text.length };
    }
    const dir = join(this.d.root, ".jarod", "spill", safe(sessionId));
    mkdirSync(dir, { recursive: true });
    const name = `${safe(label)}-${Date.now().toString(36)}-${text.length}.txt`;
    writeFileSync(join(dir, name), text, "utf8");
    const keep = this.d.previewChars ?? Math.floor(this.threshold() / 3);
    const head = text.slice(0, keep);
    const tail = text.slice(-Math.floor(keep / 3));
    const rel = [".jarod", "spill", safe(sessionId), name].join("/");
    return {
      preview:
        `${head}\n… [${text.length} caractères au total, ${text.length - head.length - tail.length} non montrés — ` +
        `le texte complet est dans ${rel} et se relit avec l'outil de lecture de fichiers]\n…\n${tail}`,
      locator: rel,
      bytes: text.length,
    };
  }

  /** Relit une sortie déplacée. Le nom est vérifié : aucun chemin ne sort de `.jarod/spill`. */
  read(sessionId: string, name: string): string | undefined {
    if (!/^[\w.-]+$/.test(name)) return undefined;
    try {
      return readFileSync(join(this.d.root, ".jarod", "spill", safe(sessionId), name), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Ce qui a été déplacé pour une session : ce qui reste à nettoyer, nommément. */
  list(sessionId: string): string[] {
    try {
      return readdirSync(join(this.d.root, ".jarod", "spill", safe(sessionId)));
    } catch {
      return [];
    }
  }

  /** L'aperçu seul, prêt à entrer dans un transcript de compaction. */
  preview(sessionId: string, label: string, text: string): string {
    return this.keep(sessionId, label, text).preview;
  }

  /** Le repli quand aucun dossier n'est disponible : on garde le comportement d'avant, pas un trou. */
  static fallback(text: string, max = SPILL_THRESHOLD): string {
    return truncate(text, max);
  }
}

/** Un nom utilisable sur le disque et incapable de sortir du dossier. */
function safe(name: string): string {
  const cleaned = name
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[.-]+/, "")
    .slice(0, 60);
  return cleaned || "sortie";
}
