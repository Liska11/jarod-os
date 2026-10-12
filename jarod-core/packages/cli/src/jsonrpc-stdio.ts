// SPECS-P5-MCP.md §3 : transport JSON-RPC 2.0 délimité par des retours à la ligne, partagé par `jarod mcp` et `jarod acp`.
// Écrit à la main, sans SDK, et SANS aucun accès réseau (garde G2 : ni `net`, ni `http`, ni `fetch`) : il ne lit qu'un flux d'entrée et n'écrit
// que sur un flux de sortie (stdin/stdout du processus). stdout ne porte que du protocole : une réponse = une ligne JSON valide.
import type { Readable, Writable } from "node:stream";
import { redactText } from "@jarod/kernel/redact";

/** Codes JSON-RPC 2.0. */
export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** Erreur qui doit parvenir au client telle quelle (code et message choisis par le gestionnaire). */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Id = string | number;
interface Wire {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface JsonRpcOptions {
  input: Readable;
  output: Writable;
  /** Une requête (avec `id`) : la valeur rendue devient `result`. Peut lever `RpcError`. Appelée en parallèle des autres. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** Une notification (sans `id`) : jamais de réponse, même en cas d'erreur. */
  onNotification?(method: string, params: unknown): void | Promise<void>;
  /** Longueur maximale d'une ligne (défaut 8 Mo) : au-delà, -32600 et la ligne est jetée. */
  maxLineBytes?: number;
}

export interface JsonRpcServer {
  /** Envoie une requête au client et attend sa réponse (rejetée si le transport se ferme). */
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /** Se résout quand l'entrée est fermée ET que tous les traitements en cours sont terminés. */
  readonly closed: Promise<void>;
}

const log = (s: string) => process.stderr.write(`${redactText(s)}\n`);

export function serveJsonRpc(opts: JsonRpcOptions): JsonRpcServer {
  const max = opts.maxLineBytes ?? 8 * 1024 * 1024;
  const { input, output } = opts;
  let broken = false;
  output.on("error", () => {
    broken = true;
  });
  output.on("close", () => {
    broken = true;
  });

  const write = (msg: object): void => {
    if (broken || output.destroyed || output.writableEnded) return;
    try {
      output.write(`${JSON.stringify(msg)}\n`);
    } catch {
      broken = true;
    }
  };
  const fail = (id: Id | null, code: number, message: string, data?: unknown): void =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const inflight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  let nextOut = 1;
  const pending = new Map<Id, { resolve(v: unknown): void; reject(e: Error): void }>();
  let ended = false;

  const handle = (line: string): void => {
    let msg: Wire | Wire[];
    try {
      msg = JSON.parse(line) as Wire | Wire[];
    } catch {
      return fail(null, ERR.parse, "JSON invalide");
    }
    if (Array.isArray(msg)) return fail(null, ERR.invalidRequest, "Les lots (batch) ne sont pas pris en charge");
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return fail(null, ERR.invalidRequest, "Requête JSON-RPC 2.0 invalide");

    const hasMethod = typeof msg.method === "string";
    const idOk = typeof msg.id === "string" || typeof msg.id === "number";

    // Réponse du client à l'une de NOS requêtes.
    if (!hasMethod && idOk && ("result" in msg || "error" in msg)) {
      const p = pending.get(msg.id as Id);
      if (!p) return;
      pending.delete(msg.id as Id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "Erreur du client"));
      else p.resolve(msg.result);
      return;
    }
    if (!hasMethod) return fail(null, ERR.invalidRequest, "Requête JSON-RPC 2.0 invalide");
    const method = msg.method as string;

    if (msg.id === undefined) {
      if (!opts.onNotification) return;
      track(
        (async () => {
          try {
            await opts.onNotification!(method, msg.params);
          } catch (e) {
            log(`[jsonrpc] notification ${method} : ${(e as Error).message}`);
          }
        })(),
      );
      return;
    }
    if (!idOk) return fail(null, ERR.invalidRequest, "Identifiant de requête invalide");
    const id = msg.id as Id;
    track(
      (async () => {
        try {
          write({ jsonrpc: "2.0", id, result: (await opts.onRequest(method, msg.params)) ?? null });
        } catch (e) {
          if (e instanceof RpcError) fail(id, e.code, e.message, e.data);
          else {
            // Le message interne reste sur stderr (expurgé) : le client ne reçoit jamais un chemin ou un détail de la machine.
            log(`[jsonrpc] erreur interne dans ${method} : ${(e as Error).message}`);
            fail(id, ERR.internal, "Erreur interne");
          }
        }
      })(),
    );
  };

  let buf = "";
  let discarding = false;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (discarding) {
        discarding = false; // la fin de la ligne démesurée est atteinte
        continue;
      }
      if (line.length > max) {
        fail(null, ERR.invalidRequest, "Ligne trop longue");
        continue;
      }
      if (line.trim()) handle(line);
    }
    if (!discarding && buf.length > max) {
      fail(null, ERR.invalidRequest, "Ligne trop longue");
      buf = "";
      discarding = true;
    } else if (discarding) buf = "";
  });

  const closed = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (ended) return;
      ended = true;
      for (const [, p] of pending) p.reject(new Error("Transport fermé"));
      pending.clear();
      void (async () => {
        while (inflight.size) await Promise.allSettled([...inflight]);
        resolve();
      })();
    };
    input.on("end", finish);
    input.on("close", finish);
    input.on("error", finish);
  });

  return {
    closed,
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    request: (method, params) => {
      if (ended) return Promise.reject(new Error("Transport fermé"));
      const id = nextOut++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    },
  };
}
