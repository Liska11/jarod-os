// Passerelle compatible Hermes (essai) : un serveur sur 127.0.0.1 que le shell de Herald OS prend pour son moteur (`hermes serve`).
//   GET  /api/status          public (la sonde de disponibilité du shell)
//   WS   /api/ws?token=…      JSON-RPC 2.0 : sessions, tour de conversation, accords ; événements en notifications `event`
//   *    /api/…               REST : jeton `X-Hermes-Session-Token` exigé ; tout ce qui n'est pas servi répond 404 ET est consigné
// Ce qui n'est pas servi est le résultat de l'essai : `unhandled()` le liste, il alimente le plan de portage.
import { redactText } from "@jarod/kernel/redact";
import { sameSecret } from "@jarod/kernel/secret";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Message, Session, SessionContext } from "@jarod/contracts";
import type { AgentHooks } from "@jarod/plugin-agent";
import { approvalParams, chooseWorkspace, eventFrame, isApproved, promptText, RPC, readyFrame, sessionInfo, sessionRow, storedMessages, toTranscript, TurnTranslator } from "./protocol.js";
import { applyConfigPatch, CONFIG_RAW_READ_ONLY, configRaw, GUARDED_COMMANDS, type CommandResultLike, checkTerminalBackend, type CommandRegistryLike, commandCatalog, ConfigError, configGet, configSet, hermesConfig, modelOptions, normalizeModelCommand, type ProviderLike, setToolsetEnabled, slashResult, terminalBackends, type ToolLike, toolsets } from "./config.js";
import { findMcp, type GatewayStatusLike, type McpConfigLike, type McpPort, mcpServers, messagingPlatforms, type PlatformId, probeResult, refusePlatformToggle, removeMcp, setMcpEnabled } from "./connections.js";
import { AudioError, MAX_AUDIO_BODY, parseDataUrl, speakText, type VoicePort, wavDataUrl } from "./audio.js";
import { BridgeError, type BridgePort, parseInvokeBody } from "./bridge.js";
import type { ShellLink } from "./bridge-shell.js";
import { ModelDiscovery } from "./discovery.js";
import { clearProviderKey, type KeySources, providerRows, setExtraProviderKeys, setProviderKey, setProviderOverride, testProvider } from "./providers.js";
import { isUnavailableRest, NOT_AVAILABLE, UNAVAILABLE_RPC } from "./unavailable.js";
import { analytics, parseDays, periodStart, type UsageRow, USAGE_SQL } from "./usage.js";
import { checkTexts, MEMORY_FILE_NAMES, type MemoryFileName, type MemoryServiceLike, memoryFiles, type ProfileLike, writeMemoryFile } from "./memory.js";
import { cronJobs, memoryStatus, type SchedulerLike } from "./rest.js";
import { parseScheduleText, ScheduleTextError } from "./schedule-text.js";
import { acceptUpgrade, type WsConnection, wsProtocolToken, wsSelectedProtocol } from "./ws.js";

/** Ce que la passerelle demande au noyau : le strict nécessaire, pour qu'un faux noyau suffise aux tests. */
export interface GatewayCore {
  sessions: {
    create(title?: string): Session;
    get(id: string): Session | undefined;
    list(limit?: number): Session[];
    delete(id: string): void;
  };
  messages: { list(sessionId: string): Message[] };
  start(sessionId: string, text: string | null, hooks: AgentHooks): { kind: string };
  stop(sessionId: string): void;
  updateSessionContext(sessionId: string | null, patch: Partial<SessionContext>): void;
  settings: { get(key: string): unknown; patch?(p: Record<string, unknown>): void; setSecret?(key: string, value: string): void };
  /** Absents d'un faux noyau : la route correspondante reste alors non servie. */
  providers?: { list(): readonly ProviderLike[]; client?(id: string): { listModels(): Promise<string[]> }; setExtraKeys?(id: string, keys: string[]): void };
  tools?: { all(): readonly ToolLike[] };
  commands?: CommandRegistryLike;
  /** La voie GARDÉE des commandes `/` (règle, accord si effet, audit) : `AgentRuntime.executeRemoteCommand`. */
  executeRemoteCommand?(input: string, sessionId: string | null, hooks: AgentHooks): Promise<CommandResultLike | null>;
  /** Les services du noyau que les pages Connexions et Réseau lisent : serveurs MCP et état des passerelles de messagerie. */
  app?: object;
  gatewayHub?: { gatewayStatus(id: PlatformId): GatewayStatusLike };
  /** La base du noyau (lecture) : le relevé d'usage s'en tire. */
  db?: { all<T>(sql: string, ...params: unknown[]): T[] };
  memory?: MemoryServiceLike;
  userProfile?: ProfileLike;
  scheduler?: SchedulerLike;
  /** Une complétion sans outil sur le modèle actif (`llm.oneshot`) ; absente d'un faux noyau. */
  agent?: { complete(prompt: string, signal: AbortSignal, opts?: { system?: string; thinking?: boolean; maxTokens?: number }): Promise<string> };
}

export interface GatewayOptions {
  core: GatewayCore;
  /** Le jeton exigé du shell ; aléatoire si absent. */
  token?: string;
  version: string;
  /** Le dossier de travail de toutes les conversations (absolu). Sans lui, la passerelle suit le dossier envoyé par le shell. */
  workspace?: string;
  log?: (line: string) => void;
  /** « Run now » attend la fin de l'exécution au plus ce temps (ms) avant de répondre ; 30 s par défaut (Herald abandonne à 60 s). */
  triggerWaitMs?: number;
  /** Une fenêtre qui ne répond pas à une demande d'accord au bout de ce temps (ms) : la demande est refusée et la fenêtre prévenue ; 10 min par défaut. */
  approvalTimeoutMs?: number;
  /** Idem pour un geste natif (sélecteur, confirmation) : 1 h par défaut, comme l'appel `jarod.invoke` du shell. */
  shellTimeoutMs?: number;
  /** La voix (transcription, synthèse) : sans elle, `/api/audio/*` répond 404 et la fenêtre le dit. */
  voice?: VoicePort;
}

export interface Gateway {
  readonly token: string;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  /** Appels reçus sans être servis : `"rpc session.foo"`, `"GET /api/config"`, `"server-request ..."` → nombre de fois. */
  unhandled(): Record<string, number>;
  /** Événements de Jarod sans équivalent côté shell, par type. */
  ignoredEvents(): Record<string, number>;
  /** Branche les canaux de pilotage (`POST /api/jarod/invoke`) ; sans cela la route répond 404. */
  attachBridge(port: BridgePort): void;
  /** Le lien avec la fenêtre : événements poussés et gestes natifs demandés (boîtes « Ouvrir », confirmations…). */
  readonly link: ShellLink;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Conn {
  ws: WsConnection;
  pending: Map<string, (result: unknown) => void>;
}

const MAX_ONESHOT_CHARS = 200_000;
/** Le shell abandonne à 150 s : la passerelle s'arrête avant lui. */
const ONESHOT_TIMEOUT_MS = 120_000;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function createGateway(opts: GatewayOptions): Gateway {
  const { core, version } = opts;
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const log = opts.log ?? (() => {});
  const triggerWaitMs = opts.triggerWaitMs ?? 30_000;
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 10 * 60_000;
  const shellTimeoutMs = opts.shellTimeoutMs ?? 60 * 60_000;
  const replayEpoch = randomBytes(6).toString("hex");
  const unhandled = new Map<string, number>();
  const ignored = new Map<string, number>();
  const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
  const conns = new Set<Conn>();
  const turns = new Map<string, TurnTranslator>();
  let serverRequestSeq = 0;
  let bridge: BridgePort | null = null;

  const send = (conn: Conn, frame: unknown) => conn.ws.send(JSON.stringify(frame));

  /**
   * Une requête du serveur vers le shell (l'accord d'un outil) ; sans réponse (connexion fermée, ou fenêtre muette passé `timeoutMs`) : `null`, donc refus.
   * À l'échéance la demande est retirée de `conn.pending` : une réponse tardive ne trouve plus rien et ne réveille personne, et `onTimeout` prévient la fenêtre.
   */
  const askClient = (conn: Conn, method: string, params: Record<string, unknown>, timeoutMs: number, onTimeout?: () => void): Promise<unknown> =>
    new Promise((resolve) => {
      if (conn.ws.closed) return resolve(null);
      const id = `srv-${++serverRequestSeq}`;
      const timer = setTimeout(() => {
        if (!conn.pending.delete(id)) return;
        resolve(null);
        try {
          onTimeout?.();
        } catch {
          // la fenêtre a disparu entre-temps : le refus suffit
        }
      }, timeoutMs);
      timer.unref?.();
      conn.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      send(conn, { jsonrpc: "2.0", id, method, params });
    });

  /** La demande d'accord d'un outil ou d'une commande, posée dans la carte de Herald ; sans réponse (connexion fermée) : refus. */
  const approveWith = async (conn: Conn, sessionId: string, call: { name: string; args: Record<string, unknown> }, description: string): Promise<boolean> => {
    const answer = await askClient(conn, "approval", approvalParams(sessionId, `appr-${randomBytes(4).toString("hex")}`, call, description), approvalTimeoutMs, () => {
      const waited = approvalTimeoutMs >= 60_000 ? `${Math.round(approvalTimeoutMs / 60_000)} min` : `${Math.max(1, Math.ceil(approvalTimeoutMs / 1000))} s`;
      if (!conn.ws.closed) send(conn, eventFrame("status.update", sessionId, { kind: "approval-timeout", text: `Aucune réponse à la demande d'accord pour « ${call.name} » en ${waited} : refusée.` }));
    });
    return isApproved(answer);
  };

  /** Le dossier de travail : celui que l'utilisateur a choisi dans les réglages (boîte native) s'il existe, sinon celui de la passerelle (`--workspace`, `JAROD_WORKSPACE`). */
  const currentWorkspace = (): string | undefined => {
    const chosen = core.settings.get("workspace");
    if (typeof chosen === "string" && chosen) {
      try {
        if (statSync(chosen).isDirectory()) return chosen;
      } catch {
        // un dossier disparu : on retombe sur celui de la passerelle
      }
    }
    return opts.workspace;
  };

  const info = (id: string): Record<string, unknown> => {
    const session = core.sessions.get(id);
    if (!session) throw new RpcError(RPC.params, `unknown session ${id}`);
    const provider = str(core.settings.get("activeProvider"));
    const model = str(core.settings.get("activeModel"));
    return sessionInfo({
      session,
      running: turns.has(id),
      version,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(session.context?.workspace ? { cwd: session.context.workspace } : {}),
    });
  };

  /** Les réglages en écriture ; un faux noyau sans `patch` ne les offre pas. */
  const settingsPort = () => {
    const s = core.settings;
    if (!s.patch) throw new RpcError(RPC.notFound, "settings are not available");
    return { get: (k: string) => s.get(k), patch: (p: Record<string, unknown>) => s.patch!(p) };
  };
  const providerList = (): readonly ProviderLike[] => core.providers?.list() ?? [];
  // Les modèles que les serveurs locaux proposent à cet instant (LM Studio, Ollama…) : sans cela le sélecteur de Herald reste vide.
  const providers = core.providers;
  const discovery = new ModelDiscovery({
    list: providerList,
    ...(providers?.client ? { fetchModels: (id: string) => providers.client!(id).listModels() } : {}),
  });
  /** Une erreur de configuration devient une erreur de paramètres (le shell l'affiche telle quelle). */
  const settingsRpc = <T,>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ConfigError) throw new RpcError(RPC.params, e.message);
      throw e;
    }
  };

  type Method = (params: Record<string, unknown>, conn: Conn) => unknown | Promise<unknown>;
  const methods: Record<string, Method> = {
    "gateway.ping": () => ({}),

    // Une complétion unique, sans conversation ni outil, sur le modèle actif : le panneau « Catch-up » s'en sert. `template` n'existe pas ici.
    "llm.oneshot": async (p) => {
      const agent = core.agent;
      if (!agent) throw new RpcError(RPC.notFound, "one-shot generation is not available");
      if (str(p.template).trim()) throw new RpcError(RPC.params, "llm.oneshot: les modèles (template) ne sont pas pris en charge ici, envoyer instructions/input");
      const instructions = str(p.instructions).trim();
      const input = str(p.input).trim();
      if (!instructions && !input) throw new RpcError(RPC.params, "llm.oneshot requires instructions/input");
      if (instructions.length + input.length > MAX_ONESHOT_CHARS) throw new RpcError(RPC.params, `llm.oneshot: texte trop long (${MAX_ONESHOT_CHARS} caractères au plus)`);
      const maxTokens = typeof p.max_tokens === "number" && Number.isInteger(p.max_tokens) && p.max_tokens > 0 ? Math.min(p.max_tokens, 8192) : undefined;
      try {
        const text = await agent.complete(input || instructions, AbortSignal.timeout(ONESHOT_TIMEOUT_MS), {
          ...(input && instructions ? { system: instructions } : {}),
          thinking: false,
          ...(maxTokens ? { maxTokens } : {}),
        });
        return { text };
      } catch (e) {
        throw new RpcError(5030, `one-shot generation failed: ${redactText(e instanceof Error ? e.message : String(e)).slice(0, 400)}`);
      }
    },

    // Les canaux de pilotage (@jarod/bridge) par le WebSocket : sans le délai de 60 s de l'HTTP du shell (installer un moteur, télécharger un modèle).
    "jarod.invoke": async (p) => {
      if (!bridge) throw new RpcError(RPC.notFound, "les canaux de pilotage ne sont pas branchés");
      try {
        const call = parseInvokeBody(p);
        return { result: (await bridge.invoke(call.channel, call.args)) ?? null };
      } catch (e) {
        if (e instanceof BridgeError) throw new RpcError(e.status === 404 ? RPC.notFound : RPC.params, e.message);
        throw e;
      }
    },

    "session.create": (p) => {
      const title = str(p.title).trim();
      const session = core.sessions.create(title || undefined);
      const cwd = chooseWorkspace(str(p.cwd).trim(), currentWorkspace());
      if (cwd) core.updateSessionContext(session.id, { workspace: cwd });
      return { session_id: session.id, stored_session_id: session.id, message_count: 0, messages: [], info: info(session.id) };
    },

    "session.resume": (p) => {
      const id = str(p.session_id);
      const messages = core.messages.list(id);
      const base = info(id);
      return {
        session_id: id,
        stored_session_id: id,
        message_count: messages.length,
        messages: p.omit_messages ? [] : toTranscript(messages),
        messages_omitted: p.omit_messages ? true : null,
        info: base,
        running: turns.has(id),
        inflight: null,
      };
    },

    "session.list": (p) => {
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 500) : 200;
      return { sessions: core.sessions.list(limit).map((s) => sessionRow(s)) };
    },

    "session.delete": (p) => {
      const id = str(p.session_id);
      if (!core.sessions.get(id)) throw new RpcError(RPC.params, `unknown session ${id}`);
      core.stop(id);
      core.sessions.delete(id);
      return { deleted: id };
    },

    "session.interrupt": (p) => {
      const id = str(p.session_id);
      const turn = turns.get(id);
      if (!turn) return { status: "not_interrupted", interrupted: false };
      turn.markAborted();
      core.stop(id);
      return { status: "interrupted", interrupted: true };
    },

    "prompt.submit": (p, conn) => {
      const id = str(p.session_id);
      if (!core.sessions.get(id)) throw new RpcError(RPC.params, `unknown session ${id}`);
      const text = promptText(p.text).trim();
      if (!text) throw new RpcError(RPC.params, "empty prompt");
      // Avant de toucher à `turns` : un refus ne doit pas effacer le tour qui court (il ne pourrait plus être interrompu).
      if (turns.has(id)) throw new RpcError(-32000, "a turn is already running in this session");
      const translator = new TurnTranslator(id, (frame) => {
        if (!conn.ws.closed) send(conn, frame);
      });
      let lastTitle = core.sessions.get(id)?.title ?? "";
      // Le noyau pose le titre provisoire (le début du message) au PREMIER message du tour, avant tout `session-updated`, puis le remplace par un titre
      // généré après `done` : on regarde donc à chacun de ces trois événements, sinon l'interface garde « Nouvelle conversation ».
      const hooks: AgentHooks = {
        emit: (e) => {
          translator.handle(e);
          if (e.type === "message" || e.type === "session-updated" || e.type === "done") {
            const title = core.sessions.get(id)?.title ?? "";
            if (title && title !== lastTitle) {
              lastTitle = title;
              if (!conn.ws.closed) send(conn, eventFrame("session.title", id, { session_id: id, title }));
            }
          }
          if (e.type === "done") {
            turns.delete(id);
            for (const [type, n] of translator.ignored) ignored.set(type, (ignored.get(type) ?? 0) + n);
          }
        },
        approve: (sessionId, call, description) => approveWith(conn, sessionId, call, description),
      };
      turns.set(id, translator);
      const started = core.start(id, text, hooks);
      if (started.kind !== "started") {
        turns.delete(id);
        throw new RpcError(-32000, "a turn is already running in this session");
      }
      return { status: "streaming" };
    },

    // Les commandes `/` de Jarod comme complétions ; sans registre (faux noyau), un catalogue vide.
    "commands.catalog": () => (core.commands ? commandCatalog(core.commands) : { pairs: [], sub: {}, canon: {}, commands: {}, categories: [], skills: {}, skill_count: 0 }),

    // Réglages (section « Hermes & agents »). Une clé que la passerelle ne porte pas est une erreur nette, consignée par le serveur.
    "config.get": (p) => settingsRpc(() => configGet(str(p.key), settingsPort(), providerList())),
    "config.set": (p) => {
      const result = settingsRpc(() => configSet(str(p.key), p.value, settingsPort(), providerList()));
      if (str(p.key) === "model") discovery.invalidate(); // un autre fournisseur : on relit ses modèles à la prochaine ouverture du sélecteur
      return result;
    },
    "model.options": async (p) => modelOptions(await discovery.providers(), settingsPort(), p.include_unconfigured === true),

    // Une commande `/` tapée ou choisie dans l'interface : l'utilisateur est le principal, comme au composer de Jarod.
    // Les commandes qui changent la POSTURE DE SÉCURITÉ (GUARDED_COMMANDS : confiance des plugins, mode Build, dossier de travail, installation depuis le
    // réseau, suppression de fichiers, persona) passent par la voie gardée de Jarod : règle, accord dans la carte de Herald, audit. Sans cette voie (faux noyau),
    // elles sont REFUSÉES, jamais exécutées sans garde.
    "slash.exec": async (p, conn) => {
      if (!core.commands) throw new RpcError(RPC.notFound, "commands are not available");
      const command = str(p.command).trim();
      if (!command.startsWith("/")) throw new RpcError(RPC.params, "command must start with /");
      const sid = str(p.session_id);
      if (sid && !core.sessions.get(sid)) throw new RpcError(RPC.params, `unknown session ${sid}`);
      const name = /^\/([\w-]+)/.exec(command)?.[1]?.toLowerCase() ?? "";
      if (GUARDED_COMMANDS.has(name)) {
        if (!core.executeRemoteCommand) throw new RpcError(RPC.params, `/${name} change la posture de sécurité : il faut la voie gardée de Jarod, absente ici`);
        const hooks: AgentHooks = { emit: () => {}, approve: (sessionId, call, description) => approveWith(conn, sessionId, call, description) };
        return slashResult(await core.executeRemoteCommand(command, sid || null, hooks), command);
      }
      // Le sélecteur de Herald écrit « fournisseur:modèle » ; la commande de Jarod lit « fournisseur/modèle ». Changer de modèle relit les modèles locaux.
      if (name === "model") discovery.invalidate();
      const effective = name === "model" ? normalizeModelCommand(command, providerList()) : command;
      return slashResult(await core.commands.execute(effective, { sessionId: sid || null }), command);
    },
  };

  const handleFrame = async (conn: Conn, text: string): Promise<void> => {
    let frame: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return send(conn, { jsonrpc: "2.0", id: null, error: { code: RPC.parse, message: "parse error" } });
    }
    // Une réponse à une requête du serveur (l'accord d'un outil).
    if (typeof frame.method !== "string") {
      const resolver = typeof frame.id === "string" ? conn.pending.get(frame.id) : undefined;
      if (resolver && typeof frame.id === "string") {
        conn.pending.delete(frame.id);
        resolver(frame.error ? null : frame.result);
      }
      return;
    }
    const id = frame.id;
    const fn = methods[frame.method];
    if (!fn) {
      bump(unhandled, `rpc ${frame.method}`);
      log(`rpc non servi : ${frame.method}`);
      if (id !== undefined) send(conn, { jsonrpc: "2.0", id, error: { code: RPC.notFound, message: UNAVAILABLE_RPC.has(frame.method) ? NOT_AVAILABLE : `method not found: ${frame.method}` } });
      return;
    }
    try {
      const params = frame.params && typeof frame.params === "object" ? (frame.params as Record<string, unknown>) : {};
      const result = await fn(params, conn);
      if (id !== undefined) send(conn, { jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const raw = e instanceof RpcError ? e : new RpcError(RPC.internal, e instanceof Error ? e.message : String(e));
      // Un message d'erreur peut citer ce qui a échoué — une URL avec un jeton, une clé recopiée dans un texte :
      // il est masqué ici, une seule fois, pour le journal comme pour la fenêtre.
      const err = new RpcError(raw.code, redactText(raw.message));
      log(`rpc ${frame.method} : ${err.message}`);
      if (id !== undefined) send(conn, { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } });
    }
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const MAX_BODY = 1024 * 1024;
  /** Le corps JSON d'une requête (1 Mio au plus) ; vide = `{}`. */
  const readJson = (req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, "request body too large"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8").trim();
        if (!text) return resolve({});
        try {
          const v = JSON.parse(text) as unknown;
          if (v && typeof v === "object" && !Array.isArray(v)) resolve(v as Record<string, unknown>);
          else reject(new HttpError(400, "JSON object expected"));
        } catch {
          reject(new HttpError(400, "invalid JSON"));
        }
      });
      req.on("error", reject);
    });

  /** « local » (ou rien) : la réponse reste dans Hermes ; une livraison vers une messagerie n'est pas encore portée. */
  const requireLocal = (deliver: unknown) => {
    if (deliver !== undefined && deliver !== null && deliver !== "" && deliver !== "local") throw new HttpError(400, `delivery target '${String(deliver)}' is not supported yet; only 'local'`);
  };

  /** Les routes `/api/cron/…` : retourne `true` si la requête a été servie. */
  const cronRoutes = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const sched = core.scheduler;
    if (!sched) return false;
    const ok = (status: number, body: unknown): true => {
      json(res, status, body);
      return true;
    };
    const method = req.method ?? "GET";
    const one = (id: string) => {
      const s = sched.get(id);
      if (!s) throw new HttpError(404, `job ${id} not found`);
      return s;
    };
    const asJob = (s: Parameters<typeof cronJobs>[0][number]) => cronJobs([s])[0];
    const spec = (text: unknown) => {
      try {
        return parseScheduleText(str(text));
      } catch (e) {
        throw e instanceof ScheduleTextError ? new HttpError(400, e.message) : e;
      }
    };
    const save = (input: Parameters<SchedulerLike["save"]>[0]) => {
      try {
        return sched.save(input);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    };

    if (path === "/api/cron/delivery-targets" && method === "GET") return ok(200, { targets: [] });
    if (path === "/api/cron/jobs" && method === "GET") return ok(200, cronJobs(sched.list()));
    if (path === "/api/cron/jobs" && method === "POST") {
      const b = await readJson(req);
      requireLocal(b.deliver);
      if (b.no_agent === true || (typeof b.script === "string" && b.script.trim())) throw new HttpError(400, "script-only jobs (no_agent / script) are not supported by Jarod");
      if (Array.isArray(b.skills) && b.skills.length > 0) throw new HttpError(400, "per-job skills are not supported by Jarod");
      const prompt = str(b.prompt).trim();
      const name = str(b.name).trim() || prompt.slice(0, 40);
      return ok(201, asJob(save({ name, prompt, spec: spec(b.schedule), enabled: true, deliver: null })));
    }
    const m = /^\/api\/cron\/jobs\/([^/]+)(?:\/(pause|resume|trigger|runs))?$/.exec(path);
    if (!m) return false;
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    if (!action && method === "PUT") {
      const existing = one(id);
      const updates = (await readJson(req)).updates;
      if (!updates || typeof updates !== "object") throw new HttpError(400, "'updates' object expected");
      const u = updates as Record<string, unknown>;
      if ("deliver" in u) requireLocal(u.deliver);
      const saved = save({
        id,
        name: "name" in u ? str(u.name).trim() : existing.name,
        prompt: "prompt" in u ? str(u.prompt).trim() : existing.prompt,
        spec: "schedule" in u ? spec(u.schedule) : existing.spec,
        enabled: existing.enabled,
        // `deliver: "local"` demandé explicitement retire la livraison ; absent, on ne touche à rien.
        ...("deliver" in u ? { deliver: null } : {}),
      });
      return ok(200, asJob(saved));
    }
    if (!action && method === "DELETE") {
      one(id);
      sched.delete(id);
      return ok(200, { ok: true });
    }
    if ((action === "pause" || action === "resume") && method === "POST") {
      const s = one(id);
      return ok(200, asJob(save({ id, name: s.name, prompt: s.prompt, spec: s.spec, enabled: action === "resume" })));
    }
    if (action === "trigger" && method === "POST") {
      one(id);
      // L'exécution est un tour d'agent complet. Herald relit la liste UNE fois juste après cette réponse (sans interroger ensuite) : répondre
      // tout de suite lui montrait « Not run yet » puis un historique vide (la conversation de l'exécution n'existe qu'à la fin). On attend donc la
      // fin, au plus `triggerWaitMs` ; une exécution plus longue continue seule et se lit ensuite dans la liste (`last_status`).
      const run = sched.runNow(id).catch((e: unknown) => log(`trigger ${id} : ${e instanceof Error ? e.message : String(e)}`));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, triggerWaitMs)))]);
      clearTimeout(timer);
      return ok(200, { ok: true, status: "triggered" });
    }
    if (action === "runs" && method === "GET") {
      const s = one(id);
      const conv = s.sessionId ? core.sessions.get(s.sessionId) : undefined;
      // Les exécutions de Jarod s'ajoutent à UNE conversation : on la présente comme l'unique ligne d'historique.
      const runs = conv ? [{ id: conv.id, title: conv.title, started_at: s.lastRun === null ? null : Math.floor(s.lastRun / 1000), message_count: conv.messageCount, is_active: false }] : [];
      return ok(200, { runs });
    }
    return false;
  };

  /** `/api/config` et `/api/tools/…` : réglages, groupes d'outils, terrain d'exécution. Retourne `true` si la requête a été servie. */
  const configRoutes = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const method = req.method ?? "GET";
    const asHttp = <T,>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.message);
        throw e;
      }
    };
    const done = (status: number, body: unknown): true => {
      json(res, status, body);
      return true;
    };
    const settings = core.settings;
    if (path === "/api/config" && settings.patch) {
      if (method === "GET") return done(200, hermesConfig(settingsPort()));
      if (method === "PUT") {
        const body = await readJson(req);
        asHttp(() => applyConfigPatch(body.config, settingsPort(), providerList()));
        discovery.invalidate();
        return done(200, hermesConfig(settingsPort()));
      }
    }
    if (path === "/api/config/raw") {
      if (method === "GET") return done(200, configRaw(settings));
      throw new HttpError(405, CONFIG_RAW_READ_ONLY);
    }
    if (path === "/api/tools/terminal/backends" && method === "GET") return done(200, terminalBackends());
    if (path === "/api/tools/terminal/backend" && method === "PUT") {
      const body = await readJson(req);
      asHttp(() => checkTerminalBackend(body));
      return done(200, terminalBackends());
    }
    if (core.tools && settings.patch) {
      const tools = core.tools.all();
      const disabled = () => (Array.isArray(settings.get("disabledTools")) ? (settings.get("disabledTools") as string[]) : []);
      if (path === "/api/tools/toolsets" && method === "GET") return done(200, toolsets(tools, disabled()));
      const m = /^\/api\/tools\/toolsets\/([^/]+)$/.exec(path);
      if (m && method === "PUT") {
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
        const next = asHttp(() => setToolsetEnabled(decodeURIComponent(m[1]!), body.enabled as boolean, tools, disabled()));
        settings.patch({ disabledTools: next });
        return done(200, { ok: true, name: decodeURIComponent(m[1]!), enabled: body.enabled });
      }
    }
    return false;
  };

  /** `/api/jarod/providers…` : fournisseurs de modèles et clés API (écran « Providers »). Les clés entrent, ne ressortent jamais. Retourne `true` si servie. */
  const providerRoutes = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const method = req.method ?? "GET";
    const done = (status: number, body: unknown): true => {
      json(res, status, body);
      return true;
    };
    const asHttp = <T,>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.message);
        throw e;
      }
    };
    const settings = core.settings;
    const router = core.providers;
    if (!router || !settings.patch || !settings.setSecret) return false;
    const port = { get: (k: string) => settings.get(k), patch: (p: Record<string, unknown>) => settings.patch!(p), setSecret: (k: string, v: string) => settings.setSecret!(k, v) };
    const sources = () => (settings as { keySources?: () => KeySources }).keySources?.();
    const snapshot = () => providerRows(router.list(), str(settings.get("activeProvider")), str(settings.get("activeModel")), sources());
    if (path === "/api/jarod/providers" && method === "GET") return done(200, snapshot());
    const m = /^\/api\/jarod\/providers\/([^/]+)(?:\/(key|extra-keys|test))?$/.exec(path);
    if (!m) return false;
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    if (!action && method === "PUT") {
      const body = await readJson(req);
      asHttp(() => setProviderOverride(port, router.list(), id, body));
      discovery.invalidate();
      return done(200, snapshot());
    }
    if (action === "key" && method === "PUT") {
      const body = await readJson(req);
      asHttp(() => setProviderKey(port, router.list(), id, body.key));
      discovery.invalidate();
      return done(200, snapshot());
    }
    if (action === "key" && method === "DELETE") {
      asHttp(() => clearProviderKey(port, router.list(), id));
      discovery.invalidate();
      return done(200, snapshot());
    }
    if (action === "extra-keys" && method === "PUT") {
      const body = await readJson(req);
      if (!router.setExtraKeys) throw new HttpError(404, "extra keys are not available");
      asHttp(() => setExtraProviderKeys({ list: () => router.list(), setExtraKeys: (pid, keys) => router.setExtraKeys!(pid, keys), client: (pid) => router.client!(pid) }, id, body.keys));
      return done(200, snapshot());
    }
    if (action === "test" && method === "POST") {
      if (!router.client) throw new HttpError(404, "provider test is not available");
      const result = await testProvider({ list: () => router.list(), setExtraKeys: () => {}, client: (pid) => router.client!(pid) }, id).catch((e: unknown) => {
        throw e instanceof ConfigError ? new HttpError(400, e.message) : e;
      });
      return done(200, result);
    }
    return false;
  };

  /** `/api/mcp/…` et `/api/messaging/…` : serveurs MCP et plateformes de messagerie. Retourne `true` si la requête a été servie. */
  const connectionsRoutes = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const method = req.method ?? "GET";
    const done = (status: number, body: unknown): true => {
      json(res, status, body);
      return true;
    };
    const asHttp = <T,>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.message);
        throw e;
      }
    };
    const settings = core.settings;
    // Le noyau de Jarod est un objet cordis à services dynamiques : on n'en lit que le gestionnaire MCP.
    const mcp = (core.app as { mcp?: McpPort } | undefined)?.mcp;
    const configs = (): McpConfigLike[] => (Array.isArray(settings.get("mcpServers")) ? (settings.get("mcpServers") as McpConfigLike[]) : []);

    if (path === "/api/mcp/servers" && method === "GET") return done(200, mcpServers(configs(), mcp?.list() ?? []));
    // Jarod n'a pas de catalogue de serveurs MCP à installer en un clic : la liste vide est exacte.
    if (path === "/api/mcp/catalog" && method === "GET") return done(200, { entries: [] });
    if (path === "/api/mcp/catalog/install" && method === "POST") {
      await readJson(req);
      throw new HttpError(400, "Jarod n'a pas de catalogue MCP : ajouter un serveur dans l'écran MCP de Jarod.");
    }
    const m = /^\/api\/mcp\/servers\/([^/]+)(?:\/(enabled|test|auth))?$/.exec(path);
    if (m && settings.patch) {
      const name = decodeURIComponent(m[1]!);
      const action = m[2];
      if (action === "enabled" && method === "PUT") {
        const body = await readJson(req);
        const { next, changed } = asHttp(() => setMcpEnabled(configs(), name, body.enabled));
        settings.patch({ mcpServers: next });
        // Le démarrage d'un serveur peut être long : on répond tout de suite, l'état se lit dans la liste.
        void mcp?.restart(changed).catch((e: unknown) => log(`mcp ${name} : ${e instanceof Error ? e.message : String(e)}`));
        return done(200, { ok: true });
      }
      if (!action && method === "DELETE") {
        const next = asHttp(() => removeMcp(configs(), name));
        settings.patch({ mcpServers: next });
        void mcp?.sync(next).catch((e: unknown) => log(`mcp sync : ${e instanceof Error ? e.message : String(e)}`));
        return done(200, { ok: true });
      }
      if (action === "test" && method === "POST") {
        const cfg = asHttp(() => findMcp(configs(), name));
        if (!mcp) throw new HttpError(404, "MCP is not available");
        // Une connexion temporaire au serveur (qui peut être un processus lancé par sa commande) : bornée à 20 s.
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Le serveur n'a pas répondu en 20 s")), 20_000).unref());
        return done(200, probeResult(await Promise.race([mcp.probe(cfg), timeout]).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))));
      }
      if (action === "auth" && method === "POST") throw new HttpError(400, "La connexion OAuth d'un serveur MCP n'est pas portée par la passerelle de Jarod.");
    }
    if (path === "/api/messaging/platforms" && method === "GET" && core.gatewayHub) {
      const hub = core.gatewayHub;
      return done(200, messagingPlatforms((id) => settings.get(id) as { enabled?: boolean } | undefined, (id) => hub.gatewayStatus(id)));
    }
    const p = /^\/api\/messaging\/platforms\/([^/]+)$/.exec(path);
    if (p && method === "PUT") {
      const body = await readJson(req);
      const id = decodeURIComponent(p[1]!);
      // Sans le pont (faux noyau), l'activation reste refusée. Avec lui, la page Connexions fait la même chose que Réglages › Messaging — jamais plus : un canal sans
      // ses jetons ne s'allume pas (c'est l'écran de réglage qui les demande).
      if (!bridge) asHttp(() => refusePlatformToggle(id));
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
      try {
        if (body.enabled) {
          const all = (await bridge!.invoke("get-messaging-platforms", [])) as { platforms: { id: string; configured: boolean }[] };
          const platform = all.platforms.find((x) => x.id === id);
          if (!platform) throw new HttpError(404, `${id} : canal inconnu`);
          if (!platform.configured) throw new HttpError(400, `${id} : pas encore configuré — saisissez ses jetons dans Réglages › Messaging`);
        }
        await bridge!.invoke("set-platform-enabled", [id, body.enabled]);
      } catch (e) {
        if (e instanceof BridgeError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return done(200, { ok: true });
    }
    return false;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, { status: "ok", version, backend: "jarod" });
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { detail: "not found" });
    if (!sameSecret(req.headers["x-hermes-session-token"], token)) {
      req.resume();
      return json(res, 401, { detail: "invalid session token" });
    }
    if (req.method === "GET" && url.pathname === "/api/memory" && core.memory) return json(res, 200, memoryStatus(core.memory.list().length));
    // La page Mémoire de Herald : les deux « fichiers » (MEMORY.md, USER.md) bâtis sur la mémoire et le profil de Jarod.
    if (url.pathname.startsWith("/api/memory/files") && core.memory && core.userProfile) {
      const mem = core.memory;
      const profile = core.userProfile;
      if (req.method === "GET" && url.pathname === "/api/memory/files") return json(res, 200, { files: memoryFiles(mem, profile) });
      const m = /^\/api\/memory\/files\/([^/]+)$/.exec(url.pathname);
      const name = m ? decodeURIComponent(m[1]!) : "";
      if (req.method === "PUT" && (MEMORY_FILE_NAMES as readonly string[]).includes(name)) {
        const body = await readJson(req);
        try {
          writeMemoryFile(name as MemoryFileName, checkTexts(body), mem, profile);
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
        return json(res, 200, { files: memoryFiles(mem, profile) });
      }
    }
    // Jetons et coût par jour et par modèle, tirés des messages de l'assistant.
    if (req.method === "GET" && url.pathname === "/api/analytics/usage" && core.db) {
      let days: number;
      try {
        days = parseDays(url.searchParams.get("days"));
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      const now = Date.now();
      return json(res, 200, analytics(core.db.all<UsageRow>(USAGE_SQL, periodStart(days, now)), days, now));
    }
    if (url.pathname.startsWith("/api/mcp/") || url.pathname.startsWith("/api/messaging/")) {
      if (await connectionsRoutes(req, res, url.pathname)) return;
    }
    // Les fournisseurs de modèles de Jarod se connectent par clé d'API ou par serveur local : aucun module du noyau n'utilise OAuth (recherche dans
    // packages/plugins/*/src : 0 occurrence). La liste vide est exacte.
    if (req.method === "GET" && url.pathname === "/api/providers/oauth") return json(res, 200, { providers: [] });
    if (url.pathname.startsWith("/api/jarod/providers") && (await providerRoutes(req, res, url.pathname))) return;
    if (url.pathname === "/api/config" || url.pathname === "/api/config/raw" || url.pathname.startsWith("/api/tools/")) {
      if (await configRoutes(req, res, url.pathname)) return;
    }
    if (url.pathname.startsWith("/api/cron/") && (await cronRoutes(req, res, url.pathname))) return;
    // Les messages stockés d'une conversation (le panneau « Catch-up » lit où elle s'est arrêtée).
    const stored = req.method === "GET" ? /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname) : null;
    if (stored) {
      const sid = decodeURIComponent(stored[1]!);
      if (!core.sessions.get(sid)) throw new HttpError(404, `unknown session ${sid}`);
      return json(res, 200, storedMessages(core.messages.list(sid), { limit: Number(url.searchParams.get("limit")), order: url.searchParams.get("order") ?? undefined }));
    }
    // La voix du shell : transcrire un énoncé, dire une réponse (WAV). Les fautes de configuration (pas de clé, pas de moteur vocal) arrivent avec les mots du noyau.
    if (url.pathname === "/api/audio/transcribe" && req.method === "POST") {
      if (!opts.voice) throw new HttpError(404, "la voix n'est pas branchée");
      try {
        const body = await readJson(req, MAX_AUDIO_BODY);
        const audio = parseDataUrl(body.data_url, body.mime_type);
        const transcript = await opts.voice.transcribe(audio.bytes, audio.mime);
        return json(res, 200, { ok: true, transcript });
      } catch (e) {
        if (e instanceof AudioError) throw new HttpError(e.status, e.message);
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, redactText(e instanceof Error ? e.message : String(e)).slice(0, 600));
      }
    }
    if (url.pathname === "/api/audio/speak" && req.method === "POST") {
      if (!opts.voice) throw new HttpError(404, "la voix n'est pas branchée");
      try {
        const text = speakText((await readJson(req)).text);
        return json(res, 200, { ok: true, data_url: wavDataUrl(await opts.voice.synthesize(text)) });
      } catch (e) {
        if (e instanceof AudioError) throw new HttpError(e.status, e.message);
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, redactText(e instanceof Error ? e.message : String(e)).slice(0, 600));
      }
    }
    if (url.pathname === "/api/jarod/invoke" && req.method === "POST") {
      if (!bridge) throw new HttpError(404, "les canaux de pilotage ne sont pas branchés");
      const body = await readJson(req);
      try {
        const call = parseInvokeBody(body);
        const result = await bridge.invoke(call.channel, call.args);
        return json(res, 200, { result: result ?? null });
      } catch (e) {
        if (e instanceof BridgeError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    const key = `${req.method} ${url.pathname}`;
    bump(unhandled, key);
    log(`REST non servi : ${key}`);
    // On vide le corps avant de répondre, pour ne pas laisser la connexion en suspens.
    req.resume();
    return json(res, 404, { detail: isUnavailableRest(req.method ?? "GET", url.pathname) ? NOT_AVAILABLE : `not implemented by the Jarod gateway: ${key}` });
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return json(res, e.status, { detail: redactText(e.message) });
      // Le chemin seul : `req.url` porte la *query string*, où un appelant peut avoir mis un jeton.
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      log(`REST ${req.method} ${path} : ${redactText(e instanceof Error ? e.message : String(e))}`);
      json(res, 500, { detail: "internal error" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Le jeton vient d'abord du sous-protocole (notre fenêtre : il ne traîne alors dans aucune URL), puis de la query string
    // et de l'en-tête, que les clients Hermes existants utilisent (`hermes` en ligne de commande, une autre fenêtre).
    const supplied = wsProtocolToken(req) ?? url.searchParams.get("token") ?? req.headers["x-hermes-session-token"];
    const authed = sameSecret(supplied, token);
    // Le flux de voix phrase par phrase n'est pas servi : on répond « repli » tout de suite, la fenêtre dit alors la réponse entière par `/api/audio/speak`.
    if (url.pathname === "/api/audio/speak-stream" && authed) {
      const stream = acceptUpgrade(req, socket, head, { onText: () => {}, onClose: () => {} }, wsSelectedProtocol(req));
      stream?.send(JSON.stringify({ type: "fallback" }));
      stream?.close();
      return;
    }
    if (url.pathname !== "/api/ws" || !authed) {
      socket.end(`HTTP/1.1 ${url.pathname === "/api/ws" ? "401 Unauthorized" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const conn: Conn = { ws: undefined as unknown as WsConnection, pending: new Map() };
    const ws = acceptUpgrade(req, socket, head, {
      // Différé d'un tour : `conn.ws` n'est posé qu'au retour de `acceptUpgrade`.
      onText: (text) => queueMicrotask(() => void handleFrame(conn, text)),
      onClose: () => {
        conns.delete(conn);
        for (const resolve of conn.pending.values()) resolve(null);
        conn.pending.clear();
      },
    }, wsSelectedProtocol(req));
    if (!ws) return;
    conn.ws = ws;
    conns.add(conn);
    send(conn, readyFrame(replayEpoch));
  });

  return {
    token,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const id of [...turns.keys()]) core.stop(id);
        for (const c of conns) c.ws.close(1001);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    unhandled: () => Object.fromEntries(unhandled),
    ignoredEvents: () => Object.fromEntries(ignored),
    attachBridge: (port) => {
      bridge = port;
    },
    link: {
      send: (channel, args) => {
        for (const c of conns) send(c, eventFrame("jarod.event", undefined, { channel, args }));
      },
      // La demande va à la fenêtre la plus récemment connectée ; sans fenêtre, `null` (refus).
      ask: async (kind, params = {}) => {
        const conn = [...conns].at(-1);
        if (!conn) return null;
        // La fenêtre répond par un objet (contrat des requêtes serveur → client) : la valeur est dans `value`.
        const answer = await askClient(conn, "jarod.shell", { kind, ...params }, shellTimeoutMs);
        return answer && typeof answer === "object" ? ((answer as { value?: unknown }).value ?? null) : null;
      },
    },
  };
}
