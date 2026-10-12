/**
 * Accord des outils (SPECS-P5-UI-PARITE.md §1) : canaux PROPRES à Jarod (`JAROD_INVOKE_CHANNELS` / `JAROD_EVENT_CHANNELS`).
 *
 * Avant : `send-message` refusait tout (fail-closed) faute d'écran, donc un outil sensible (écriture, shell, réseau) échouait
 * toujours dans le desktop. Maintenant : le crochet `approve` de l'agent pose une demande ICI, la fenêtre l'affiche
 * (`tool-approval-request`), l'utilisateur répond (`tool-approval-respond`) et l'agent reprend.
 *
 * Fail-closed conservé partout où personne ne peut répondre :
 * - une demande sans réponse est refusée au bout de `APPROVAL_TIMEOUT_MS` (le délai de l'agent) ;
 * - arrêt du tour (`abort-chat`), fin du tour ou erreur : les demandes de CE tour sont refusées et retirées ;
 * - un identifiant inconnu, déjà répondu ou périmé ne fait rien (`false`) : une réponse tardive ne peut rien accorder ;
 * - l'identifiant est un UUID tiré au hasard à chaque demande, jamais le `callId` du modèle.
 * Une réponse vaut pour UNE demande, sauf « toujours autoriser » (`always`) : ce choix s'inscrit dans `alwaysAllowTools` pour CET outil (tous
 * ses appels, quels que soient les arguments), derrière une confirmation NATIVE qui le nomme, et seulement quand il a un sens — l'accord
 * demandé est celui de l'outil lui-même (pas celui d'un garde interne comme le garde du shell) et aucune règle « demander » du garde de
 * permissions ne l'imposerait de toute façon. `autoApproveTools` reste l'interrupteur global.
 *
 * Portée « cette conversation » (SPECS-P5-UI-PARITE.md § 8.3) : `tool-approval-respond(id, true, "session")` retient (sessionId, outil) EN MÉMOIRE du processus
 * seulement — jamais sur disque, jamais dans un réglage, vidée au redémarrage ; mêmes conditions que « toujours » (`canAlways`), pas de confirmation native (rien
 * de persistant). Fail-closed : toute erreur ou doute ⇒ la fenêtre s'affiche. Allumer `autoApproveTools` ne résout JAMAIS une demande déjà posée (§ 8.4).
 */
import { randomUUID } from "node:crypto";
import { APPROVAL_TIMEOUT_MS, NEVER_ALWAYS, NEVER_ALWAYS_REASONS } from "@jarod/plugin-agent";
import type { HandlerContext } from "./context.js";

/** Longueur maximale des arguments montrés (au-delà : coupés, avec la marque « … »). */
const ARGS_PREVIEW = 4000;

/** Ce que la fenêtre reçoit : de quoi décider, rien de plus. */
export interface ToolApprovalRequest {
  id: string;
  runId: string;
  sessionId: string;
  tool: string;
  /** Description de l'outil (ce qu'il fait), telle que l'enregistre le plugin. */
  description: string;
  /** Arguments de l'appel, en JSON indenté, coupés à `ARGS_PREVIEW`. */
  args: string;
  /** « Toujours autoriser » (PERSISTANT) a un sens pour cette demande : accord de l'outil lui-même, et l'outil n'est pas dans `NEVER_ALWAYS`. */
  canAlways: boolean;
  /** « Autoriser pour cette conversation » (mémoire du processus) a un sens pour cette demande (§ 13.2). */
  canSession: boolean;
  at: number;
}

interface Pending {
  request: ToolApprovalRequest;
  /** Jeton du TOUR (propre à chaque `send-message`) : une relance sous le même `runId` n'annule pas la demande du nouveau tour. */
  owner: string;
  settle(allow: boolean, reason: "answered" | "stopped" | "timeout" | "unavailable"): void;
}

export interface ApprovalBroker {
  /** Pose une demande et attend la décision ; `false` si arrêtée, périmée ou sans réponse. */
  request(owner: string, runId: string, sessionId: string, call: { name: string; args?: unknown }, description: string): Promise<boolean>;
  /** Refuse (et retire) les demandes en attente d'un tour (`owner`) — son arrêt, sa fin. */
  cancel(owner: string): void;
  list(): ToolApprovalRequest[];
}

/** Le nombre maximal d'outils dispensés d'accord : au-delà, c'est une liste que personne ne relit. */
const MAX_ALWAYS = 100;
/**
 * Outils sans « Toujours » (permanent) : exécution de commandes, installation de skills, tâches planifiées, requêtes HTTP (SPECS-P5-UI-PARITE.md § 13.2 et § 23, décision de
 * SÉCURITÉ) ; « une fois » et « cette conversation » restent offerts. La liste vit dans plugin-agent (`never-always.ts`, avec le motif de chaque outil) : la boucle d'agent
 * la lit aussi, pour ignorer une entrée déjà enregistrée. Ici : la même valeur, pour les tests et le bouton.
 */
export { NEVER_ALWAYS };
/** Accords de conversation retenus en mémoire : au-delà, on refuse d'en ajouter (la fenêtre redemande). */
const MAX_SESSION = 200;

function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}, null, 2) ?? "{}";
  } catch {
    text = String(args);
  }
  return text.length > ARGS_PREVIEW ? `${text.slice(0, ARGS_PREVIEW)}…` : text;
}

export function createApprovalBroker(ctx: HandlerContext, timeoutMs: number = APPROVAL_TIMEOUT_MS) {
  const pending = new Map<string, Pending>();
  /** (sessionId, outil) accordés « pour cette conversation » : mémoire du processus seulement (§ 8.3). */
  const sessionGrants = new Set<string>();
  const grantKey = (sessionId: string, tool: string): string => `${sessionId}\u0000${tool}`;

  /**
   * « Toujours autoriser » n'a de sens que pour l'accord de l'OUTIL : il porte la description de l'outil (un garde interne — shell, tâches
   * planifiées — demande avec sa propre description), l'outil est sensible, et le garde de permissions ne lui impose pas « demander ».
   */
  const eligibility = (name: string, description: string): { session: boolean; always: boolean } => {
    try {
      const a = ctx.kernel().agent;
      const tool = a.tools.get(name);
      const session = Boolean(tool?.dangerous) && tool!.description === description && a.gate?.decide(name) !== "ask";
      return { session, always: session && !NEVER_ALWAYS.has(name) };
    } catch {
      return { session: false, always: false }; // lecture des permissions en échec : la fenêtre s'affiche sans aucune dispense (fail-closed, FC5)
    }
  };
  /** Un canal mort (fenêtre détruite) ne doit jamais empêcher une demande de se régler, ni lever. */
  const emit = (channel: string, payload: unknown): boolean => {
    try {
      ctx.shell.send(channel, payload);
      return true;
    } catch {
      return false;
    }
  };

  const broker: ApprovalBroker = {
    request(owner, runId, sessionId, call, description) {
      // Accord de conversation : redemandé à chaque appel s'il n'est plus éligible ; toute erreur ⇒ on affiche la fenêtre (jamais d'accord par défaut).
      try {
        if (sessionId && sessionGrants.has(grantKey(sessionId, call.name)) && eligibility(call.name, description).session) return Promise.resolve(true);
      } catch {
        /* fail-closed : on demande */
      }
      const id = randomUUID();
      const eligible = eligibility(call.name, description);
      const request: ToolApprovalRequest = {
        id,
        runId,
        sessionId,
        tool: call.name,
        description,
        args: previewArgs(call.args),
        canAlways: eligible.always,
        canSession: eligible.session,
        at: Date.now(),
      };
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle: Pending["settle"] = (allow, reason) => {
          if (!pending.delete(id)) return;
          if (timer) clearTimeout(timer);
          emit("tool-approval-resolved", { id, runId, allowed: allow, reason }); // le canal peut être mort : la décision est rendue quand même
          resolve(allow);
        };
        pending.set(id, { request, owner, settle });
        timer = setTimeout(() => settle(false, "timeout"), timeoutMs);
        timer.unref?.();
        // Canal IPC mort (fenêtre détruite) : personne ne peut répondre ⇒ refus IMMÉDIAT (FC2), pas une attente jusqu'au délai.
        if (!emit("tool-approval-request", request)) settle(false, "unavailable");
      });
    },
    cancel(owner) {
      for (const p of [...pending.values()]) if (p.owner === owner) p.settle(false, "stopped");
    },
    list: () => [...pending.values()].map((p) => p.request),
  };

  const handlers = {
    /**
     * `true` = la réponse a été prise en compte ; `false` = demande inconnue, déjà close ou périmée. `always` (avec `allow`) : en plus,
     * l'outil entre dans `alwaysAllowTools` — confirmation native ; refusée, la demande RESTE ouverte (on peut encore « autoriser une fois »).
     */
    "tool-approval-respond": async (id: unknown, allow: unknown, scopeArg?: unknown): Promise<boolean> => {
      // `scope` : "session" | "always" ; `true` reste accepté (= "always", compatibilité) ; `false` ou absent = une seule demande. Toute autre valeur : erreur.
      const scope = scopeArg === true ? "always" : scopeArg === false || scopeArg === undefined ? "once" : scopeArg === "session" || scopeArg === "always" ? scopeArg : null;
      if (typeof id !== "string" || typeof allow !== "boolean" || scope === null) {
        throw new Error('[oneai] tool-approval-respond : (id: string, allow: boolean, scope?: boolean | "session" | "always") attendu');
      }
      const p = pending.get(id);
      if (!p) return false;
      if (scope === "session") {
        const tool = p.request.tool;
        if (!allow) throw new Error("[oneai] « cette conversation » ne va pas avec un refus");
        if (!p.request.sessionId) throw new Error("[oneai] « cette conversation » indisponible : conversation inconnue");
        if (!p.request.canSession) throw new Error(`[oneai] « cette conversation » indisponible pour ${tool} (accord imposé par une règle ou par un garde interne)`);
        const key = grantKey(p.request.sessionId, tool);
        if (!sessionGrants.has(key) && sessionGrants.size >= MAX_SESSION) throw new Error(`[oneai] « cette conversation » : ${MAX_SESSION} accords au plus (Réglages › Agent › Tout retirer)`);
        sessionGrants.add(key);
      }
      if (scope === "always") {
        const tool = p.request.tool;
        if (!allow) throw new Error("[oneai] « toujours autoriser » ne va pas avec un refus");
        if (!p.request.canAlways) {
          throw new Error(
            NEVER_ALWAYS.has(tool)
              ? `[oneai] « toujours autoriser » indisponible pour ${tool} : un accord PERMANENT est refusé pour cet outil (${NEVER_ALWAYS_REASONS[tool] ?? "décision de sécurité"}) (choisissez « cette conversation », ou l'accord automatique dans Réglages › Agent)`
              : `[oneai] « toujours autoriser » indisponible pour ${tool} (accord imposé par une règle ou par un garde interne)`,
          );
        }
        if (!ctx.shell.confirm) throw new Error("[oneai] « toujours autoriser » : confirmation native indisponible, refusé");
        const ok = await ctx.shell.confirm(
          `Toujours autoriser « ${tool} » ?`,
          `${p.request.description}

Cet outil s'exécutera désormais SANS vous demander, quels que soient ses arguments, dans toutes les conversations. ` +
            "Les règles « refuser » et « demander » du garde de permissions, le mode Plan et le garde du shell continuent de s'appliquer. " +
            "Vous pourrez le retirer dans Réglages › Agent.",
          "Toujours autoriser",
        );
        if (!ok) throw new Error(`[oneai] « toujours autoriser » ${tool} : refusé par l'utilisateur`);
        if (!pending.has(id)) return false; // close pendant la boîte (arrêt, délai) : rien n'est enregistré
        const settings = ctx.kernel().agent.settings;
        const list = settings.get("alwaysAllowTools");
        if (!list.includes(tool)) {
          if (list.length >= MAX_ALWAYS) throw new Error(`[oneai] « toujours autoriser » : ${MAX_ALWAYS} outils au plus (retirez-en dans Réglages › Agent)`);
          settings.set("alwaysAllowTools", [...list, tool]);
        }
      }
      p.settle(allow, "answered");
      return true;
    },
    /** Les demandes encore ouvertes : la fenêtre les relit à son montage (changement d'écran, rechargement). */
    "tool-approval-pending": (): ToolApprovalRequest[] => broker.list(),
    /** Nombre d'accords « pour cette conversation » en cours (mémoire du processus ; Réglages › Agent le montre). */
    "tool-approval-grants": (): { session: number } => ({ session: sessionGrants.size }),
    /** Retire tous les accords de conversation ; rend leur nombre. Ne touche ni `alwaysAllowTools` ni `autoApproveTools`. */
    "tool-approval-grants-clear": (): number => {
      const n = sessionGrants.size;
      sessionGrants.clear();
      return n;
    },
  };

  return { broker, handlers };
}
