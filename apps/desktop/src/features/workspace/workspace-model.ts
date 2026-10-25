/*
 * Workspace: the data side of the page (no React). Mirrors the engine's `codespace-*` channels: a repository, its task worktrees, the diff of each,
 * the coding agents installed on this machine, and GitHub rows read through `gh`.
 */

export interface Worktree {
  path: string
  /** Null for a detached HEAD. */
  branch: string | null
  head: string
  /** The first worktree git lists is the main checkout. */
  main: boolean
}

export interface ChangedFile {
  /** git's two-letter porcelain status, as is (` M`, `A `, `??`…). */
  status: string
  path: string
}

export interface DiffResult {
  files: ChangedFile[]
  patch: string
  truncated: boolean
}

export type HarnessId = 'claude' | 'codex'

export interface AgentInfo {
  id: HarnessId
  name: string
  /** Where the executable was found; null when it is not installed. */
  path: string | null
}

export interface AgentResult {
  ok: boolean
  text: string
  costUsd?: number
  exitCode: number | null
  stderr: string
  error?: string
}

export type StatusKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other'

/** What a porcelain status means to the reader: deletion and addition win over a plain modification. */
export function statusKind(code: string): StatusKind {
  if (code === '??') return 'untracked'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('M')) return 'modified'

  return 'other'
}

export const STATUS_TONE: Record<StatusKind, 'warn' | 'ok' | 'danger' | 'info' | 'muted'> = {
  modified: 'warn',
  added: 'ok',
  deleted: 'danger',
  renamed: 'info',
  untracked: 'info',
  other: 'muted'
}

export type LineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context'

export interface PatchLine {
  kind: LineKind
  text: string
}

const META_PREFIXES = ['diff --git ', 'index ', '--- ', '+++ ', 'new file mode', 'deleted file mode', 'similarity index', 'rename from', 'rename to', 'old mode', 'new mode', 'Binary files ']

/** A unified diff, line by line, ready to colour. File headers are "meta" so a `--- a/x` line is not read as a removal. */
export function patchLines(patch: string): PatchLine[] {
  if (!patch) return []

  const lines = patch.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  let inHunk = false

  return lines.map(text => {
    if (text.startsWith('diff --git ')) {
      inHunk = false

      return { kind: 'meta', text }
    }

    if (text.startsWith('@@')) {
      inHunk = true

      return { kind: 'hunk', text }
    }

    if (!inHunk && META_PREFIXES.some(prefix => text.startsWith(prefix))) return { kind: 'meta', text }
    if (text.startsWith('+')) return { kind: 'add', text }
    if (text.startsWith('-')) return { kind: 'remove', text }

    return { kind: 'context', text }
  })
}

export function shortHead(head: string): string {
  return head.slice(0, 7)
}

/** The name a worktree goes by: its branch, or the last part of its folder for a detached HEAD. */
export function worktreeName(worktree: Pick<Worktree, 'branch' | 'path'>): string {
  return worktree.branch ?? worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree.path
}

/** The task worktrees (everything but the main checkout), in the order git lists them. */
export function taskWorktrees(list: readonly Worktree[]): Worktree[] {
  return list.filter(worktree => !worktree.main)
}

/** The branch the main checkout is on: where a merge lands. */
export function mainBranch(list: readonly Worktree[]): string | null {
  return list.find(worktree => worktree.main)?.branch ?? null
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/

/** Mirrors the engine's rule, so the form says no before a round trip. Null = fine. */
export function branchProblem(name: string): 'empty' | 'invalid' | null {
  const trimmed = name.trim()

  if (!trimmed) return 'empty'
  if (!BRANCH_RE.test(trimmed) || trimmed.includes('..') || trimmed.endsWith('/') || trimmed.endsWith('.lock')) return 'invalid'

  return null
}

export interface GithubRow {
  number: number
  title: string
  state: string
  url: string
  author: string
  headRefName?: string
  labels: string[]
}

/** `gh --json` rows: the author is an object with a login, labels are objects with a name. Rows without a number are dropped. */
export function parseGithubRows(raw: unknown): GithubRow[] {
  if (!Array.isArray(raw)) return []

  const rows: GithubRow[] = []

  for (const entry of raw) {
    const row = (entry ?? {}) as { number?: unknown; title?: unknown; state?: unknown; url?: unknown; author?: unknown; headRefName?: unknown; labels?: unknown }

    if (typeof row.number !== 'number') continue

    const author = typeof row.author === 'string' ? row.author : ((row.author as { login?: unknown } | null)?.login ?? '')
    const labels = Array.isArray(row.labels) ? row.labels.map(label => (typeof label === 'string' ? label : (label as { name?: unknown })?.name)).filter((name): name is string => typeof name === 'string') : []

    rows.push({
      number: row.number,
      title: typeof row.title === 'string' ? row.title : '',
      state: typeof row.state === 'string' ? row.state : '',
      url: typeof row.url === 'string' ? row.url : '',
      author: typeof author === 'string' ? author : '',
      ...(typeof row.headRefName === 'string' ? { headRefName: row.headRefName } : {}),
      labels
    })
  }

  return rows
}

export const GITHUB_STATE_TONE: Record<string, 'ok' | 'progress' | 'danger' | 'muted'> = { OPEN: 'ok', MERGED: 'progress', CLOSED: 'danger' }
