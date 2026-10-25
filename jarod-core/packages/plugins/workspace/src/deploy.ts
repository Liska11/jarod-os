/**
 * Déploiements (repris de PandaCode) : une commande fixe par fournisseur, lancée dans un dossier de projet. Aucun
 * argument ne vient de l'utilisateur, sauf le booléen « production ». L'outil est `dangerous` : l'utilisateur approuve
 * le déploiement, et l'approbation nomme le fournisseur, le dossier et le mode.
 */
import { isAbsolute } from "node:path";
import { execArgs, type ExecResult } from "./exec.js";
import { WorkspaceError } from "./git.js";

export const DEPLOY_PROVIDERS = ["vercel", "cloudflare", "railway", "gcloud"] as const;
export type DeployProvider = (typeof DEPLOY_PROVIDERS)[number];

export interface DeployCommand {
  command: string;
  args: string[];
}

/**
 * Commande de déploiement. `production: false` produit un aperçu quand le fournisseur sait le faire :
 * Vercel (URL de prévisualisation) et gcloud (version non promue). Cloudflare Workers et Railway n'ont pas d'aperçu :
 * leur déploiement touche toujours l'environnement lié.
 */
export function deployCommand(provider: string, production: boolean): DeployCommand {
  switch (provider) {
    case "vercel":
      return { command: "vercel", args: ["deploy", "--yes", ...(production ? ["--prod"] : [])] };
    case "cloudflare":
      return { command: "wrangler", args: ["deploy"] };
    case "railway":
      return { command: "railway", args: ["up", "--ci"] };
    case "gcloud":
      return { command: "gcloud", args: ["app", "deploy", "--quiet", ...(production ? [] : ["--no-promote"])] };
    default:
      throw new WorkspaceError(`fournisseur inconnu : « ${provider} » (connus : ${DEPLOY_PROVIDERS.join(", ")})`);
  }
}

export interface DeployOptions {
  provider: string;
  cwd: string;
  production: boolean;
}

export type Exec = (command: string, args: string[], options: { cwd: string; shell: boolean; timeoutMs: number }) => Promise<ExecResult>;

/** Lance le déploiement dans `cwd`. `exec` est injectable pour les tests. */
export async function runDeploy(options: DeployOptions, exec: Exec = (c, a, o) => execArgs(c, a, o)): Promise<ExecResult> {
  if (!isAbsolute(options.cwd)) throw new WorkspaceError("le dossier du projet doit être absolu");
  const { command, args } = deployCommand(options.provider, options.production);
  return exec(command, args, {
    cwd: options.cwd,
    // Les CLI de ces fournisseurs sont des `.cmd` sous Windows : le shell est nécessaire. Les arguments sont fixes.
    shell: process.platform === "win32",
    timeoutMs: 15 * 60_000,
  });
}

/** Libellé lisible de ce qui va être déployé, pour la demande d'approbation. */
export function deployDescription(options: DeployOptions): string {
  const mode = options.production ? "en PRODUCTION" : "en aperçu";
  return `Déployer ${options.provider} ${mode} depuis ${options.cwd}`;
}
