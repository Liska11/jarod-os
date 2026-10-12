// SPECS-P5-ACP.md : `jarod acp` — Jarod comme agent ACP (stdio) dans un éditeur (Zed, JetBrains…).
// Surface v1 : initialize, session/new, session/load (avec rejeu), session/prompt, session/cancel, session/set_mode (default | plan).
// Autorisations : `hooks.approve` → `session/request_permission`, ÉCHEC FERMÉ (acp-permission.ts), 300 s. Serveurs MCP de l'éditeur IGNORÉS ;
// fichiers et terminal de l'éditeur NON utilisés (Jarod agit directement dans `cwd`) ; aucun module réseau ici (transport stdio seulement).
// Aucune migration : le schéma est contrôlé avant l'ouverture, comme pour `jarod mcp`.
import { isAbsolute } from "node:path";
import type { Message } from "@jarod/contracts";
import { redactText } from "@jarod/kernel/redact";
import type { AgentHooks } from "@jarod/plugin-agent";
import type { KeyStore } from "@jarod/plugin-storage";
import { type AcpUpdate, mapAgentEvent, promptToText, toolCallStart, UnsupportedPromptError } from "./acp-events.js";
import { askPermission, PERMISSION_TIMEOUT_MS } from "./acp-permission.js";
import { openCore } from "./context.js";
import { ERR, RpcError, serveJsonRpc } from "./jsonrpc-stdio.js";
import { profilePreflight } from "./preflight.js";
import { overrideSettings } from "./settings-override.js";

/** Ce dont l'agent ACP a besoin du cœur (sous-ensemble de `CliCore`) : permet de tester sans modèle ni base. */
export interface AcpCore {
  sessions: {
    create(title: string): { id: string };
    get(id: string): { id: string; title: string } | undefined;
    rename?(id: string, title: string): void;
  };
  messages: { list(sessionId: string): Message[] };
  updateSessionContext(sessionId: string, patch: { workspace?: string; agentMode?: "build" | "plan" }): void;
  runAndWait(sessionId: string, text: string, hooks: AgentHooks): Promise<{ text: string; error?: string }>;
  stop(sessionId: string): void;
}

export interface AcpTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
}

export interface AcpHandlers {
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void | Promise<void>;
  /** Arrête tous les tours en cours (fin d'entrée de l'éditeur). */
  stopAll(): void;
}

interface SessionState {
  cwd: string;
  running: boolean;
  cancelled: boolean;
  abort: AbortController | null;
  titled: boolean;
}

const PROTOCOL_VERSION = 1;
const MODES = [
  { id: "default", name: "Défaut", description: "Jarod agit, et demande votre accord dans l'éditeur avant chaque outil sensible." },
  { id: "plan", name: "Plan", description: "Lecture seule : Jarod explore et propose, sans rien modifier." },
] as const;
const MODE_TO_AGENT = { default: "build", plan: "plan" } as const;
const modeState = (current: "default" | "plan") => ({ currentModeId: current, availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })) });

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {});

export function createAcpHandlers(opts: { core: AcpCore; transport: AcpTransport; version: string; permissionTimeoutMs?: number }): AcpHandlers {
  const { core, transport } = opts;
  const sessions = new Map<string, SessionState>();
  let initialized = false;
  let editor = "ACP";

  const needInit = (): void => {
    if (!initialized) throw new RpcError(ERR.invalidRequest, "Agent non initialisé : envoyez d'abord `initialize`.");
  };
  const cwdOf = (p: Record<string, unknown>): string => {
    if (typeof p.cwd !== "string" || !isAbsolute(p.cwd)) throw new RpcError(ERR.invalidParams, "`cwd` doit être un chemin absolu.");
    return p.cwd;
  };
  const sessionOf = (p: Record<string, unknown>): { id: string; st: SessionState } => {
    const id = p.sessionId;
    const st = typeof id === "string" ? sessions.get(id) : undefined;
    if (!st || typeof id !== "string") throw new RpcError(ERR.invalidParams, "Session inconnue : créez-la avec `session/new` ou rouvrez-la avec `session/load`.");
    return { id, st };
  };
  const update = (sessionId: string, u: AcpUpdate): void => transport.notify("session/update", { sessionId, update: u });
  const ignoredMcp = (p: Record<string, unknown>): void => {
    if (Array.isArray(p.mcpServers) && p.mcpServers.length > 0)
      process.stderr.write(`jarod acp : ${p.mcpServers.length} serveur(s) MCP fourni(s) par l'éditeur IGNORÉ(S) (v1 : ils ne sont jamais lancés).\n`);
  };

  /** Rejoue l'historique d'une conversation (sans réflexion ni résumé de compaction), avant la réponse de `session/load`. */
  function replay(sessionId: string): void {
    for (const m of core.messages.list(sessionId)) {
      if (m.kind === "summary") continue;
      if (m.role === "user" && m.content.trim()) update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: redactText(m.content) } });
      else if (m.role === "assistant") {
        if (m.content.trim()) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: redactText(m.content) } });
        for (const call of m.toolCalls ?? []) update(sessionId, toolCallStart(call));
      } else if (m.role === "tool") for (const u of mapAgentEvent({ type: "message", sessionId, message: m })) update(sessionId, u);
    }
  }

  async function prompt(p: Record<string, unknown>): Promise<unknown> {
    const { id, st } = sessionOf(p);
    let text: string;
    try {
      text = promptToText(p.prompt as never);
    } catch (e) {
      if (e instanceof UnsupportedPromptError) throw new RpcError(ERR.invalidParams, e.message);
      throw e;
    }
    if (st.running) throw new RpcError(ERR.invalidRequest, "Un tour est déjà en cours dans cette session.");
    st.running = true;
    st.cancelled = false;
    st.abort = new AbortController();
    const signal = st.abort.signal;
    if (!st.titled && core.sessions.rename) {
      core.sessions.rename(id, `🔌 ${editor} — ${oneLine(redactText(text), 50)}`);
      st.titled = true;
    }
    let live = true; // après la fin du tour, plus RIEN n'est envoyé à l'éditeur
    const hooks: AgentHooks = {
      emit: (e) => {
        if (!live) return;
        for (const u of mapAgentEvent(e)) update(id, u);
      },
      approve: async (_sid, call, description) => {
        if (!live || signal.aborted) return false;
        const r = await askPermission({
          request: (params) => transport.request("session/request_permission", params),
          sessionId: id,
          call,
          description,
          signal,
          ...(opts.permissionTimeoutMs !== undefined ? { timeoutMs: opts.permissionTimeoutMs } : {}),
        });
        return r.allowed;
      },
    };
    try {
      await core.runAndWait(id, text, hooks);
    } finally {
      live = false;
      st.running = false;
      st.abort = null;
    }
    return { stopReason: st.cancelled ? "cancelled" : "end_turn" };
  }

  return {
    async onRequest(method, params) {
      const p = obj(params);
      if (method === "initialize") {
        initialized = true;
        const name = obj(p.clientInfo).name;
        if (typeof name === "string" && name.trim()) editor = oneLine(redactText(name), 40);
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: "jarod", title: "Jarod", version: opts.version },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
          },
          authMethods: [],
        };
      }
      if (method === "session/new") {
        needInit();
        const cwd = cwdOf(p);
        ignoredMcp(p);
        const s = core.sessions.create(`🔌 ${editor}`);
        core.updateSessionContext(s.id, { workspace: cwd, agentMode: "build" });
        sessions.set(s.id, { cwd, running: false, cancelled: false, abort: null, titled: false });
        return { sessionId: s.id, modes: modeState("default") };
      }
      if (method === "session/load") {
        needInit();
        const cwd = cwdOf(p);
        const id = typeof p.sessionId === "string" ? p.sessionId : "";
        if (!id || !core.sessions.get(id)) throw new RpcError(ERR.invalidParams, "Conversation introuvable.");
        ignoredMcp(p);
        core.updateSessionContext(id, { workspace: cwd, agentMode: "build" });
        sessions.set(id, { cwd, running: false, cancelled: false, abort: null, titled: true });
        replay(id);
        return { modes: modeState("default") };
      }
      if (method === "session/prompt") {
        needInit();
        return prompt(p);
      }
      if (method === "session/set_mode") {
        needInit();
        const { id } = sessionOf(p);
        const mode = p.modeId;
        if (mode !== "default" && mode !== "plan") throw new RpcError(ERR.invalidParams, "Mode inconnu : `default` ou `plan`.");
        core.updateSessionContext(id, { agentMode: MODE_TO_AGENT[mode] });
        update(id, { sessionUpdate: "current_mode_update", currentModeId: mode });
        return {};
      }
      throw new RpcError(ERR.methodNotFound, `Méthode inconnue : ${String(method).slice(0, 80)}`);
    },

    onNotification(method, params) {
      if (method !== "session/cancel") return;
      const id = obj(params).sessionId;
      const st = typeof id === "string" ? sessions.get(id) : undefined;
      if (!st || !st.running || typeof id !== "string") return;
      st.cancelled = true;
      st.abort?.abort();
      core.stop(id);
    },

    stopAll() {
      for (const [id, st] of sessions)
        if (st.running) {
          st.cancelled = true;
          st.abort?.abort();
          core.stop(id);
        }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface AcpCommandOptions {
  dataRoot: string;
  version: string;
  profile?: string;
  input?: NodeJS.ReadableStream & { destroy(): unknown };
  output?: NodeJS.WritableStream;
  keyStores?: KeyStore[];
  env?: NodeJS.ProcessEnv;
  permissionTimeoutMs?: number;
}

/** `jarod acp` : lancé par l'éditeur, sur ordre de l'utilisateur. Ouvre le cœur comme `jarod ask` (sans verrou ni passerelles ni tâches). */
export async function acpCommand(o: AcpCommandOptions): Promise<number> {
  const pre = profilePreflight({ dataRoot: o.dataRoot, ...(o.profile ? { profile: o.profile } : {}), ...(o.keyStores ? { keyStores: o.keyStores } : {}), command: "jarod acp" });
  if (!pre.ok) {
    process.stderr.write(`jarod acp : ${pre.message}\n`);
    return 1;
  }
  const { core } = await openCore({ profile: pre.profile, env: o.env ?? { ...process.env, JAROD_HOME: o.dataRoot } });
  overrideSettings(core, { autoTitle: false });
  await core.skills.reload();
  const input = (o.input ?? process.stdin) as NodeJS.ReadableStream & { destroy(): unknown };
  const output = o.output ?? process.stdout;
  process.stderr.write(
    `jarod acp (pid ${process.pid}) : profil « ${pre.profile} ». Démarré sur ordre de l'utilisateur par son éditeur ; les outils sensibles demandent votre accord dans l'éditeur (refus si pas de réponse en ${(o.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS) / 1000} s).\n`,
  );
  let handlers!: AcpHandlers;
  const server = serveJsonRpc({
    input: input as never,
    output: output as never,
    onRequest: (m, p) => handlers.onRequest(m, p),
    onNotification: (m, p) => handlers.onNotification(m, p),
  });
  handlers = createAcpHandlers({
    core: core as never,
    transport: server,
    version: o.version,
    ...(o.permissionTimeoutMs !== undefined ? { permissionTimeoutMs: o.permissionTimeoutMs } : {}),
  });
  const stop = (): void => {
    handlers.stopAll();
    input.destroy();
  };
  if (!o.input) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  await server.closed;
  handlers.stopAll();
  if (!o.input) {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  await core.dispose();
  return 0;
}
