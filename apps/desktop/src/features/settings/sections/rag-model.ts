/*
 * Document search (RAG): the data side of the section. Mirrors `get-jarod-settings.rag` and `rag-index-status` / `rag-reindex`.
 */

export interface RagRun {
  state: 'idle' | 'running' | 'done' | 'cancelled' | 'failed'
  done: number
  total: number
  documents: number
  passages: number
  cancelling: boolean
  error: string | null
}

export interface RagIndexStatus {
  enabled: boolean
  documents: number
  passages: number
  reindexable: number
  missing: number
  endpoint: string | null
  chunkSize: number
  chunkOverlap: number
  run: RagRun
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export function indexSummary(status: RagIndexStatus): string {
  if (!status.enabled) {
    return 'Document search is off.'
  }

  const base = `${plural(status.documents, 'document', 'documents')} · ${plural(status.passages, 'passage', 'passages')} indexed`
  const where = status.endpoint ? ` · embeddings from ${status.endpoint}` : ''

  return base + where
}

export function reindexAdvice(status: RagIndexStatus): string {
  if (status.run.state === 'running') {
    return 'Working…'
  }

  if (status.reindexable === 0) {
    return status.missing > 0 ? `${plural(status.missing, 'document', 'documents')} indexed before the text was kept cannot be redone; index their files again.` : 'Nothing to redo yet.'
  }

  return `${plural(status.reindexable, 'document', 'documents')} can be re-cut and re-embedded with the current settings${status.missing > 0 ? ` (${status.missing} cannot: index their files again)` : ''}.`
}

export function runText(run: RagRun): string | null {
  switch (run.state) {
    case 'running':
      return `Reindexing ${run.done} of ${run.total}${run.cancelling ? ' (stopping…)' : ''}`
    case 'done':
      return `Done: ${plural(run.documents, 'document', 'documents')}, ${plural(run.passages, 'passage', 'passages')}.`
    case 'cancelled':
      return `Stopped. ${plural(run.documents, 'document', 'documents')} were redone and stay redone.`
    case 'failed':
      return run.error ?? 'Reindexing failed.'
    default:
      return null
  }
}

export function runPercent(run: RagRun): number {
  return run.total > 0 ? Math.max(0, Math.min(100, Math.round((run.done / run.total) * 100))) : 0
}

/** The embeddings address: http(s), no login; a non-local address sends document text off this PC (the engine confirms). */
export function embeddingsUrlProblem(text: string): string | null {
  if (!text) {
    return null
  }

  let url: URL

  try {
    url = new URL(text)
  } catch {
    return 'A full address, like http://127.0.0.1:1234/v1.'
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'http:// or https:// only.'
  }

  return url.username || url.password ? 'No login in the address.' : null
}

export function isLocalUrl(text: string): boolean {
  try {
    const host = new URL(text).hostname.replace(/^\[|\]$/g, '').toLowerCase()

    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** The overlap never exceeds half a chunk (the engine refuses otherwise). */
export function overlapProblem(overlap: number, chunkSize: number): string | null {
  return overlap > Math.floor(chunkSize / 2) ? `At most half a chunk (${Math.floor(chunkSize / 2)}).` : null
}
