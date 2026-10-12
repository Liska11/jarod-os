// Portage de packages/core/src/services/references.ts (rév. 2e180305).
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Attachment } from "@jarod/contracts";

/**
 * `@` references in a message: `@src/app.ts` joins the file, `@docs/` the folder's tree, `@diff`
 * the uncommitted changes, `@"a path/with spaces.md"` a quoted path. Only what exists inside the
 * workspace is joined (real paths: a link leading outside is ignored), so an e-mail address or a
 * nickname (`@jean`) is left alone. The message keeps its text; the references travel as
 * attachments, like a file dropped on the composer.
 */

export const MAX_REFERENCES = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LISTING = 400;
/** Folders nobody wants to walk or read: dependencies, build output, version control. */
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
]);
const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** The `@` references of a message, in order, without duplicates (`@@`, e-mails excluded). */
export function findReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[\s(])@(?:"([^"]+)"|([^\s"'`()@]+))/g)) {
    const raw = (m[2] ?? m[3] ?? "").replace(/[.,;:!?]+$/, "");
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out.slice(0, MAX_REFERENCES);
}

const realOf = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/** The real path of `ref` inside the workspace, or null (missing, or outside once links are followed). */
export function resolveReference(workspace: string, ref: string): string | null {
  const root = realOf(resolve(workspace));
  if (!root) return null;
  const target = realOf(resolve(root, ref.replace(/[\\/]+$/, "") || "."));
  if (!target) return null;
  const rel = relative(root, target);
  return rel.startsWith("..") || isAbsolute(rel) ? null : target;
}

/** A folder's tree, two levels deep, heavy folders skipped. */
export function listing(root: string, dir: string): string {
  const lines: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (lines.length >= MAX_LISTING) return;
      const p = join(d, e);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      lines.push(`${"  ".repeat(depth)}${e}${isDir ? "/" : ""}`);
      if (isDir && depth < 1 && !SKIP.has(e)) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  const rel = relative(root, dir).split(sep).join("/") || ".";
  return `Contenu de ${rel}/ :\n${lines.join("\n")}${lines.length >= MAX_LISTING ? "\n… (liste tronquée)" : ""}`;
}

const looksBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

/** `git diff HEAD` of the workspace (staged and unstaged changes), or null outside a repository. */
export function gitDiff(workspace: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      ["diff", "HEAD", "--no-color"],
      { cwd: workspace, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => done(err ? null : String(stdout)),
    );
  });
}

export interface ExpandedReferences {
  attachments: Attachment[];
  /** What could not be joined, said to the model. */
  notes: string[];
}

export async function expandReferences(
  text: string,
  workspace: string | null,
  save: (name: string, mime: string, data: Buffer) => Attachment,
  diff: (workspace: string) => Promise<string | null> = gitDiff,
): Promise<ExpandedReferences> {
  const out: ExpandedReferences = { attachments: [], notes: [] };
  if (!workspace || !text.includes("@")) return out;
  const root = realOf(resolve(workspace));
  if (!root) return out;
  for (const ref of findReferences(text)) {
    if (ref === "diff") {
      const d = await diff(root);
      if (d === null) out.notes.push("[@diff : le dossier de travail n'est pas un dépôt git]");
      else if (!d.trim()) out.notes.push("[@diff : aucune modification non commitée]");
      else out.attachments.push(save("modifications.diff", "text/plain", Buffer.from(d)));
      continue;
    }
    const target = resolveReference(root, ref);
    if (!target) continue;
    const rel = relative(root, target).split(sep).join("/");
    const info = statSync(target);
    if (info.isDirectory()) {
      out.attachments.push(
        save(`${rel || "dossier"}-arborescence.txt`, "text/plain", Buffer.from(listing(root, target))),
      );
      continue;
    }
    if (info.size > MAX_FILE_BYTES) {
      out.notes.push(`[@${rel} : fichier trop volumineux (${Math.round(info.size / 1048576)} Mo), non joint]`);
      continue;
    }
    const data = readFileSync(target);
    const media = MEDIA[extname(target).toLowerCase()];
    if (media) out.attachments.push(save(basename(target), media, data));
    else if (looksBinary(data)) out.notes.push(`[@${rel} : fichier binaire, non joint]`);
    // The relative path as the name (its slashes become `_`): two `index.ts` stay distinguishable.
    else out.attachments.push(save(rel, "text/plain", data));
  }
  return out;
}

/** Workspace files whose path contains `query` (case-insensitive), best matches first. */
export function searchFiles(workspace: string, query: string, limit = 20): string[] {
  const root = realOf(resolve(workspace));
  if (!root) return [];
  const q = query.toLowerCase().replace(/\\/g, "/");
  const found: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 20_000) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = join(d, e);
      seen++;
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      const rel = relative(root, p).split(sep).join("/") + (isDir ? "/" : "");
      if (rel.toLowerCase().includes(q)) found.push(rel);
      if (isDir) stack.push(p);
    }
  }
  const rank = (p: string) => {
    const name = p.replace(/\/$/, "").split("/").pop()!.toLowerCase();
    return (name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2) * 1000 + p.length;
  };
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, limit);
}
