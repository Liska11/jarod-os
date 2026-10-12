// Portage de packages/core/src/tools/search.ts (rév. 2e180305).
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { truncate } from "@jarod/kernel/util";
import { resolveInWorkspace } from "./builtin.js";
import type { ToolDef } from "./registry.js";

/** Folders never worth searching (dependencies, build output, caches). */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "release",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
]);
const MAX_FILES = 50_000;
const MAX_SEARCH_BYTES = 2_000_000;

/**
 * Converts a glob to a regular expression over "/"-separated relative paths.
 * Supports `**`, `*`, `?`, `{a,b}` and `[...]`. A pattern without "/" matches at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += `[${g
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/** Files git would track (respects .gitignore), or null outside a git repository. */
function gitFiles(dir: string, signal?: AbortSignal): Promise<string[] | null> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15_000, ...(signal ? { signal } : {}) },
      (err, stdout) => done(err ? null : stdout.split("\0").filter(Boolean)),
    );
  });
}

async function walk(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES) {
    if (signal?.aborted) break;
    const rel = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** Relative ("/"-separated) paths of the files under `dir`, git-aware when possible. */
export async function listFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const files = (await gitFiles(dir, signal)) ?? (await walk(dir, signal));
  return files.filter((f) => !f.split("/").some((part) => SKIP_DIRS.has(part))).slice(0, MAX_FILES);
}

export function searchTools(): ToolDef[] {
  return [
    {
      name: "find_files",
      description:
        "Trouve des fichiers du dossier de travail par motif glob (ex. '**/*.ts', 'src/**/test_*.py', '*.{json,yml}'). Ignore .gitignore, node_modules, dist… Renvoie les chemins, les plus récents d'abord.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, max_results: { type: "integer" } },
        required: ["pattern"],
      },
      source: "builtin",
      async run(args, ctx) {
        const base = resolveInWorkspace(ctx, args.path);
        const re = globToRegExp(String(args.pattern));
        const max = Math.min(Number(args.max_results) || 200, 1000);
        const hits = (await listFiles(base, ctx.signal)).filter((f) => re.test(f));
        const withTime = await Promise.all(
          hits.slice(0, 5000).map(async (f) => ({ f, t: (await stat(join(base, f)).catch(() => null))?.mtimeMs ?? 0 })),
        );
        withTime.sort((a, b) => b.t - a.t);
        const prefix = relative(resolveInWorkspace(ctx, "."), base).replace(/\\/g, "/");
        const lines = withTime.slice(0, max).map(({ f }) => (prefix ? `${prefix}/${f}` : f));
        if (lines.length === 0) return `Aucun fichier ne correspond à ${String(args.pattern)}.`;
        return lines.join("\n") + (hits.length > max ? `\n… ${hits.length - max} autres (affine le motif)` : "");
      },
    },
    {
      name: "search_files",
      description:
        "Cherche une expression régulière (syntaxe JavaScript) dans le contenu des fichiers du dossier de travail et renvoie chemin:ligne: texte. Filtre optionnel par glob (ex. '*.ts'). Ignore .gitignore, node_modules, dist et les fichiers binaires.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          case_insensitive: { type: "boolean" },
          max_results: { type: "integer" },
        },
        required: ["pattern"],
      },
      source: "builtin",
      async run(args, ctx) {
        const base = resolveInWorkspace(ctx, args.path);
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern), args.case_insensitive ? "i" : "");
        } catch (e) {
          throw new Error(`Expression régulière invalide : ${(e as Error).message}`);
        }
        const only = args.glob ? globToRegExp(String(args.glob)) : null;
        const max = Math.min(Number(args.max_results) || 100, 500);
        const prefix = relative(resolveInWorkspace(ctx, "."), base).replace(/\\/g, "/");
        const out: string[] = [];
        let total = 0;
        let files = 0;
        for (const f of await listFiles(base, ctx.signal)) {
          if (ctx.signal?.aborted) break;
          if (only && !only.test(f)) continue;
          const full = join(base, f);
          const info = await stat(full).catch(() => null);
          if (!info || info.size > MAX_SEARCH_BYTES) continue;
          const buf = await readFile(full).catch(() => null);
          if (!buf || buf.subarray(0, 8000).includes(0)) continue;
          const lines = buf.toString("utf8").split("\n");
          let matched = false;
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i]!)) continue;
            matched = true;
            total++;
            if (out.length < max)
              out.push(`${prefix ? `${prefix}/` : ""}${f}:${i + 1}: ${truncate(lines[i]!.trim(), 300)}`);
          }
          if (matched) files++;
        }
        if (total === 0) return `Aucune correspondance pour /${String(args.pattern)}/.`;
        const more = total > max ? `\n… ${total - max} autres correspondances (affine la recherche)` : "";
        return `${total} correspondance(s) dans ${files} fichier(s)\n${out.join("\n")}${more}`;
      },
    },
  ];
}
