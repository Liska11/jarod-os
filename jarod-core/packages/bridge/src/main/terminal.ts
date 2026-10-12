/**
 * Terminal intégré (SPECS-P5-UI-PARITE.md §5) : un pseudo-terminal (ConPTY sous Windows, pty ailleurs, par `node-pty`) par onglet,
 * piloté par le renderer (xterm.js). Ce module ne connaît ni Electron ni le kernel : le pty est INJECTÉ (`spawn`), donc testé avec un faux
 * pty ET avec le vrai.
 *
 * Garde-fous (le terminal est un shell : tout ce que l'utilisateur tape s'exécute avec ses droits, comme dans VS Code) :
 * - le programme lancé n'est JAMAIS un chemin libre du renderer : il vient de `detectShells()` (liste fermée, chemins vérifiés) ;
 * - le dossier de départ n'est pas non plus libre : le dossier de travail par défaut, sinon le dossier personnel ;
 * - l'environnement transmis est celui du processus, SANS les variables propres à l'application (`ELECTRON_*`, `NODE_OPTIONS`, `JAROD_*`) ;
 * - au plus `MAX_TERMINALS` terminaux, écriture bornée, taille bornée, sortie groupée (pas une inondation d'événements) ;
 * - tout est tué à la fermeture de l'application (`closeAll`).
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

export const MAX_TERMINALS = 4;
export const MAX_WRITE = 64 * 1024;
/** Sortie gardée par terminal pour qu'un écran qui se rattache retrouve ce qui s'est affiché. */
export const REPLAY_BYTES = 256 * 1024;
const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;

export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface ShellInfo {
  /** Chemin absolu de l'exécutable : c'est la valeur du réglage `terminalShell`. */
  path: string;
  /** Nom affiché. */
  name: string;
}

export interface TerminalInfo {
  id: string;
  shell: string;
  name: string;
  cwd: string;
  cols: number;
  rows: number;
}

/** Les shells que cette machine a, dans l'ordre de préférence. Liste FERMÉE : rien d'autre ne se lance. */
export function detectShells(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  env: NodeJS.ProcessEnv = process.env,
  readText: (p: string) => string = () => "",
): ShellInfo[] {
  const found: ShellInfo[] = [];
  const add = (path: string | undefined, name: string) => {
    if (path && exists(path) && !found.some((s) => s.path.toLowerCase() === path.toLowerCase())) found.push({ path, name });
  };
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) if (dir) add(join(dir, "pwsh.exe"), "PowerShell 7");
    add(join(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), "PowerShell 7");
    add(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "Windows PowerShell");
    add(join(root, "System32", "cmd.exe"), "Command Prompt");
    add(join(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "Git Bash");
  } else {
    const listed = readText("/etc/shells")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/"));
    add(env.SHELL, basename(env.SHELL ?? ""));
    for (const p of listed) add(p, basename(p));
  }
  return found;
}

/** Variables transmises au shell : celles du processus, sans ce qui n'appartient qu'à l'application. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(ELECTRON_|JAROD_)/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}

/** Arguments de lancement : PowerShell sans bannière ; les autres, tels quels. */
export function shellArgs(path: string): string[] {
  return /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(path) ? ["-NoLogo"] : [];
}

interface Live {
  info: TerminalInfo;
  pty: PtyLike;
  replay: string;
  queued: string;
  timer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
}

export class TerminalManager {
  private readonly live = new Map<string, Live>();
  private counter = 0;

  constructor(
    private readonly d: {
      spawn(shell: string, args: string[], o: SpawnOptions): PtyLike;
      send(channel: string, payload: unknown): void;
      /** Identifiant d'un nouvel onglet (injectable pour des tests déterministes). */
      newId?: () => string;
      env?: () => NodeJS.ProcessEnv;
    },
  ) {}

  open(shell: ShellInfo, cwd: string, cols: number, rows: number): TerminalInfo {
    if (this.live.size >= MAX_TERMINALS) throw new Error(`${MAX_TERMINALS} terminaux au plus : fermez-en un`);
    const id = this.d.newId?.() ?? `term-${++this.counter}`;
    const pty = this.d.spawn(shell.path, shellArgs(shell.path), { cols, rows, cwd, env: shellEnv(this.d.env?.()) });
    const info: TerminalInfo = { id, shell: shell.path, name: shell.name, cwd, cols, rows };
    const t: Live = { info, pty, replay: "", queued: "", timer: null, exited: false };
    this.live.set(id, t);
    pty.onData((data) => {
      t.replay = (t.replay + data).slice(-REPLAY_BYTES);
      t.queued += data;
      if (t.queued.length >= FLUSH_BYTES) this.flush(t);
      else t.timer ??= setTimeout(() => this.flush(t), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      t.exited = true;
      this.flush(t);
      this.live.delete(id);
      this.d.send("terminal-exit", { id, exitCode });
    });
    return { ...info };
  }

  private flush(t: Live): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (!t.queued) return;
    const data = t.queued;
    t.queued = "";
    this.d.send("terminal-data", { id: t.info.id, data });
  }

  /** Un terminal encore en vie, avec la sortie déjà affichée (un écran qui se rattache la rejoue). */
  attach(id: string): (TerminalInfo & { buffer: string }) | null {
    const t = this.live.get(id);
    if (!t) return null;
    // Ce qui attend d'être envoyé fait déjà partie du tampon : il ne doit pas être rejoué deux fois.
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.queued = "";
    return { ...t.info, buffer: t.replay };
  }

  write(id: string, data: string): boolean {
    const t = this.live.get(id);
    if (!t || t.exited) return false;
    t.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const t = this.live.get(id);
    if (!t || t.exited) return false;
    t.pty.resize(cols, rows);
    t.info.cols = cols;
    t.info.rows = rows;
    return true;
  }

  close(id: string): boolean {
    const t = this.live.get(id);
    if (!t) return false;
    this.live.delete(id);
    t.exited = true;
    if (t.timer) clearTimeout(t.timer);
    try {
      t.pty.kill();
    } catch {
      /* déjà mort */
    }
    return true;
  }

  list(): TerminalInfo[] {
    return [...this.live.values()].map((t) => ({ ...t.info }));
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.close(id);
  }
}

/** Le dossier de départ : le dossier de travail s'il existe, sinon le dossier personnel. */
export function startDir(workspace: string | null | undefined): string {
  if (workspace) {
    try {
      if (existsSync(workspace) && statSync(workspace).isDirectory()) return workspace;
    } catch {
      /* repli */
    }
  }
  return homedir();
}
