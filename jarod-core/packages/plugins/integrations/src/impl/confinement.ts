/**
 * A1 (microsoft/mxc) — confinement des scripts GÉNÉRÉS et des outils MCP non approuvés.
 *
 * Le moteur mxc n'est pas embarqué (exigence de version de Node à vérifier, installation réservée à l'humain). Ce qui est
 * écrit ici est la politique, tenue par la sandbox existante (3.1/3.2) : un script généré n'est jamais passé en ligne de
 * commande (`-c`, `-e`, `-Command`), il est écrit dans la zone sous son empreinte, puis lancé par `run_shell` avec
 * l'isolation « workspace » imposée. Un outil MCP dont l'empreinte n'est pas approuvée n'est pas offert.
 */
import { AdapterRefused, type GuardedCall, sha256 } from "./common.js";

export type ScriptLanguage = "python" | "node" | "powershell";

const RUNNERS: Record<ScriptLanguage, { ext: string; argv: (file: string) => string }> = {
  python: { ext: "py", argv: (f) => `python "${f}"` },
  node: { ext: "mjs", argv: (f) => `node --preserve-symlinks --preserve-symlinks-main "${f}"` },
  powershell: { ext: "ps1", argv: (f) => `powershell -NoProfile -ExecutionPolicy Restrict -File "${f}"` },
};

export const GENERATED_DIR = ".jarod-generated";
const MAX_SCRIPT = 200_000;

export interface ConfinedScript {
  file: string;
  digest: string;
  calls: [GuardedCall, GuardedCall];
}

/** Traduit un script généré en deux appels de la porte unique : écrire la source, puis l'exécuter confiné. */
export function confineGeneratedScript(language: string, source: string, opts: { timeoutSeconds?: number } = {}): ConfinedScript {
  const runner = Object.hasOwn(RUNNERS, language) ? RUNNERS[language as ScriptLanguage] : undefined;
  if (!runner) throw new AdapterRefused("A1", `langage « ${language} » non permis (python, node, powershell)`);
  if (!source.trim()) throw new AdapterRefused("A1", "script vide");
  if (source.length > MAX_SCRIPT) throw new AdapterRefused("A1", "script trop long");
  if (source.includes("\0")) throw new AdapterRefused("A1", "caractère nul dans le script");
  const digest = sha256(source);
  const file = `${GENERATED_DIR}/${digest.slice(0, 16)}.${runner.ext}`;
  const timeout = Math.max(1, Math.min(600, Math.floor(opts.timeoutSeconds ?? 60)));
  return {
    file,
    digest,
    calls: [
      { name: "write_file", args: { path: file, content: source } },
      { name: "run_shell", args: { command: runner.argv(file), isolation: "workspace", timeout_seconds: timeout } },
    ],
  };
}

export type McpExposure = "offer" | "hold" | "block";

/**
 * Faut-il offrir un outil MCP au modèle ? `approved` : son empreinte correspond à l'épingle acceptée (voir
 * `fingerprintTool`). Un serveur désactivé ou en erreur ne montre rien.
 */
export function mcpExposure(tool: { serverEnabled: boolean; serverHealthy: boolean; pinState: "approved" | "changed" | "new" | "unknown" }): McpExposure {
  if (!tool.serverEnabled || !tool.serverHealthy) return "block";
  return tool.pinState === "approved" ? "offer" : "hold";
}

// ---------------------------------------------------------------- moteur mxc

/** Requête de conteneur MXC (sous-ensemble du contrat v1 que nous utilisons). */
export interface MxcRequest {
  command: string;
  filesystem: { readwritePaths: string[]; readonlyPaths: string[]; deniedPaths: string[] };
  network: { egress: { default: "deny" } };
  ui: { disable: false; clipboard: "none"; allowInputInjection: false };
  timeoutMs: number;
  workingDirectory: string;
}

export interface MxcPolicy {
  /** Dossier de travail ABSOLU : le seul chemin où le contenu peut écrire. */
  workspace: string;
  /** Dossiers lisibles (interpréteurs, bibliothèques). */
  readonlyPaths?: string[];
  /** Dossiers interdits en plus (dossier personnel sensible, profils de navigateur…). */
  deniedPaths?: string[];
}

const ABS = /^(?:[A-Za-z]:[\\/]|\/)/;
const SEP = /[\\/]/;
const TRAILING_SEP = /[\\/]+$/;

/**
 * Traduit une commande déjà validée en requête MXC : écriture dans la zone seulement, réseau refusé (pas d'option pour
 * l'ouvrir), interface refusée, délai borné. Les chemins relatifs ou contenant `..` sont refusés.
 */
export function toMxcRequest(command: string, policy: MxcPolicy, timeoutSeconds = 60): MxcRequest {
  if (!command.trim() || command.includes("\0")) throw new AdapterRefused("A1", "commande vide ou invalide");
  const all = [policy.workspace, ...(policy.readonlyPaths ?? []), ...(policy.deniedPaths ?? [])];
  for (const p of all) if (!ABS.test(p) || p.split(SEP).includes("..")) throw new AdapterRefused("A1", `chemin de politique non absolu ou contenant « .. » : ${p}`);
  const ws = policy.workspace.replace(TRAILING_SEP, "");
  if ((policy.readonlyPaths ?? []).concat(policy.deniedPaths ?? []).some((p) => p.replace(TRAILING_SEP, "").toLowerCase() === ws.toLowerCase())) throw new AdapterRefused("A1", "la zone de travail ne peut pas être aussi en lecture seule ou interdite");
  return {
    command,
    filesystem: { readwritePaths: [policy.workspace], readonlyPaths: policy.readonlyPaths ?? [], deniedPaths: policy.deniedPaths ?? [] },
    network: { egress: { default: "deny" } },
    // MESURÉ : `ui.disable: true` empêche tout programme Win32 qui charge user32 de démarrer (node, PowerShell : 0xC0000142). Les
    // processus ont donc une pile UI, sans presse-papiers ni injection d'entrée.
    ui: { disable: false, clipboard: "none", allowInputInjection: false },
    timeoutMs: Math.max(1, Math.min(600, Math.floor(timeoutSeconds))) * 1000,
    workingDirectory: policy.workspace,
  };
}
