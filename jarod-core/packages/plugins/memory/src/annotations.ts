// Portage de packages/core/src/services/annotations.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import type { Db } from "@jarod/plugin-storage";
import type { EventStoreService } from "@jarod/plugin-storage";

export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/**
 * A unified diff, read into files, hunks and numbered lines. Both numbers are kept: an annotation
 * on a removed line means something different from one on an added line, and a parser that guesses
 * makes every comment land somewhere plausible and wrong.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (raw.startsWith("--- ")) {
      oldLine = 0;
      newLine = 0;
      hunk = null;
      file = { path: "", hunks: [], added: 0, removed: 0 };
      files.push(file);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (file) file.path = stripPrefix(raw.slice(4).trim().split(/\t/)[0] ?? "");
      continue;
    }
    if (raw.startsWith("@@")) {
      if (!file) continue;
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!file || !hunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file" is a note, not a line
    const first = raw[0] ?? " ";
    if (first === "+") {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine });
      file.added += 1;
      newLine += 1;
    } else if (first === "-") {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldLine, newLine: null });
      file.removed += 1;
      oldLine += 1;
    } else if (first === " " || raw === "") {
      hunk.lines.push({ kind: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return files.filter((entry) => entry.path !== "");
}

/** `b/src/x.ts` reads as `src/x.ts`: the prefix is the diff's, not the file's. */
function stripPrefix(path: string): string {
  const cleaned = path.replace(/^"(.*)"$/, "$1");
  return cleaned === "/dev/null" ? "/dev/null" : cleaned.replace(/^[ab]\//, "");
}

export interface Annotation {
  id: string;
  /** What the annotations belong to: a run, a session, a review — the caller's name for it. */
  ref: string;
  file: string;
  line: number;
  side: "new" | "old";
  text: string;
  /** The line's content when the note was written, so a later diff can say "this moved". */
  anchor: string;
  at: number;
  /** Set by review(): the anchored line no longer reads the same. */
  detached?: boolean;
}

interface Row {
  id: string;
  ref: string;
  file: string;
  line: number;
  side: string;
  text: string;
  anchor: string;
  at: number;
}

/**
 * Notes attached to the lines of a diff. They live in the database, not in memory: a review that
 * vanishes on restart is a review the reader has to write twice.
 */
export class AnnotationService {
  constructor(private readonly d: { db: Db; events?: EventStoreService }) {}

  /** Two identical notes on the same line are one note: the id comes from what it says. */
  add(
    ref: string,
    file: string,
    line: number,
    text: string,
    opts: { side?: "new" | "old"; anchor?: string } = {},
  ): Annotation {
    const comment = String(text ?? "").trim();
    if (!comment) throw new Error("ANNOTATION_EMPTY: une annotation sans texte ne dit rien");
    if (!Number.isInteger(line) || line < 0) throw new Error(`ANNOTATION_BAD_LINE: ${line}`);
    const side = opts.side === "old" ? "old" : "new";
    const id = createHash("sha256").update(`${ref}|${file}|${line}|${side}|${comment}`).digest("hex").slice(0, 16);
    const at = Date.now();
    const anchor = opts.anchor ?? "";
    this.d.db.run(
      "INSERT OR IGNORE INTO annotations (id, ref, file, line, side, text, anchor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      ref,
      file,
      line,
      side,
      comment,
      anchor,
      at,
    );
    this.d.events?.append(`annotations:${ref}`, "annotation.added", { id, file, line, side, text: comment });
    return { id, ref, file, line, side, text: comment, anchor, at };
  }

  list(ref: string): Annotation[] {
    return this.d.db.all<Row>("SELECT * FROM annotations WHERE ref = ? ORDER BY file, line, at", ref).map((row) => ({
      id: row.id,
      ref: row.ref,
      file: row.file,
      line: row.line,
      side: row.side === "old" ? "old" : "new",
      text: row.text,
      anchor: row.anchor,
      at: row.at,
    }));
  }

  remove(id: string): boolean {
    return this.d.db.run("DELETE FROM annotations WHERE id = ?", id).changes > 0;
  }

  /**
   * The annotations, each marked when the line it was written on no longer reads the same. What is
   * kept is the note and its anchor: the point is to show that the code moved, not to hide the
   * comment that was made about it.
   */
  review(ref: string, diff: string): Annotation[] {
    const files = parseUnifiedDiff(diff);
    return this.list(ref).map((entry) => {
      const file = files.find((candidate) => candidate.path === entry.file);
      const line = file
        ? file.hunks
            .flatMap((hunk) => hunk.lines)
            .find((candidate) => (entry.side === "old" ? candidate.oldLine : candidate.newLine) === entry.line)
        : undefined;
      const same = line !== undefined && (entry.anchor === "" || line.text === entry.anchor);
      return same ? entry : { ...entry, detached: true as const };
    });
  }

  /** What the agent reads: the note, the line it is about, and the line's content at the time. */
  format(ref: string, diff?: string): string {
    const entries = diff === undefined ? this.list(ref) : this.review(ref, diff);
    if (!entries.length) return "";
    const byFile = new Map<string, Annotation[]>();
    for (const entry of entries) {
      const list = byFile.get(entry.file) ?? [];
      list.push(entry);
      byFile.set(entry.file, list);
    }
    const out: string[] = [];
    for (const [file, list] of byFile) {
      out.push(`## ${file}`);
      for (const entry of list) {
        const where = `${entry.file}:${entry.line} (${entry.side})`;
        out.push(`- ${where}${entry.detached ? " [la ligne n'est plus celle-ci]" : ""}`);
        if (entry.anchor) out.push(`  > ${entry.anchor}`);
        out.push(`  ${entry.text}`);
      }
    }
    return out.join("\n");
  }
}
