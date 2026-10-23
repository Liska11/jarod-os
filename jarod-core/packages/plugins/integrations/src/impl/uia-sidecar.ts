/**
 * Moteur UI Automation hors processus : un sidecar (pywinauto ou FlaUI) qui parle en lignes JSON. L'hôte fournit le
 * processus (`LineProcess`) ; ce module n'en lance aucun. Chaque requête a un délai ; une réponse mal formée, tardive ou
 * pour une autre requête est ignorée ; un sidecar mort fait échouer les requêtes en attente (jamais un succès supposé).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AdapterUnavailable } from "./common.js";
import type { ElementInfo, ElementQuery, UiaBackend, WindowRef } from "./uia.js";

export interface LineProcess {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SidecarUiaBackend implements UiaBackend {
  private proc: LineProcess | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** Appelé quand le moteur signale l'arrêt d'urgence (Ctrl+Alt+Fin). */
  onEmergency?: () => void;

  constructor(readonly engine: "flaui" | "pywinauto", private readonly spawn: () => LineProcess, private readonly timeoutMs = 15_000) {}

  private ensure(): LineProcess {
    if (this.proc) return this.proc;
    const p = this.spawn();
    p.onLine((line) => {
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      // Un événement spontané du moteur (l'arrêt d'urgence lu au clavier physique), sans requête correspondante.
      if (msg.event === "emergency_stop") {
        this.onEmergency?.();
        return;
      }
      const pend = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!pend || typeof msg.id !== "number") return;
      this.pending.delete(msg.id);
      clearTimeout(pend.timer);
      if (msg.ok) pend.resolve(msg.result);
      else pend.reject(new Error(String(msg.error ?? "erreur du sidecar").slice(0, 200)));
    });
    p.onExit(() => {
      this.proc = null;
      for (const [id, pend] of this.pending) {
        clearTimeout(pend.timer);
        pend.reject(new AdapterUnavailable("D1/D2", "sidecar arrêté"));
        this.pending.delete(id);
      }
    });
    this.proc = p;
    return p;
  }

  private call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const proc = this.ensure();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`délai dépassé pour ${op}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
  }

  /** Le moteur tourne (un processus est lancé). */
  get running(): boolean {
    return this.proc !== null;
  }

  listWindows = () => this.call<WindowRef[]>("list_windows");
  findElement = (q: ElementQuery) => this.call<ElementInfo[]>("find_element", { ...q });
  readText = (window: string, element: string) => this.call<string>("read_text", { window, element });
  click = (window: string, element: string) => this.call<void>("click", { window, element });
  typeText = (window: string, element: string, text: string) => this.call<void>("type_text", { window, element, text });
  focusWindow = (window: string) => this.call<void>("focus_window", { window });
  pressKey = (window: string, key: string) => this.call<void>("press_key", { window, key });
  pressKeys = (window: string, combo: string) => this.call<void>("press_keys", { window, combo });
  typeKeys = (window: string, text: string) => this.call<void>("type_keys", { window, text });
  mouseClick = (window: string, x: number, y: number, button: "left" | "right" | "double") => this.call<{ restored?: boolean }>("mouse_click", { window, x, y, button });
  mouseScroll = (window: string, x: number, y: number, amount: number) => this.call<{ restored?: boolean }>("mouse_scroll", { window, x, y, amount });
}

/** Un processus enfant en lignes de texte (sans shell : le programme et ses arguments sont séparés). */
export function childLineProcess(command: string, args: string[], env: NodeJS.ProcessEnv = {}): LineProcess {
  const child: ChildProcess = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, ...env } });
  return {
    write: (line) => void child.stdin?.write(line),
    onLine: (cb) => void createInterface({ input: child.stdout! }).on("line", cb),
    onExit: (cb) => void child.on("exit", cb).on("error", cb),
    kill: () => void child.kill(),
  };
}
