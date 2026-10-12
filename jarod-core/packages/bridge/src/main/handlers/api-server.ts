/**
 * API compatible OpenAI (SPECS-P5-UI-PARITE.md §3.3) : le serveur `OpenAIApiServer` de plugin-llm existait sans que rien ne le démarre. Ici il est
 * branché au kernel du desktop : canaux PROPRES à Jarod `api-server-status`, `api-server-set`, `api-server-new-key`.
 *
 * Ce que ce serveur permet : qu'un client (Open WebUI, un éditeur, un script) parle à l'agent, avec sa mémoire et ses skills, par `/v1/chat/completions`.
 * Garde-fous :
 * - TOUTE requête exige la clé (Bearer) ; sans clé enregistrée, il ne s'allume pas ;
 * - un client ne peut pas répondre à une demande d'accord, et l'agent y tourne en MODE PLAN : lecture seule, aucun outil qui écrit, lance ou
 *   navigue — même si « autoriser sans demander » est allumé (le mode Plan est jugé avant) ;
 * - il écoute sur la boucle locale ; l'ouvrir au RÉSEAU (`0.0.0.0`) demande une confirmation native (réglage `apiServer.host`) ; l'allumer aussi ;
 * - la clé n'est jamais relue : « nouvelle clé » en génère une, la montre UNE fois, et l'ancienne cesse de marcher ;
 * - `enabled` n'est écrit que par ce canal (pas par `set-jarod-settings`) ; le serveur s'arrête avec l'application.
 */
import { randomBytes } from "node:crypto";
import { API_KEY_SECRET, OpenAIApiServer } from "@jarod/plugin-llm";
import type { HandlerContext } from "./context.js";

/** Les serveurs de ce processus, avec ce qui les rallume au lancement (voir `startRememberedApiServers`). */
const servers = new Map<OpenAIApiServer, () => Promise<void>>();
/** Les serveurs de ce processus : l'application les ferme en quittant. */
export function closeAllApiServers(): void {
  for (const s of servers.keys()) s.stop();
  servers.clear();
}
/**
 * Un serveur que l'utilisateur avait allumé revient avec l'application : à appeler UNE fois, kernel ouvert (le main, après `createHandlers`). Ce n'est pas fait à la
 * création des handlers : elle ne touche jamais le kernel (le décompte `pnpm channels:count` la lance sans kernel).
 */
export async function startRememberedApiServers(): Promise<void> {
  await Promise.all([...servers.values()].map((restore) => restore()));
}

export interface ApiServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  host: "127.0.0.1" | "0.0.0.0";
  keyConfigured: boolean;
  error: string;
}

const MAX_REMEMBERED = 200;

export function createApiServerHandlers(ctx: HandlerContext) {
  const agent = () => ctx.kernel().agent;
  const settings = () => agent().settings;
  /** Empreinte d'un historique → conversation à poursuivre (un client OpenAI renvoie tout l'historique à chaque requête). */
  const remembered = new Map<string, string>();

  const server = new OpenAIApiServer({
    config: () => settings().get("apiServer"),
    key: () => settings().getSecret(API_KEY_SECRET) ?? "",
    lookup: (key) => {
      const id = remembered.get(key) ?? null;
      return id && agent().sessions.get(id) ? id : null;
    },
    remember: (key, sessionId) => {
      remembered.delete(key);
      remembered.set(key, sessionId);
      if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
    },
    run: async (r) => {
      const a = agent();
      let sessionId = r.sessionId && a.sessions.get(r.sessionId) ? r.sessionId : null;
      if (!sessionId) {
        sessionId = a.sessions.create(r.title.slice(0, 80) || undefined).id;
        // Lecture seule : un client distant ne répond à aucun accord et ne doit rien écrire, lancer ni visiter. Jugé AVANT `autoApproveTools`.
        a.updateSessionContext(sessionId, { agentMode: "plan", provider: settings().get("activeProvider"), model: settings().get("activeModel") });
      }
      const onAbort = () => a.stop(sessionId!);
      r.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await a.runAndWait(sessionId, r.prompt, {
          approve: async () => false,
          emit: (e) => {
            if (e.type === "delta" && e.text) r.onDelta(e.text);
          },
        });
        return { sessionId, text: res.text, ...(res.error ? { error: res.error } : {}) };
      } finally {
        r.signal.removeEventListener("abort", onAbort);
      }
    },
  });
  servers.set(server, async () => {
    if (settings().get("apiServer").enabled && settings().getSecret(API_KEY_SECRET)) await server.start();
  });

  const status = (): ApiServerStatus => {
    const cfg = settings().get("apiServer");
    return {
      enabled: cfg.enabled,
      running: server.status.running,
      port: server.status.port ?? cfg.port,
      host: cfg.host,
      keyConfigured: Boolean(settings().getSecret(API_KEY_SECRET)),
      error: server.status.error ?? "",
    };
  };

  return {
    "api-server-status": (): ApiServerStatus => status(),

    /** Allume (clé exigée ; confirmation native) ou éteint. Rend l'état relu. */
    "api-server-set": async (enabled: unknown): Promise<ApiServerStatus> => {
      if (typeof enabled !== "boolean") throw new Error("[oneai] api-server-set : booléen attendu");
      const cfg = settings().get("apiServer");
      if (enabled) {
        if (!settings().getSecret(API_KEY_SECRET)) throw new Error("[oneai] API : aucune clé enregistrée — générez une clé d'abord");
        if (!ctx.shell.confirm) throw new Error("[oneai] API : confirmation native indisponible, refusé");
        const where = cfg.host === "0.0.0.0" ? "TOUT le réseau local" : "cette machine seulement";
        const ok = await ctx.shell.confirm(
          "Allumer l'API compatible OpenAI ?",
          `Jarod écoutera sur le port ${cfg.port}, ${where}. Chaque requête exige la clé d'API. Les clients y parlent à l'agent en LECTURE SEULE : il ne peut ni écrire, ni lancer de commande, ni naviguer, et aucun client ne peut répondre à une demande d'accord.`,
          "Allumer",
        );
        if (!ok) throw new Error("[oneai] API : refusé par l'utilisateur");
        settings().set("apiServer", { ...cfg, enabled: true });
        await server.start();
      } else {
        settings().set("apiServer", { ...cfg, enabled: false });
        server.stop();
      }
      return status();
    },

    /** Génère une clé NEUVE, la rend UNE fois (jamais relue) ; l'ancienne cesse de marcher. */
    "api-server-new-key": (): { key: string } => {
      const key = `jarod-${randomBytes(24).toString("hex")}`;
      settings().setSecret(API_KEY_SECRET, key);
      return { key };
    },
  };
}
