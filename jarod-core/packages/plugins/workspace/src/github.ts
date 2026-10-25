/**
 * Vue GitHub (repris de PandaCode) : pull requests et issues, via le CLI `gh` déjà authentifié sur la machine.
 * Les arguments sont validés puis passés tels quels : pas de shell, donc rien de l'utilisateur n'est interprété.
 */
import { WorkspaceError } from "./git.js";
import { execArgs } from "./exec.js";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATES = ["open", "closed", "merged", "all"] as const;
export type GithubState = (typeof STATES)[number];
const TITLE_MAX = 256;
const BODY_MAX = 65_536;

function repoArgs(repo: string | undefined): string[] {
  if (repo === undefined) return [];
  if (!REPO_RE.test(repo)) throw new WorkspaceError(`dépôt GitHub refusé : « ${repo} » (attendu : propriétaire/nom)`);
  return ["--repo", repo];
}

function stateOf(state: string | undefined): GithubState {
  const value = state ?? "open";
  if (!(STATES as readonly string[]).includes(value)) throw new WorkspaceError(`état refusé : « ${value} »`);
  return value as GithubState;
}

function limitOf(limit: number | undefined): number {
  const value = limit ?? 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new WorkspaceError("limite entre 1 et 100");
  return value;
}

function numberOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new WorkspaceError(`numéro refusé : ${value}`);
  return value;
}

async function gh(args: string[], cwd?: string): Promise<string> {
  const result = await execArgs("gh", args, { ...(cwd ? { cwd } : {}), timeoutMs: 60_000 });
  if (result.error || result.code !== 0) {
    throw new WorkspaceError(`gh ${args.slice(0, 2).join(" ")} : ${result.stderr || result.error || "échec"}`);
  }
  return result.stdout.toString("utf8");
}

export interface ListOptions {
  repo?: string;
  state?: string;
  limit?: number;
  cwd?: string;
}

export async function listPulls(options: ListOptions = {}): Promise<unknown[]> {
  const out = await gh(
    ["pr", "list", "--state", stateOf(options.state), "--limit", String(limitOf(options.limit)), "--json", "number,title,state,author,headRefName,url", ...repoArgs(options.repo)],
    options.cwd,
  );
  return JSON.parse(out) as unknown[];
}

export async function listIssues(options: ListOptions = {}): Promise<unknown[]> {
  const out = await gh(
    ["issue", "list", "--state", stateOf(options.state), "--limit", String(limitOf(options.limit)), "--json", "number,title,state,author,labels,url", ...repoArgs(options.repo)],
    options.cwd,
  );
  return JSON.parse(out) as unknown[];
}

export async function viewPull(number: number, options: { repo?: string; cwd?: string } = {}): Promise<unknown> {
  const out = await gh(
    ["pr", "view", String(numberOf(number)), "--json", "number,title,state,body,author,headRefName,baseRefName,url,reviewDecision,mergeable", ...repoArgs(options.repo)],
    options.cwd,
  );
  return JSON.parse(out) as unknown;
}

export interface CreatePullOptions {
  title: string;
  body: string;
  base?: string;
  head?: string;
  repo?: string;
  cwd?: string;
}

/** Ouvre une pull request depuis la branche courante (ou `head`) ; rend son URL. */
export async function createPull(options: CreatePullOptions): Promise<string> {
  if (!options.title.trim() || options.title.length > TITLE_MAX) throw new WorkspaceError(`titre vide ou plus de ${TITLE_MAX} caractères`);
  if (options.body.length > BODY_MAX) throw new WorkspaceError(`description trop longue (plus de ${BODY_MAX} caractères)`);
  for (const branch of [options.base, options.head]) {
    if (branch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch)) throw new WorkspaceError(`nom de branche refusé : « ${branch} »`);
  }
  const args = ["pr", "create", "--title", options.title, "--body", options.body, ...repoArgs(options.repo)];
  if (options.base) args.push("--base", options.base);
  if (options.head) args.push("--head", options.head);
  return (await gh(args, options.cwd)).trim();
}
