/**
 * Recettes déclaratives (phase 6B) : un script n'est JAMAIS exécuté, il est traduit en plan. Le plan est connu, validé
 * et empreinté avant la première étape ; chaque étape devient un appel d'outil de la porte unique (`executeGuardedTool`,
 * injectée par l'appelant : ce module n'ouvre aucun canal d'exécution).
 *
 * Liste blanche de verbes. Refusés par défaut, nommément : net, web, local, gradio, hf, cloudflare, exec, proc, script,
 * fs.download (le téléchargement passe par la quarantaine), et `sudo`, `env`, `venv`, `daemon`, `next` partout.
 */
import { createHash } from "node:crypto";
import { referencedVars, TemplateError } from "./template.js";

export class RecipeError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" ; "));
  }
}

export type Condition = { var: string } & ({ equals: string } | { notEquals: string } | { exists: boolean });

export interface PlanStep {
  id: string;
  verb: string;
  /** Outil de la porte unique, ou `null` pour une étape pure (aucune E/S). */
  tool: string | null;
  args: Record<string, unknown>;
  when?: Condition;
  save?: string;
}

export interface Plan {
  id: string;
  name: string;
  version: string;
  steps: PlanStep[];
  rollback: PlanStep[];
  /** SHA-256 du plan canonique : à signer et à comparer (plateforme de plugins, phase 4). */
  digest: string;
}

export const MAX_STEPS = 200;
export const MAX_TEXT = 100_000;

const REFUSED_NAMESPACES = ["net", "web", "local", "gradio", "hf", "cloudflare", "exec", "proc", "script", "app", "kernel", "sudo"];
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ParamSpec = { allowed: string[]; required: string[] };

interface VerbSpec extends ParamSpec {
  tool: string | null;
}

const VERBS: Record<string, VerbSpec> = {
  "shell.run": { tool: "run_shell", allowed: ["command", "timeout_seconds", "secrets"], required: ["command"] },
  "fs.read": { tool: "read_file", allowed: ["path"], required: ["path"] },
  "fs.write": { tool: "write_file", allowed: ["path", "content"], required: ["path", "content"] },
  "fs.list": { tool: "list_dir", allowed: ["path"], required: [] },
  "http.get": { tool: "http_request", allowed: ["url"], required: ["url"] },
  log: { tool: null, allowed: ["message"], required: ["message"] },
  set: { tool: null, allowed: ["value"], required: ["value"] },
  "json.get": { tool: null, allowed: ["from", "key"], required: ["from", "key"] },
};

const TOP_KEYS = ["schema", "id", "name", "version", "vars", "steps", "rollback"];
const STEP_KEYS = ["id", "verb", "params", "when", "save"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Un chemin de recette est relatif à la zone de la recette : ni absolu, ni lecteur, ni UNC, ni `..`, ni `~`. */
export function pathProblem(path: string): string | null {
  if (!path.trim()) return "chemin vide";
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path) || path.startsWith("~")) return "chemin absolu ou hors de la zone";
  if (path.split(/[\\/]/).includes("..")) return "chemin qui remonte hors de la zone";
  if (path.includes("\0")) return "caractère nul dans le chemin";
  return null;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function refsOf(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    for (const n of referencedVars(value)) into.push(n);
  } else if (Array.isArray(value)) value.forEach((v) => { refsOf(v, into); });
  else if (isObject(value)) Object.values(value).forEach((v) => { refsOf(v, into); });
}

function compileSteps(list: unknown, scope: string, declared: Set<string>, problems: string[], ids: Set<string>): PlanStep[] {
  const out: PlanStep[] = [];
  if (!Array.isArray(list)) {
    problems.push(`${scope} : liste d'étapes attendue`);
    return out;
  }
  list.forEach((raw, index) => {
    const where = `${scope}[${index}]`;
    if (!isObject(raw)) return void problems.push(`${where} : objet attendu`);
    for (const k of Object.keys(raw)) if (!STEP_KEYS.includes(k)) problems.push(`${where} : clé refusée « ${k} »`);
    const verb = raw.verb;
    if (typeof verb !== "string") return void problems.push(`${where} : verbe manquant`);
    const ns = verb.split(".")[0] ?? "";
    const spec = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
    if (!spec) return void problems.push(REFUSED_NAMESPACES.includes(ns) || verb === "fs.download" ? `${where} : verbe refusé « ${verb} »` : `${where} : verbe inconnu « ${verb} »`);
    const stepId = raw.id === undefined ? `${scope === "steps" ? "" : "rb"}${index}` : String(raw.id);
    if (!STEP_ID.test(stepId)) problems.push(`${where} : identifiant d'étape invalide`);
    if (ids.has(stepId)) problems.push(`${where} : identifiant en doublon « ${stepId} »`);
    ids.add(stepId);

    const params = raw.params === undefined ? {} : raw.params;
    if (!isObject(params)) return void problems.push(`${where} : params doit être un objet`);
    for (const k of Object.keys(params)) if (!spec.allowed.includes(k)) problems.push(`${where} : paramètre refusé « ${k} » pour ${verb}`);
    for (const k of spec.required) if (params[k] === undefined) problems.push(`${where} : paramètre manquant « ${k} »`);

    // Gabarits : seules les variables nommées, et déclarées avant l'étape.
    try {
      const refs: string[] = [];
      refsOf(params, refs);
      for (const r of refs) if (!declared.has(r)) problems.push(`${where} : variable non déclarée « ${r} »`);
    } catch (e) {
      problems.push(`${where} : ${(e as TemplateError).message}`);
    }
    const json = JSON.stringify(params);
    if (json.length > MAX_TEXT) problems.push(`${where} : paramètres trop longs`);

    let when: Condition | undefined;
    if (raw.when !== undefined) {
      const w = raw.when;
      const ops = isObject(w) ? ["equals", "notEquals", "exists"].filter((k) => w[k] !== undefined) : [];
      if (!isObject(w) || typeof w.var !== "string" || ops.length !== 1 || Object.keys(w).length !== 2) problems.push(`${where} : when = { var, equals | notEquals | exists }`);
      else if (!declared.has(w.var)) problems.push(`${where} : variable non déclarée « ${w.var} »`);
      else when = w as unknown as Condition;
    }
    if (raw.save !== undefined && (typeof raw.save !== "string" || !VAR.test(raw.save))) problems.push(`${where} : nom de sauvegarde invalide`);
    const save = typeof raw.save === "string" ? raw.save : undefined;

    // Chemins : contrôle statique (les valeurs substituées sont recontrôlées à l'exécution).
    if (verb.startsWith("fs.") && typeof params.path === "string") {
      const p = pathProblem(params.path.replace(/\{\{[^{}]*\}\}/g, "x"));
      if (p) problems.push(`${where} : chemin refusé (${p})`);
    }

    if (verb === "shell.run") {
      const commands = Array.isArray(params.command) ? params.command : [params.command];
      if (!commands.length || commands.some((c) => typeof c !== "string" || !c.trim())) problems.push(`${where} : command = texte ou liste de textes non vides`);
      commands.forEach((c, i) => {
        if (typeof c !== "string") return;
        const { command: _c, ...rest } = params;
        out.push({
          id: `${stepId}.${i}`,
          verb,
          tool: "run_shell",
          // Le confinement est imposé, jamais laissé à la recette (échec fermé si la plateforme ne peut pas le tenir).
          args: { command: c, ...rest, isolation: "workspace" },
          ...(when ? { when } : {}),
          ...(i === commands.length - 1 && save ? { save } : {}),
        });
      });
    } else if (verb === "http.get") {
      out.push({ id: stepId, verb, tool: "http_request", args: { method: "GET", url: params.url }, ...(when ? { when } : {}), ...(save ? { save } : {}) });
    } else {
      out.push({ id: stepId, verb, tool: spec.tool, args: { ...params }, ...(when ? { when } : {}), ...(save ? { save } : {}) });
    }
    if (save) declared.add(save);
  });
  return out;
}

/** Valide la recette et la traduit en plan. Lève `RecipeError` avec TOUS les problèmes trouvés. */
export function compileRecipe(input: unknown): Plan {
  const problems: string[] = [];
  if (!isObject(input)) throw new RecipeError(["recette : objet attendu"]);
  for (const k of Object.keys(input)) if (!TOP_KEYS.includes(k)) problems.push(`recette : clé refusée « ${k} »`);
  if (input.schema !== 1) problems.push("recette : schema doit valoir 1");
  if (typeof input.id !== "string" || !ID.test(input.id)) problems.push("recette : id invalide");
  if (typeof input.name !== "string" || !input.name.trim()) problems.push("recette : nom manquant");
  if (typeof input.version !== "string" || !input.version.trim()) problems.push("recette : version manquante");

  const declared = new Set<string>();
  if (input.vars !== undefined) {
    if (!Array.isArray(input.vars) || input.vars.some((v) => typeof v !== "string" || !VAR.test(v))) problems.push("recette : vars = liste de noms");
    else for (const v of input.vars as string[]) declared.add(v);
  }
  if (Array.isArray(input.steps) && input.steps.length > MAX_STEPS) problems.push(`recette : trop d'étapes (${input.steps.length} > ${MAX_STEPS})`);
  if (Array.isArray(input.steps) && input.steps.length === 0) problems.push("recette : aucune étape");

  const ids = new Set<string>();
  const steps = Array.isArray(input.steps) && input.steps.length > MAX_STEPS ? [] : compileSteps(input.steps, "steps", declared, problems, ids);
  const rollback = input.rollback === undefined ? [] : compileSteps(input.rollback, "rollback", new Set(declared), problems, ids);
  if (problems.length) throw new RecipeError(problems);

  const body = { schema: 1, id: input.id as string, name: input.name as string, version: input.version as string, steps, rollback };
  return { ...body, digest: digestOf(body) };
}
