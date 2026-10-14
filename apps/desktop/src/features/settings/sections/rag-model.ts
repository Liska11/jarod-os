/*
 * Document search (RAG): the data side of the section. Mirrors `get-jarod-settings.rag` and `rag-index-status` / `rag-reindex`.
 * The prose goes through the catalogue (`t` / `tn`), so it follows the interface language.
 */

import { t, tn } from '../../../lib/i18n.ts'

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

const count = (n: number, base: 'rag.count.document' | 'rag.count.passage'): string => tn(base, n)

export function indexSummary(status: RagIndexStatus): string {
  if (!status.enabled) {
    return t('rag.summary.off')
  }

  const base = t('rag.summary.indexed', { documents: count(status.documents, 'rag.count.document'), passages: count(status.passages, 'rag.count.passage') })

  return status.endpoint ? base + t('rag.summary.endpoint', { endpoint: status.endpoint }) : base
}

export function reindexAdvice(status: RagIndexStatus): string {
  if (status.run.state === 'running') {
    return t('rag.advice.working')
  }

  if (status.reindexable === 0) {
    return status.missing > 0 ? t('rag.advice.missingOnly', { missing: count(status.missing, 'rag.count.document') }) : t('rag.advice.nothing')
  }

  const reindexable = count(status.reindexable, 'rag.count.document')

  return status.missing > 0 ? t('rag.advice.reindexableMissing', { reindexable, missing: status.missing }) : t('rag.advice.reindexable', { reindexable })
}

export function runText(run: RagRun): string | null {
  switch (run.state) {
    case 'running':
      return run.cancelling ? t('rag.run.runningStopping', { done: run.done, total: run.total }) : t('rag.run.running', { done: run.done, total: run.total })
    case 'done':
      return t('rag.run.done', { documents: count(run.documents, 'rag.count.document'), passages: count(run.passages, 'rag.count.passage') })
    case 'cancelled':
      return t('rag.run.cancelled', { documents: count(run.documents, 'rag.count.document') })
    case 'failed':
      return run.error ?? t('rag.run.failed')
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
    return t('rag.error.address')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return t('rag.error.protocol')
  }

  return url.username || url.password ? t('rag.error.login') : null
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
  return overlap > Math.floor(chunkSize / 2) ? t('rag.error.overlap', { half: Math.floor(chunkSize / 2) }) : null
}
