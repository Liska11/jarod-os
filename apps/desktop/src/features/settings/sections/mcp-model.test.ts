import { describe, expect, it } from 'vitest'
import { describeServer, draftOf, draftProblems, emptyDraft, envNames, inputOf, type McpServer, parseEnv, SECRET_MASK } from './mcp-model.ts'

const stdio: McpServer = { name: 'fs', type: 'stdio', enabled: true, detail: 'npx', command: 'npx', args: ['-y', 'pkg', '--root', 'C:\\data'], env: { TOKEN: SECRET_MASK, MODE: SECRET_MASK } }
const http: McpServer = { name: 'web', type: 'http', enabled: true, detail: 'https://x.test/mcp', url: 'https://x.test/mcp', args: [], env: {} }

describe('parseEnv', () => {
  it('one NAME=value per line; the first = splits; blank lines are skipped', () => {
    expect(parseEnv('A=1\n\n B = x=y \r\nC=')).toEqual({ env: { A: '1', B: ' x=y', C: '' }, error: null })
  })

  it('a line without a valid name is an error that names it', () => {
    expect(parseEnv('A=1\nnonsense').error).toMatch(/“nonsense”/)
    expect(parseEnv('1BAD=2').error).toMatch(/1BAD/)
    expect(parseEnv('=x').error).toBeTruthy()
  })
})

describe('draft round trip', () => {
  it('a stdio server keeps its arguments one per line and its secrets masked', () => {
    const draft = draftOf(stdio)

    expect(draft).toMatchObject({ name: 'fs', type: 'stdio', command: 'npx', args: '-y\npkg\n--root\nC:\\data' })
    expect(draft.env).toBe(`TOKEN=${SECRET_MASK}\nMODE=${SECRET_MASK}`)
    expect(inputOf(draft)).toEqual({ name: 'fs', type: 'stdio', command: 'npx', args: ['-y', 'pkg', '--root', 'C:\\data'], env: { TOKEN: SECRET_MASK, MODE: SECRET_MASK } })
  })

  it('an http server sends only its name and URL', () => {
    expect(inputOf(draftOf(http))).toEqual({ name: 'web', type: 'http', url: 'https://x.test/mcp' })
  })
})

describe('draftProblems', () => {
  const ok = { ...emptyDraft(), name: 'fs', command: 'npx' }

  it('a complete draft is fine', () => {
    expect(draftProblems(ok, [])).toEqual([])
    expect(draftProblems({ ...emptyDraft(), name: 'web', type: 'http', url: 'http://127.0.0.1:8000/mcp' }, [])).toEqual([])
  })

  it('names each problem: name, duplicate (unless it is the server being edited), url, command, environment', () => {
    expect(draftProblems({ ...ok, name: '-x' }, [])[0]).toMatch(/^Name/)
    expect(draftProblems(ok, ['fs'])).toEqual(['A server called “fs” already exists.'])
    expect(draftProblems(ok, ['fs'], 'fs')).toEqual([])
    expect(draftProblems({ ...ok, type: 'http', url: 'ftp://x' }, [])).toEqual(['URL: it must start with http:// or https://.'])
    expect(draftProblems({ ...ok, command: '  ' }, [])).toEqual(['Command: the program to start, like npx or uvx.'])
    expect(draftProblems({ ...ok, env: 'bad line' }, [])[0]).toMatch(/^Environment/)
  })
})

describe('summaries', () => {
  it('describes a server by its command line or URL, and lists env names only', () => {
    expect(describeServer(stdio)).toBe('npx -y pkg --root C:\\data')
    expect(describeServer(http)).toBe('https://x.test/mcp')
    expect(envNames(stdio)).toEqual(['TOKEN', 'MODE'])
  })
})
