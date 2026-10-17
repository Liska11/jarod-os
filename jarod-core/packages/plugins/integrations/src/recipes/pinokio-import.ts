/**
 * Importeur facultatif de scripts Pinokio JSON simples (phase 6B). Il ne lit que le sous-ensemble sûr et rapporte, étape
 * par étape, ce qu'il refuse et pourquoi. Aucune ligne du code de pinokiod n'est reprise : seul le comportement observé
 * est réécrit (le dépôt pinokiod n'a pas de fichier LICENSE, voir docs/PINOKIO-PORT-EVALUATION.md § 1).
 */
import { RecipeError } from "./recipe.js";

export interface ImportRefusal {
  index: number;
  method: string;
  /** `clé: explication` ; la clé nomme le motif (sudo, venv, expression, verbe…). */
  reason: string;
}

export interface ImportedRecipe {
  recipe: { schema: 1; id: string; name: string; version: string; vars: string[]; steps: { id: string; verb: string; params: Record<string, unknown> }[] };
  refused: ImportRefusal[];
}

const TOKEN = /\{\{([^{}]*)\}\}/g;
const ARG = /^\s*args\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;

class Refuse extends Error {}

/** `{{args.x}}` devient `{{x}}` ; toute autre expression est refusée. */
function convert(text: string, vars: Set<string>): string {
  if (/\{\{/.test(text.replace(TOKEN, ""))) throw new Refuse("expression: gabarit mal formé");
  return text.replace(TOKEN, (_a, inner: string) => {
    const m = ARG.exec(inner);
    if (!m) throw new Refuse(`expression: « {{${inner.trim().slice(0, 30)}}} » n'est pas une variable simple`);
    vars.add(m[1]!);
    return `{{${m[1]}}}`;
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function importPinokioScript(script: unknown, meta: { id: string; name: string; version?: string }): ImportedRecipe {
  if (!isObject(script) || !Array.isArray(script.run)) throw new RecipeError(["script Pinokio : un objet avec une liste `run` est attendu"]);
  const vars = new Set<string>();
  const steps: ImportedRecipe["recipe"]["steps"] = [];
  const refused: ImportRefusal[] = [];

  script.run.forEach((raw, index) => {
    const method = isObject(raw) && typeof raw.method === "string" ? raw.method : "?";
    try {
      if (!isObject(raw) || !isObject(raw.params ?? {})) throw new Refuse("forme: étape illisible");
      const params = (raw.params ?? {}) as Record<string, unknown>;
      for (const k of ["sudo", "venv", "venv_python", "env", "on", "persistent", "buffer"]) {
        if (params[k] !== undefined) throw new Refuse(`${k}: refusé (élévation, environnement ou écouteur : action humaine)`);
      }
      if (raw.when !== undefined || raw.next !== undefined || raw.id !== undefined || raw.run !== undefined) throw new Refuse("flux: when, next, id ne sont pas importés");
      const vSnapshot = new Set(vars);
      try {
        if (method === "shell.run") {
          const list = Array.isArray(params.message) ? params.message : [params.message];
          if (!list.length || list.some((m) => typeof m !== "string")) throw new Refuse("message: texte ou liste de textes attendu");
          let dir = "";
          if (params.path !== undefined) {
            if (typeof params.path !== "string" || !/^[A-Za-z0-9_.\-/]+$/.test(params.path) || params.path.split("/").includes("..")) throw new Refuse("path: chemin simple relatif attendu");
            dir = params.path;
          }
          const commands = (list as string[]).map((m) => (dir ? `cd ${dir} && ${convert(m, vars)}` : convert(m, vars)));
          steps.push({ id: `p${index}`, verb: "shell.run", params: { command: commands } });
        } else if (method === "fs.write") {
          if (typeof params.path !== "string" || typeof params.text !== "string") throw new Refuse("params: path et text attendus");
          steps.push({ id: `p${index}`, verb: "fs.write", params: { path: convert(params.path, vars), content: convert(params.text, vars) } });
        } else if (method === "fs.read") {
          if (typeof params.path !== "string") throw new Refuse("params: path attendu");
          steps.push({ id: `p${index}`, verb: "fs.read", params: { path: convert(params.path, vars) } });
        } else if (method === "notify" || method === "log") {
          steps.push({ id: `p${index}`, verb: "log", params: { message: convert(String(params.html ?? params.message ?? ""), vars) } });
        } else {
          throw new Refuse(`${method}: verbe non porté (liste blanche, voir recipe.ts)`);
        }
      } catch (e) {
        vars.clear();
        vSnapshot.forEach((v) => vars.add(v));
        throw e;
      }
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      refused.push({ index, method, reason: e.message });
    }
  });

  return { recipe: { schema: 1, id: meta.id, name: meta.name, version: meta.version ?? "0.0.0-import", vars: [...vars], steps }, refused };
}
