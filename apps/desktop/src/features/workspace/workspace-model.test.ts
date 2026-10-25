import { describe, expect, it } from 'vitest'
import { branchProblem, mainBranch, parseGithubRows, patchLines, shortHead, statusKind, taskWorktrees, worktreeName, type Worktree } from './workspace-model.ts'

describe('statusKind', () => {
  it('reads git porcelain codes the way a reader would', () => {
    expect(statusKind(' M')).toBe('modified')
    expect(statusKind('M ')).toBe('modified')
    expect(statusKind('A ')).toBe('added')
    expect(statusKind(' D')).toBe('deleted')
    expect(statusKind('R ')).toBe('renamed')
    expect(statusKind('??')).toBe('untracked')
    expect(statusKind('UU')).toBe('other')
  })

  it('shows a deletion or an addition before a modification', () => {
    expect(statusKind('AM')).toBe('added')
    expect(statusKind('MD')).toBe('deleted')
  })
})

describe('patchLines', () => {
  it('colours additions, removals and hunks, and keeps file headers out of the +/- lines', () => {
    const lines = patchLines(['diff --git a/app.txt b/app.txt', 'index 1..2 100644', '--- a/app.txt', '+++ b/app.txt', '@@ -1 +1 @@', '-v1', '+v2', ' same', ''].join('\n'))

    expect(lines.map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'remove', 'add', 'context'])
  })

  it('keeps a removed line that starts with dashes inside a hunk as a removal', () => {
    const lines = patchLines(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,1 @@', '--- a comment', ' kept'].join('\n'))

    expect(lines[4]).toEqual({ kind: 'remove', text: '--- a comment' })
  })

  it('returns nothing for an empty patch', () => {
    expect(patchLines('')).toEqual([])
  })
})

describe('worktrees', () => {
  const list: Worktree[] = [
    { path: 'C:/work/app', branch: 'main', head: 'abcdef1234567', main: true },
    { path: 'C:/work/app-worktrees/feature__x', branch: 'feature/x', head: '1234567890abc', main: false },
    { path: 'C:/work/app-worktrees/detached', branch: null, head: 'fff', main: false }
  ]

  it('separates task worktrees from the main checkout, and finds the merge target', () => {
    expect(taskWorktrees(list).map(w => w.branch)).toEqual(['feature/x', null])
    expect(mainBranch(list)).toBe('main')
    expect(mainBranch([])).toBeNull()
  })

  it('names a worktree by its branch, or by its folder when detached', () => {
    expect(worktreeName(list[1]!)).toBe('feature/x')
    expect(worktreeName(list[2]!)).toBe('detached')
    expect(shortHead(list[0]!.head)).toBe('abcdef1')
  })
})

describe('branchProblem', () => {
  it('accepts ordinary names and rejects what the engine rejects', () => {
    expect(branchProblem('feature/login-2')).toBeNull()
    expect(branchProblem('  ')).toBe('empty')

    for (const bad of ['-x', 'a..b', 'a b', 'x/', 'x.lock', 'a;rm']) {
      expect(branchProblem(bad), bad).toBe('invalid')
    }
  })
})

describe('parseGithubRows', () => {
  it('reads gh rows: author login, label names, optional head branch', () => {
    const rows = parseGithubRows([
      { number: 7, title: 'Fix', state: 'OPEN', url: 'u', author: { login: 'ana' }, headRefName: 'fix', labels: [{ name: 'bug' }] },
      { number: 8, title: 'Issue', state: 'CLOSED', url: 'v', author: { login: 'bob' }, labels: [] },
      { title: 'no number' },
      null
    ])

    expect(rows).toEqual([
      { number: 7, title: 'Fix', state: 'OPEN', url: 'u', author: 'ana', headRefName: 'fix', labels: ['bug'] },
      { number: 8, title: 'Issue', state: 'CLOSED', url: 'v', author: 'bob', labels: [] }
    ])
    expect(parseGithubRows('nope')).toEqual([])
  })
})
