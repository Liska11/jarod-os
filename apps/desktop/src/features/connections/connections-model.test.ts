import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()

vi.mock('../../lib/rest.ts', () => ({ rest: { get: (...args: unknown[]) => get(...args), post: vi.fn(), put: vi.fn(), del: vi.fn() } }))

const { errorText, loadConnections } = await import('./connections-model.ts')

const answers: Record<string, () => Promise<unknown>> = {}

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key]
  Object.assign(answers, {
    '/api/mcp/servers': () => Promise.resolve({ servers: [] }),
    '/api/mcp/catalog': () => Promise.resolve({ entries: [] }),
    '/api/tools/toolsets': () => Promise.resolve([]),
    '/api/messaging/platforms': () => Promise.resolve({ platforms: [] }),
    '/api/providers/oauth': () => Promise.resolve({ providers: [] })
  })
  get.mockImplementation((path: string) => (answers[path] ?? (() => Promise.reject(new Error(`no ${path}`))))())
})

describe('loadConnections', () => {
  it('does not count a source the engine says is not available as one that failed to load', async () => {
    answers['/api/mcp/catalog'] = () => Promise.reject(new Error('GET /api/mcp/catalog -> 404: Not available in this version'))

    expect((await loadConnections()).warnings).toEqual([])
  })

  it('still reports a source that really failed', async () => {
    answers['/api/tools/toolsets'] = () => Promise.reject(new Error('GET /api/tools/toolsets -> 500: internal error'))

    expect((await loadConnections()).warnings).toEqual(['Toolsets: GET /api/tools/toolsets -> 500: internal error'])
  })
})

describe('errorText', () => {
  it('shows the one sentence for a known gap and the message otherwise', () => {
    expect(errorText(new Error('POST /api/mcp/servers/x/auth -> 404: Not available in this version'))).toBe('Not available in this version')
    expect(errorText(new Error('boom'))).toBe('boom')
  })
})
