/**
 * « Reindex » du volet Documents (SPECS-P5-UI-PARITE.md § 20) : canaux PROPRES à Jarod `rag-index-status`, `rag-reindex`, `rag-reindex-cancel`.
 *
 * - `rag-reindex` redécoupe les documents DÉJÀ indexés depuis le texte gardé dans l'index (jamais les fichiers d'origine) : il refuse interrupteur éteint,
 *   passe en cours ou index sans document refaisable, puis demande une boîte NATIVE qui dit le NOMBRE de documents, la taille et le recouvrement en vigueur
 *   et le serveur qui recevra le texte ; refusée ou indisponible, RIEN ne démarre ; acceptée, la passe tourne en arrière-plan ;
 * - l'état de la passe (au repos, en cours avec son avancement, finie, arrêtée, en échec) est tenu EN MÉMOIRE ici ; le volet l'interroge (`rag-index-status`) ;
 * - `rag-reindex-cancel` demande l'arrêt : le document en cours va jusqu'au bout (il est atomique), les suivants gardent leurs passages d'avant.
 */
import type { HandlerContext } from "./context.js";

export interface RagRun {
  state: "idle" | "running" | "done" | "cancelled" | "failed";
  done: number;
  total: number;
  documents: number;
  passages: number;
  cancelling: boolean;
  error: string | null;
}

export interface RagIndexStatus {
  enabled: boolean;
  documents: number;
  passages: number;
  reindexable: number;
  missing: number;
  endpoint: string | null;
  chunkSize: number;
  chunkOverlap: number;
  run: RagRun;
}

const IDLE: RagRun = { state: "idle", done: 0, total: 0, documents: 0, passages: 0, cancelling: false, error: null };

/** Le message de l'erreur, sans code technique (`RAG_EMBED_HTTP_500 sur <url>` devient une phrase). */
export function readableRagError(message: string): string {
  return message.replace(/^RAG_EMBED_HTTP_(\d+) sur (\S+)/, "Le serveur d'embeddings $2 a répondu $1").replace(/^RAG_[A-Z0-9_]+:\s*/, "");
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

export function createRagIndexHandlers(ctx: HandlerContext) {
  const rag = () => {
    const r = ctx.kernel().rag;
    if (!r) throw new Error("[oneai] RAG indisponible (plugin-rag désactivé)");
    return r;
  };
  const settings = () => ctx.kernel().agent.settings;
  let run: RagRun = { ...IDLE };
  let controller: AbortController | null = null;
  /** Posé dès la demande et jusqu'à la fin de la passe : une seconde demande (double clic, deuxième fenêtre) ne passe pas, même pendant la boîte native. */
  let busy = false;

  const status = (): RagIndexStatus => {
    const r = rag();
    const s = r.status();
    const cfg = settings().get("rag");
    let plan = { documents: 0, chunks: 0, missing: 0 };
    try {
      plan = r.reindexPlan();
    } catch {
      // interrupteur éteint : rien n'est refaisable tant qu'il l'est
    }
    return {
      enabled: s.enabled,
      documents: s.docs,
      passages: s.chunks,
      reindexable: plan.documents,
      missing: plan.missing,
      endpoint: s.endpoint,
      chunkSize: cfg.chunkSize,
      chunkOverlap: cfg.chunkOverlap,
      run: { ...run },
    };
  };

  return {
    "rag-index-status": (): RagIndexStatus => status(),

    "rag-reindex": async (): Promise<RagIndexStatus> => {
      const r = rag();
      if (busy) throw new Error("[oneai] une réindexation est déjà en cours");
      let plan: { documents: number; chunks: number; missing: number };
      try {
        plan = r.reindexPlan();
      } catch (e) {
        throw new Error(`[oneai] ${(e as Error).message}`);
      }
      if (plan.documents === 0) {
        throw new Error(
          `[oneai] rien à refaire : ${plan.missing ? `${plan.missing} document(s) indexé(s) avant la conservation du texte (relancez rag_index sur leur fichier)` : "aucun document indexé"}`,
        );
      }
      if (!ctx.shell.confirm) throw new Error("[oneai] confirmation native indisponible, refusé");
      busy = true;
      try {
        const cfg = settings().get("rag");
        const endpoint = r.status().endpoint ?? "le serveur d'embeddings choisi";
        const lines = [
          `Chaque document sera redécoupé à ${cfg.chunkSize} caractères (recouvrement ${cfg.chunkOverlap}) depuis le texte gardé dans l'index, puis ses passages seront embarqués de nouveau par ${endpoint}. Les fichiers d'origine ne sont pas relus.`,
        ];
        if (plan.missing) lines.push(`${plural(plan.missing, "document indexé", "documents indexés")} avant la conservation du texte ne seront pas refaits (relancez rag_index sur leur fichier).`);
        lines.push("Vous pouvez annuler en cours de route : les documents déjà refaits le restent.");
        const ok = await ctx.shell.confirm(`Réindexer ${plural(plan.documents, "document", "documents")} ?`, lines.join("\n\n"), "Réindexer");
        if (!ok) throw new Error("[oneai] réindexation : refusé par l'utilisateur");
      } catch (e) {
        busy = false;
        throw e;
      }
      const ctrl = new AbortController();
      controller = ctrl;
      run = { ...IDLE, state: "running", total: plan.documents };
      void r
        .reindex({
          signal: ctrl.signal,
          onProgress: (p) => {
            run = { ...run, done: p.done, total: p.total };
          },
        })
        .then((res) => {
          run = { ...run, state: res.cancelled ? "cancelled" : "done", documents: res.documents, passages: res.chunks, cancelling: false };
        })
        .catch((e: unknown) => {
          run = { ...run, state: "failed", cancelling: false, error: `Réindexation interrompue après ${run.done} sur ${run.total} document(s) : ${readableRagError((e as Error).message ?? String(e))}` };
        })
        .finally(() => {
          controller = null;
          busy = false;
        });
      return status();
    },

    "rag-reindex-cancel": (): RagIndexStatus => {
      if (run.state === "running" && controller && !controller.signal.aborted) {
        controller.abort();
        run = { ...run, cancelling: true };
      }
      return status();
    },
  };
}
