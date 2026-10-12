// Outils système (phases 2 et 3) : « préparer puis exécuter ». Une action a deux temps : PRÉPARER (valider, résoudre les cibles, refuser ce que la
// politique interdit, dire en une phrase ce qui va se passer) et EXÉCUTER. Le même code sert au crochet `precheck` — appelé avant toute demande
// d'accord — et à `run`, qui prépare de nouveau juste avant d'agir (la cible a pu changer entre l'accord et l'exécution).
//
// Lien entre l'accord et l'action : `precheck` retient l'empreinte de ce qui a été présenté (clé : l'objet des arguments, le même pour `precheck` et
// `run` dans la boucle de l'agent). Si, au moment d'agir, l'empreinte n'est plus la même — un dossier de destination est apparu, un autre processus
// porte maintenant le pid, un fichier a été remplacé —, l'outil REFUSE : l'utilisateur a accordé une chose, pas une autre.
import type { ToolContext, ToolDef } from "../registry.js";

export interface Prepared {
  /** Ce que l'utilisateur voit à la demande d'accord : une phrase, pas le mode d'emploi de l'outil. */
  summary: string;
  /** Tout ce qui définit l'action, en entier (le résumé peut être abrégé) ; le résumé par défaut. Comparée entre l'accord et l'exécution. */
  fingerprint?: string;
  go(): Promise<string>;
}

export type Prepare = (args: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ToolContext) => Promise<Prepared>;

export function prepared(def: Omit<ToolDef, "run" | "precheck">, prepare: Prepare): ToolDef {
  const shown = new WeakMap<object, string>();
  return {
    ...def,
    async precheck(args, ctx) {
      const p = await prepare(args, ctx.signal, ctx);
      shown.set(args, p.fingerprint ?? p.summary);
      return p.summary;
    },
    async run(args, ctx) {
      const p = await prepare(args, ctx.signal, ctx);
      const accepted = shown.get(args);
      if (accepted !== undefined && accepted !== (p.fingerprint ?? p.summary)) {
        throw new Error("Ce qui allait se passer a changé depuis la demande d'accord ; rien n'a été fait. Refaire la demande.");
      }
      return p.go();
    },
  };
}
