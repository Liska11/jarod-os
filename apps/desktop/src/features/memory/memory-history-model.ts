/*
 * V-18: the memory's history as the core keeps it (`memory-history`, written by SQL triggers whatever wrote the memory), and the
 * word-by-word difference between two versions of a memory, for the history panel. Pure, no I/O.
 */

export interface MemoryChange {
  seq: number
  memoryId: string
  action: 'add' | 'update' | 'delete'
  before?: { type: string; content: string }
  after?: { type: string; content: string }
  at: number
}

export interface DiffPart {
  kind: 'same' | 'del' | 'add'
  text: string
}

/** Words and the spaces between them, so joining the parts gives back each text exactly. */
const tokens = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? []

/** Above this many token pairs the diff is not computed word by word: the whole old text is shown removed, the new one added. */
const MAX_CELLS = 250_000

/** Word-level difference (longest common subsequence), merged into runs. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before)
  const b = tokens(after)

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...(before ? [{ kind: 'del' as const, text: before }] : []),
      ...(after ? [{ kind: 'add' as const, text: after }] : [])
    ]
  }

  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const parts: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts.at(-1)

    if (last?.kind === kind) {
      last.text += text
    } else {
      parts.push({ kind, text })
    }
  }
  let i = 0
  let j = 0

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push('same', a[i]!)
      i++
      j++
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Removals first, as in the turn diffs (V-08).
      push('del', a[i]!)
      i++
    } else {
      push('add', b[j]!)
      j++
    }
  }

  return parts
}

/** What a change did, as the panel shows it: the parts to draw, and whether the memory's type changed too. */
export function describeChange(change: MemoryChange): { parts: DiffPart[]; typeChange: { from: string; to: string } | null } {
  if (change.action === 'add') {
    return { parts: [{ kind: 'add', text: change.after?.content ?? '' }], typeChange: null }
  }

  if (change.action === 'delete') {
    return { parts: [{ kind: 'del', text: change.before?.content ?? '' }], typeChange: null }
  }

  const from = change.before?.type ?? ''
  const to = change.after?.type ?? ''

  return { parts: wordDiff(change.before?.content ?? '', change.after?.content ?? ''), typeChange: from !== to ? { from, to } : null }
}
