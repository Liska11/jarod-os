/**
 * Lancement d'une commande externe avec des arguments tels quels (pas de shell, sauf demande explicite : sous Windows,
 * les CLI installées par npm sont des `.cmd`). Délai, sortie bornée, et arrêt de tout l'arbre de processus.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { childEnv } from "@jarod/kernel/child-env";

const MAX_STDOUT = 8 * 1024 * 1024;
const STDERR_MAX = 4_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Tue le processus et ses enfants. Sous Windows, un shell lance la commande en enfant : `kill()` seul laisserait le flux ouvert. */
export function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  } else {
    child.kill();
  }
}

/**
 * La commande telle que le shell doit la lire. Sans shell, rien à faire. Avec le shell (les `.cmd` de Windows), Node concatène la commande et les
 * arguments sans guillemets : un chemin avec une espace (`C:\Program Files\…`) serait coupé. Une commande qui porte déjà un guillemet est refusée
 * plutôt que citée de travers.
 */
export function shellCommand(command: string, shell: boolean): string {
  if (!shell || !/\s/.test(command)) return command;
  if (command.includes('"')) throw new Error(`commande refusée (guillemet dans le chemin) : ${command}`);
  return `"${command}"`;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Passer par le shell : seulement pour des arguments fixes ou validés (le cas Windows des `.cmd`). */
  shell?: boolean;
  input?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** Présent si la commande n'a pas pu se lancer, a dépassé son délai, ou a échoué. */
  error?: string;
}

export function execArgs(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(shellCommand(command, options.shell === true), args, {
      cwd: options.cwd,
      // Un moteur lancé par Jarod : l'environnement de l'utilisateur, sans jeton de contrôle interne ni clé de fournisseur de Jarod ;
      // Internet coupé pour Jarod, l'enfant reçoit un proxy mort.
      env: childEnv("engine"),
      windowsHide: true,
      shell: options.shell === true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const done = (code: number | null, error?: string) => {
      // 'error' puis 'close' peuvent arriver tous deux pour un lancement raté : une seule réponse.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const failure = error ?? (timedOut ? "délai dépassé" : code === 0 ? undefined : `code de sortie ${code}`);
      resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim(), ...(failure !== undefined ? { error: failure } : {}) });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (size >= MAX_STDOUT) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_MAX);
    });
    child.on("error", (error) => done(null, error.message));
    child.on("close", (code) => done(code));
    child.stdin.on("error", () => undefined); // la commande peut fermer son entrée avant nous : sa sortie dira le reste
    child.stdin.end(options.input ?? "");
  });
}
