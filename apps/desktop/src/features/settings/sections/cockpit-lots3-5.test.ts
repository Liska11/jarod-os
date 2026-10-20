import { describe, expect, it } from 'vitest'
import { previewDocument, sizeText } from './ArtifactsSection.tsx'
import { formatChars, proxyUrlProblem } from './ContextSection.tsx'
import { contextModeDraft, inputOf } from './mcp-model.ts'

describe('Context screen', () => {
  it('only a loopback http address without a path is accepted for the proxy', () => {
    expect(proxyUrlProblem('http://127.0.0.1:8787')).toBeNull()
    expect(proxyUrlProblem('http://localhost:9000/')).toBeNull()
    for (const bad of ['https://127.0.0.1:8787', 'http://10.0.0.1:8787', 'http://127.0.0.1:8787/bili', 'x']) expect(proxyUrlProblem(bad), bad).not.toBeNull()
  })

  it('formats large character counts', () => {
    expect(formatChars(950)).toBe('950')
    expect(formatChars(12_400)).toBe('12 k')
    expect(formatChars(3_400_000)).toBe('3.4 M')
  })
})

describe('Artifacts screen', () => {
  it('an SVG is wrapped in a page, text is escaped, an HTML diagram is shown as is (always in a frame without scripts)', () => {
    expect(previewDocument({ kind: 'svg', text: '<svg/>' })).toContain('<svg/>')
    expect(previewDocument({ kind: 'text', text: '<b>x</b>' })).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(previewDocument({ kind: 'html', text: '<p>d</p>' })).toBe('<p>d</p>')
    expect(previewDocument({ kind: 'none', reason: 'x' })).toBeNull()
    expect(sizeText(2048)).toBe('2 Ko')
  })
})

describe('context-mode MCP preset', () => {
  it('pre-fills a pinned npx command, nothing else', () => {
    expect(inputOf(contextModeDraft())).toMatchObject({ name: 'context-mode', command: 'npx', args: ['-y', 'context-mode@1.0.169'] })
  })
})
