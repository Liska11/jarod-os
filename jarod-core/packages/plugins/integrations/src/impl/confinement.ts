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
  node: { ext: "mjs", argv: (f) => `node "${f}"` },
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
