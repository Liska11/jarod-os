/**
 * Lance un agent de code déjà installé (Claude Code, Codex CLI) en mode non interactif, dans un dossier, et rend son
 * résultat. Le prompt passe par l'entrée standard, jamais par la ligne de commande : rien de l'utilisateur n'est
 * interprété par un shell. Les seuls arguments variables (le modèle) sont validés avant.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { WorkspaceError } from "./git.js";

export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface CliAgentOptions {
  harness: Harness;
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CliAgentResult {
  ok: boolean;
  /** Réponse finale de l'agent, ou à défaut le texte qu'il a produit. */
  text: string;
  costUsd?: number;
  exitCode: number | null;
  /** Dernières lignes d'erreur de l'agent, pour diagnostiquer un échec. */
  stderr: string;
  error?: string;
}

/** Commande et arguments d'un agent. Surchargeable pour les tests et les installations non standard. */
export interface Launch {
  command: string;
  args: string[];
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const STDERR_MAX = 4_000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** Binaire de chaque agent : `JAROD_CLAUDE_BIN` / `JAROD_CODEX_BIN` le remplacent (chemin complet, par exemple). */
export function launchFor(harness: Harness, model: string | undefined, env: NodeJS.ProcessEnv = process.env): Launch {
  if (model !== undefined && !MODEL_RE.test(model)) throw new WorkspaceError(`nom de modèle refusé : « ${model} »`);
  const modelArgs = model ? ["--model", model] : [];
  if (harness === "claude") {
    // acceptEdits : l'agent écrit dans le worktree sans demander à chaque fichier ; l'appel lui-même a déjà été approuvé.
    return {
      command: env.JAROD_CLAUDE_BIN || "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", ...modelArgs],
    };
  }
  return {
    command: env.JAROD_CODEX_BIN || "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", ...modelArgs, "-"],
  };
}

/** Un événement lu dans le flux JSON de l'agent : seul le texte utile et le coût nous intéressent. */
interface Reading {
  texts: string[];
  finalText?: string;
  costUsd?: number;
  failed?: string;
}

/** Lit une ligne du flux `claude -p --output-format stream-json`. */
function readClaudeLine(event: Record<string, unknown>, into: Reading): void {
  if (event.type === "assistant") {
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as { type?: string; text?: string }[]) {
        if (block.type === "text" && block.text) into.texts.push(block.text);
      }
    }
  } else if (event.type === "result") {
    if (typeof event.result === "string") into.finalText = event.result;
    if (typeof event.total_cost_usd === "number") into.costUsd = event.total_cost_usd;
    if (event.is_error === true) into.failed = String(event.result ?? event.subtype ?? "échec de l'agent");
  }
}

/** Lit une ligne du flux `codex exec --json` (événements `item.completed`, `turn.completed`, `turn.failed`, `error`). */
function readCodexLine(event: Record<string, unknown>, into: Reading): void {
  if (event.type === "item.completed") {
    const item = event.item as { type?: string; text?: string } | undefined;
    if (item?.type === "agent_message" && item.text) {
      into.texts.push(item.text);
      into.finalText = item.text;
    }
  } else if (event.type === "turn.failed" || event.type === "error") {
    const err = event.error as { message?: string } | undefined;
    into.failed = err?.message ?? String(event.message ?? "échec de l'agent");
  }
}

export function readAgentLine(harness: Harness, line: string, into: Reading): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return; // une ligne qui n'est pas du JSON est du bruit de l'agent : ignorée
  }
  if (!event || typeof event !== "object") return;
  if (harness === "claude") readClaudeLine(event as Record<string, unknown>, into);
  else readCodexLine(event as Record<string, unknown>, into);
}

/** Lance l'agent dans `cwd`, lui donne le prompt, et attend sa fin (ou le délai, ou l'annulation). */
export async function runCliAgent(options: CliAgentOptions, launch: Launch = launchFor(options.harness, options.model)): Promise<CliAgentResult> {
  if (!isAbsolute(options.cwd)) throw new WorkspaceError("le dossier de travail doit être absolu");
  if (!options.prompt.trim()) throw new WorkspaceError("prompt vide");

  return new Promise((resolve) => {
    const reading: Reading = { texts: [] };
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      windowsHide: true,
      // Sous Windows, les CLI npm sont des `.cmd` : il faut le shell pour les trouver. Les arguments sont fixes ou validés,
      // et le prompt passe par l'entrée standard : rien d'utilisateur n'est interprété.
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Sous Windows le shell lance l'agent en enfant : il faut tuer tout l'arbre, sinon le flux ne se ferme jamais.
    const kill = () => {
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
      } else {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.signal?.addEventListener("abort", kill, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        readAgentLine(options.harness, buffer.slice(0, newline), reading);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_MAX);
    });

    let settled = false;
    const finish = (exitCode: number | null, spawnError?: Error) => {
      // 'error' puis 'close' peuvent arriver tous deux pour un lancement raté : une seule réponse.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readAgentLine(options.harness, buffer, reading);
      const text = reading.finalText ?? reading.texts.join("\n\n");
      const failure = spawnError?.message ?? (timedOut ? "délai dépassé" : reading.failed) ?? (exitCode === 0 ? undefined : `code de sortie ${exitCode}`);
      resolve({
        ok: failure === undefined,
        text,
        ...(reading.costUsd !== undefined ? { costUsd: reading.costUsd } : {}),
        exitCode,
        stderr: stderr.trim(),
        ...(failure !== undefined ? { error: failure } : {}),
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));

    child.stdin.on("error", () => undefined); // l'agent peut fermer son entrée avant nous : l'erreur de sortie suffit
    child.stdin.end(options.prompt);
  });
}
