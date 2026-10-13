// Client du moteur Pinokio (pinokiod, MIT) que Jarod-OS embarque (DECISIONS.md, ADR-022). Le shell le démarre à la demande et
// annonce son adresse au cœur par JAROD_PINOKIO_URL (http://127.0.0.1:42000) ; s'il ne répond pas encore, le cœur demande au shell
// de le démarrer par le socket de contrôle (commande `pinokio.start`, HERALD_OS_CONTROL_SOCKET + HERALD_OS_CONTROL_TOKEN).
//
// L'API est celle qu'utilise `pterm`, l'outil en ligne de commande de Pinokio : HTTP pour l'état (/apps/search, /apps/status,
// /apps/logs, /info/apps), WebSocket JSON pour l'exécution (un script, `app.download`, `kernel.api.stop`). Le registre public des
// apps (« Discover ») est https://api.pinokio.co/v1/search.
import { connect } from "node:net";

export const REGISTRY_URL = "https://api.pinokio.co";

/** Un paquet du WebSocket de pinokiod : `stream` (sortie de terminal), `result`, `error`, `stop`, `disconnect`… */
export interface Packet {
  type?: string;
  id?: string;
  data?: unknown;
}

export interface PinokioDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Demande au shell de démarrer le moteur ; rend vrai s'il répond ensuite. Remplaçable dans les tests. */
  startEngine?: () => Promise<boolean>;
  /** Une session WebSocket : envoie `message`, rend chaque paquet à `onPacket` jusqu'à ce qu'il rende vrai, puis ferme. */
  socket?: (url: string, message: unknown, onPacket: (packet: Packet) => boolean, timeoutMs: number, signal?: AbortSignal) => Promise<"done" | "closed" | "timeout">;
}

export function pinokioUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.JAROD_PINOKIO_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** Une requête `ui` au shell par son socket de contrôle (lignes JSON ; port TCP local sous Windows, socket Unix ailleurs). */
export function askShell(command: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 120_000, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const endpoint = (env.HERALD_OS_CONTROL_SOCKET ?? env.HERMES_OS_CONTROL_SOCKET)?.trim();
  const token = env.HERALD_OS_CONTROL_TOKEN ?? env.HERMES_OS_CONTROL_TOKEN;
  if (!endpoint || !token) return Promise.reject(new Error("Jarod-OS n'a pas donné son socket de contrôle : lancez le moteur Pinokio depuis sa fenêtre."));
  return new Promise((resolve, reject) => {
    const tcp = /^tcp:\/\/([^:]+):(\d+)$/.exec(endpoint);
    const socket = tcp ? connect(Number(tcp[2]), tcp[1]) : connect(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Jarod-OS n'a pas répondu à temps"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ cmd: "ui", token, command, args, source: "agent" })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** La session WebSocket par défaut : le WebSocket global de Node (22+). */
export const realSocket: NonNullable<PinokioDeps["socket"]> = (url, message, onPacket, timeoutMs, signal) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (how: "done" | "closed" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // déjà fermé
      }
      resolve(how);
    };
    const onAbort = () => finish("timeout");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => ws.send(JSON.stringify(message)));
    ws.addEventListener("message", (event) => {
      let packet: Packet;
      try {
        packet = JSON.parse(String(event.data)) as Packet;
      } catch {
        return;
      }
      if (onPacket(packet)) finish("done");
    });
    ws.addEventListener("close", () => finish("closed"));
    ws.addEventListener("error", () => finish("closed"));
  });

export class PinokioClient {
  readonly base: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly socketImpl: NonNullable<PinokioDeps["socket"]>;
  private readonly startEngine: () => Promise<boolean>;

  constructor(deps: PinokioDeps = {}) {
    this.env = deps.env ?? process.env;
    this.base = pinokioUrl(this.env);
    this.fetchImpl = deps.fetch ?? fetch;
    this.socketImpl = deps.socket ?? realSocket;
    this.startEngine =
      deps.startEngine ??
      (async () => {
        const reply = await askShell("pinokio.start", this.env);
        if (reply.ok === false) throw new Error(String(reply.error ?? reply.summary ?? "le moteur Pinokio n'a pas démarré"));
        return this.alive();
      });
  }

  get available(): boolean {
    return this.base !== null;
  }

  async alive(): Promise<boolean> {
    if (!this.base) return false;
    try {
      const response = await this.fetchImpl(`${this.base}/pinokio/version`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Le moteur répond, quitte à le faire démarrer par Jarod-OS. */
  async ensure(): Promise<string> {
    if (!this.base) throw new Error("Cette version de Jarod-OS n'embarque pas le moteur Pinokio.");
    if (await this.alive()) return this.base;
    if (!(await this.startEngine())) throw new Error("Le moteur Pinokio ne répond pas.");
    return this.base;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<{ status: number; body: T }> {
    const base = await this.ensure();
    return this.getUrl<T>(`${base}${path}`, query, signal);
  }

  async getUrl<T>(url: string, query: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<{ status: number; body: T }> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") target.searchParams.set(key, String(value));
    const response = await this.fetchImpl(target, { signal: signal ?? AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // une réponse texte reste du texte
    }
    return { status: response.status, body: body as T };
  }

  /** Une session WebSocket sur le moteur (démarré au besoin). */
  async session(message: unknown, onPacket: (packet: Packet) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<"done" | "closed" | "timeout"> {
    const base = await this.ensure();
    return this.socketImpl(base.replace(/^http/, "ws"), message, onPacket, timeoutMs, signal);
  }
}

/** Le texte lisible d'un paquet `stream` (sortie de terminal), séquences ANSI retirées. */
export function streamText(packet: Packet): string {
  const data = packet.data as { raw?: unknown } | undefined;
  const raw = typeof data?.raw === "string" ? data.raw : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: on retire justement les séquences d'échappement du terminal.
  return raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-_]/g, "").replace(/\r(?!\n)/g, "\n");
}

/** Garde les `max` derniers caractères d'un journal, coupés à une fin de ligne. */
export function tail(text: string, max = 4_000): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const newline = cut.indexOf("\n");
  return `…${newline >= 0 ? cut.slice(newline + 1) : cut}`;
}
