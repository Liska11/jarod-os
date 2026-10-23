/**
 * V-08 — ce qu'un tour de conversation a CHANGÉ dans les fichiers, pour la timeline sous ce tour : chaque fichier, ses lignes ajoutées et retirées,
 * et un diff borné. Rien n'est recopié dans le journal : « avant » est le point de reprise que la porte garde déjà avant la première écriture du
 * tour (`file_checkpoints`, ce qui sert à `/rewind`) ; « après » est le point de reprise du tour SUIVANT qui a touché le même fichier, sinon le
 * fichier tel qu'il est maintenant. Ce que `run_shell` a changé n'est pas suivi (pas de point de reprise) : la vue le dit.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

/** Ce que ce module lit de la base (plugin-storage `Db`, vu par sa forme). */
export interface TurnDb {
  get<T>(sql: string, ...params: (string | number | null)[]): T | undefined;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export interface FileChange {
  /** Relatif au dossier de travail quand il y est, sinon le chemin complet. */
  path: string;
  status: "created" | "modified" | "deleted" | "unchanged";
  added: number;
  removed: number;
  /** Le diff, réduit au contexte (3 lignes) autour des changements ; absent pour un binaire ou un fichier trop grand. */
  hunks?: DiffLine[][];
  /** Pourquoi il n'y a pas de diff ligne à ligne. */
  note?: string;
}

/** Au-delà, pas de diff ligne à ligne (le calcul est quadratique) : seulement « modifié ». */
const MAX_DIFF_CELLS = 4_000_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT = 3;
const MAX_SHOWN_LINES = 400;

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/** Diff de lignes par plus longue sous-suite commune ; `null` si le calcul serait trop gros. */
export function diffLines(before: string[], after: string[]): DiffLine[] | null {
  // Les lignes communes du début et de la fin ne coûtent rien : seul le milieu passe par la table.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return null;
  const n = a.length;
  const m = b.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  const out: DiffLine[] = before.slice(0, head).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
      // À égalité, le retrait d'abord : « - ancienne / + nouvelle », comme tout diff.
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  for (const text of before.slice(before.length - tail)) out.push({ kind: "same", text });
  return out;
}

/** Les morceaux qui changent, chacun avec `CONTEXT` lignes autour ; au plus `MAX_SHOWN_LINES` lignes en tout. */
export function hunksOf(lines: DiffLine[]): DiffLine[][] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep.add(k);
  });
  const hunks: DiffLine[][] = [];
  let shown = 0;
  let current: DiffLine[] | null = null;
  for (let i = 0; i < lines.length && shown < MAX_SHOWN_LINES; i++) {
    if (!keep.has(i)) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      hunks.push(current);
    }
    current.push(lines[i]!);
    shown++;
  }
  return hunks;
}

const split = (b: Buffer | null): string[] => (b === null ? [] : b.toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Le contenu d'un fichier maintenant (null s'il n'existe pas, ou n'est pas un fichier lisible). */
function current(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
  return readFileSync(path);
}

export function fileChange(path: string, before: Buffer | null, after: Buffer | null, workspace: string | null): FileChange {
  const shown = workspace && !relative(workspace, path).startsWith("..") ? relative(workspace, path).replace(/\\/g, "/") : path;
  const status: FileChange["status"] = before === null && after === null ? "unchanged" : before === null ? "created" : after === null ? "deleted" : before.equals(after) ? "unchanged" : "modified";
  if ((before && isBinary(before)) || (after && isBinary(after))) return { path: shown, status, added: 0, removed: 0, note: "fichier binaire : pas de diff ligne à ligne" };
  if ((before?.length ?? 0) > MAX_FILE_BYTES || (after?.length ?? 0) > MAX_FILE_BYTES) return { path: shown, status, added: 0, removed: 0, note: "fichier trop grand pour un diff" };
  const lines = diffLines(split(before), split(after));
  if (!lines) return { path: shown, status, added: 0, removed: 0, note: "trop de lignes changées pour un diff" };
  return {
    path: shown,
    status,
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
    hunks: hunksOf(lines),
  };
}

export interface TurnChanges {
  /** Le tour (la position du message de la personne qui l'a ouvert), ou null si l'appel est introuvable. */
  turn: number | null;
  files: FileChange[];
}

/** Les fichiers changés par le tour de l'appel `callId` dans cette conversation. */
export function turnChanges(db: TurnDb, sessionId: string, callId: string, workspace: string | null): TurnChanges {
  const call = db.get<{ seq: number }>("SELECT seq FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? ORDER BY seq LIMIT 1", sessionId, callId);
  if (!call) return { turn: null, files: [] };
  const turn =
    db.get<{ seq: number }>("SELECT seq FROM messages WHERE session_id = ? AND role = 'user' AND kind IS NULL AND seq < ? ORDER BY seq DESC LIMIT 1", sessionId, call.seq)?.seq ?? 0;
  const rows = db.all<{ path: string; content: Buffer | null }>("SELECT path, content FROM file_checkpoints WHERE session_id = ? AND turn = ? ORDER BY seq", sessionId, turn);
  const files = rows.map((r) => {
    // L'état APRÈS ce tour : ce que le tour suivant a gardé avant d'écrire à son tour, sinon le fichier maintenant.
    const next = db.get<{ content: Buffer | null }>("SELECT content FROM file_checkpoints WHERE session_id = ? AND path = ? AND turn > ? ORDER BY turn LIMIT 1", sessionId, r.path, turn);
    return fileChange(r.path, r.content, next ? next.content : current(r.path), workspace);
  });
  return { turn, files };
}
