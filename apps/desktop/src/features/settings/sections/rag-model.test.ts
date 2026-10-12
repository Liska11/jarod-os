import { describe, expect, it } from 'vitest'
import { embeddingsUrlProblem, indexSummary, isLocalUrl, overlapProblem, type RagIndexStatus, reindexAdvice, runPercent, runText } from './rag-model.ts'

const status = (over: Partial<RagIndexStatus> = {}): RagIndexStatus => ({ enabled: true, documents: 3, passages: 40, reindexable: 2, missing: 1, endpoint: 'http://127.0.0.1:1234/v1', chunkSize: 800, chunkOverlap: 100, run: { state: 'idle', done: 0, total: 0, documents: 0, passages: 0, cancelling: false, error: null }, ...over })

describe('index summary', () => {
  it('counts documents and passages and names the embeddings server; off says so', () => {
    expect(indexSummary(status())).toBe('3 documents · 40 passages indexed · embeddings from http://127.0.0.1:1234/v1')
    expect(indexSummary(status({ documents: 1, passages: 1, endpoint: null }))).toBe('1 document · 1 passage indexed')
    expect(indexSummary(status({ enabled: false }))).toBe('Document search is off.')
  })

  it('advises on what a reindex can do', () => {
    expect(reindexAdvice(status())).toBe('2 documents can be re-cut and re-embedded with the current settings (1 cannot: index their files again).')
    expect(reindexAdvice(status({ reindexable: 0, missing: 0 }))).toBe('Nothing to redo yet.')
    expect(reindexAdvice(status({ reindexable: 0 }))).toMatch(/cannot be redone/)
    expect(reindexAdvice(status({ run: { ...status().run, state: 'running' } }))).toBe('Working…')
  })
})

describe('run state', () => {
  const base = status().run

  it('says each state; progress is clamped', () => {
    expect(runText(base)).toBeNull()
    expect(runText({ ...base, state: 'running', done: 2, total: 5 })).toBe('Reindexing 2 of 5')
    expect(runText({ ...base, state: 'running', done: 2, total: 5, cancelling: true })).toBe('Reindexing 2 of 5 (stopping…)')
    expect(runText({ ...base, state: 'done', documents: 5, passages: 60 })).toBe('Done: 5 documents, 60 passages.')
    expect(runText({ ...base, state: 'cancelled', documents: 2 })).toMatch(/Stopped\. 2 documents were redone/)
    expect(runText({ ...base, state: 'failed', error: 'server down' })).toBe('server down')
    expect(runPercent({ ...base, done: 1, total: 4 })).toBe(25)
    expect(runPercent({ ...base, done: 9, total: 4 })).toBe(100)
    expect(runPercent(base)).toBe(0)
  })
})

describe('validation', () => {
  it('embeddings address: empty is fine; http(s) without a login', () => {
    expect(embeddingsUrlProblem('')).toBeNull()
    expect(embeddingsUrlProblem('http://127.0.0.1:1234/v1')).toBeNull()
    expect(embeddingsUrlProblem('nope')).toMatch(/full address/)
    expect(embeddingsUrlProblem('ftp://x')).toMatch(/http/)
    expect(embeddingsUrlProblem('http://u:p@x/v1')).toMatch(/login/)
  })

  it('knows a local address from a remote one', () => {
    for (const url of ['http://localhost:1/v1', 'http://127.0.0.1:1/v1', 'http://[::1]:1/v1']) expect(isLocalUrl(url), url).toBe(true)
    for (const url of ['https://api.openai.com/v1', 'http://192.168.1.5/v1', 'junk']) expect(isLocalUrl(url), url).toBe(false)
  })

  it('overlap is at most half a chunk', () => {
    expect(overlapProblem(400, 800)).toBeNull()
    expect(overlapProblem(401, 800)).toBe('At most half a chunk (400).')
  })
})
