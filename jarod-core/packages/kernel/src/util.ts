import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

/**
 * Kills a process and everything it started. Killing a `shell: true` child only stops the
 * shell: on Windows the real command keeps running (and keeps its output pipes open).
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () =>
      child.kill(),
    );
    return;
  }
  try {
    // Children spawned with `detached: true` lead their own process group.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Aborts on the caller's signal or after `ms`, whichever comes first. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export const now = (): number => Date.now();

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [tronqué, ${text.length - max} caractères de plus]`;
}

type Listener<T> = (payload: T) => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const fn of this.listeners.get(event) ?? []) (fn as Listener<Events[K]>)(payload);
  }
}

/**
 * Incremental Server-Sent Events parser. Feed it raw text chunks; it calls back
 * once per complete event with the event name and the joined data lines.
 */
export class SseParser {
  private buffer = "";

  constructor(private readonly onEvent: (event: string, data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    for (;;) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.dispatch(block);
    }
  }

  flush(): void {
    if (this.buffer.trim()) this.dispatch(this.buffer);
    this.buffer = "";
  }

  private dispatch(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) this.onEvent(event, data.join("\n"));
  }
}

/** Tiny `{{var}}` template renderer used by workflows and prompts. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

/**
 * V-12 — où se connecter à la porte de contrôle du shell (`JAROD_OS_CONTROL_SOCKET`) : `tcp://hôte:port`, `pipe://<nom>` (tube nommé
 * Windows, que le shell annonce ainsi : on le joint en `\\.\pipe\<nom>`), sinon un chemin de socket Unix.
 */
export function controlConnectTarget(endpoint: string): { port: number; host: string } | { path: string } {
  const tcp = /^tcp:\/\/([^:]+):(\d+)$/.exec(endpoint);
  if (tcp) return { host: tcp[1]!, port: Number(tcp[2]) };
  const pipe = /^pipe:\/\/(.+)$/.exec(endpoint);
  if (pipe) return { path: `\\\\.\\pipe\\${pipe[1]}` };
  return { path: endpoint };
}
