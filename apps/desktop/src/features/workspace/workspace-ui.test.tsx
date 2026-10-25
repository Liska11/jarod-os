// @vitest-environment jsdom
/**
 * La page Workspace vue de la fenêtre, avec un moteur factice : ce que chaque onglet demande au moteur et ce qu'il en montre.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jarod = vi.fn()

vi.mock('../../lib/jarod.ts', () => ({ jarod: (...args: unknown[]) => jarod(...args) }))
vi.mock('../../store/notifications.ts', () => ({ notify: vi.fn() }))

const { WorkspacePage } = await import('./WorkspacePage.tsx')

const REPO = 'C:/work/app'
const WORKTREES = [
  { path: REPO, branch: 'main', head: 'aaaaaaa1111', main: true },
  { path: 'C:/work/app-worktrees/feature__login', branch: 'feature/login', head: 'bbbbbbb2222', main: false }
]
const PATCH = ['diff --git a/app.txt b/app.txt', '--- a/app.txt', '+++ b/app.txt', '@@ -1 +1 @@', '-v1', '+v2', ''].join('\n')

/** Answers the engine's `codespace-*` channels the way it does for a repository with one task worktree. */
function engine(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  jarod.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (overrides[channel]) return overrides[channel](...args)

    switch (channel) {
      case 'get-default-workspace':
        return REPO
      case 'codespace-worktrees':
        return WORKTREES
      case 'codespace-diff':
        return { files: [{ status: ' M', path: 'app.txt' }], patch: PATCH, truncated: false }
      case 'codespace-agents':
        return [
          { id: 'claude', name: 'Claude Code', path: 'C:/bin/claude.cmd' },
          { id: 'codex', name: 'Codex CLI', path: null }
        ]
      case 'codespace-github-list':
        return [{ number: 7, title: 'Add login', state: 'OPEN', url: 'https://github.com/o/r/pull/7', author: { login: 'ana' }, headRefName: 'feature/login', labels: [{ name: 'feature' }] }]
      default:
        throw new Error(`unexpected ${channel}`)
    }
  })
}

// A block body: `mockReset()` returns the mock itself, which vitest would otherwise call as a cleanup hook.
beforeEach(() => {
  jarod.mockReset()
})
afterEach(cleanup)

describe('WorkspacePage', () => {
  it('asks for a repository when the default folder is not usable', async () => {
    engine({
      'get-default-workspace': () => null
    })
    render(<WorkspacePage />)

    expect(await screen.findByText('Pick a git repository')).toBeTruthy()
    expect(jarod).not.toHaveBeenCalledWith('codespace-worktrees', expect.anything())
  })

  it('loads the default folder, lists the task worktrees and shows the selected one’s diff in colour', async () => {
    engine()
    render(<WorkspacePage />)

    expect(await screen.findAllByText('feature/login')).toBeTruthy()
    expect(jarod).toHaveBeenCalledWith('codespace-diff', REPO, WORKTREES[1]!.path)

    const added = await screen.findByText('+v2')
    const removed = screen.getByText('-v1')
    expect(added.className).toContain('text-ok')
    expect(removed.className).toContain('text-danger')
    expect(screen.getByText('Merge into main')).toBeTruthy()
  })

  it('merging asks the engine for the task’s branch (the native confirmation happens in the engine)', async () => {
    engine({ 'codespace-merge': () => ({ into: 'main', head: 'ccc' }) })
    render(<WorkspacePage />)

    fireEvent.click(await screen.findByText('Merge into main'))

    await waitFor(() => expect(jarod).toHaveBeenCalledWith('codespace-merge', REPO, 'feature/login'))
  })

  it('a declined confirmation (null) changes nothing and shows no error', async () => {
    engine({ 'codespace-merge': () => null })
    render(<WorkspacePage />)

    fireEvent.click(await screen.findByText('Merge into main'))
    await waitFor(() => expect(jarod).toHaveBeenCalledWith('codespace-merge', REPO, 'feature/login'))

    expect(screen.queryByText(/refus|error/i)).toBeNull()
  })

  it('creating a task validates the branch name before asking the engine', async () => {
    engine({ 'codespace-create-worktree': () => ({ path: 'C:/work/app-worktrees/fix', branch: 'fix' }) })
    render(<WorkspacePage />)
    await screen.findAllByText('feature/login')

    fireEvent.click(screen.getByText('New task'))
    const field = screen.getByLabelText('Branch name')

    fireEvent.change(field, { target: { value: 'not valid' } })
    expect(screen.getByText(/Letters, digits/)).toBeTruthy()
    expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(field, { target: { value: 'fix' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(jarod).toHaveBeenCalledWith('codespace-create-worktree', REPO, 'fix'))
  })

  it('the Agents tab offers installed agents, runs one in the selected task and shows its answer', async () => {
    engine({
      'codespace-run-agent': () => ({ ok: true, text: 'Added the login form.', costUsd: 0.0123, exitCode: 0, stderr: '' })
    })
    render(<WorkspacePage />)
    await screen.findAllByText('feature/login')

    fireEvent.click(screen.getByText('Agents'))
    expect(await screen.findByText('Found: C:/bin/claude.cmd')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Describe the work for this task…'), { target: { value: 'add a login form' } })
    fireEvent.click(screen.getByText('Run'))

    expect(await screen.findByText('Added the login form.')).toBeTruthy()
    expect(jarod).toHaveBeenCalledWith('codespace-run-agent', REPO, WORKTREES[1]!.path, 'claude', 'add a login form', undefined)
    expect(screen.getByText('Reported cost: $0.0123')).toBeTruthy()
  })

  it('the GitHub tab lists pull requests from the engine', async () => {
    engine()
    render(<WorkspacePage />)
    await screen.findAllByText('feature/login')

    fireEvent.click(screen.getByText('GitHub'))

    expect(await screen.findByText('Add login')).toBeTruthy()
    expect(screen.getByText('by ana')).toBeTruthy()
    expect(jarod).toHaveBeenCalledWith('codespace-github-list', REPO, 'prs', 'open')
  })

  it('when gh cannot be reached, the GitHub tab explains instead of showing an empty list', async () => {
    engine({
      'codespace-github-list': () => {
        throw new Error('gh pr list : not logged in')
      }
    })
    render(<WorkspacePage />)
    await screen.findAllByText('feature/login')

    fireEvent.click(screen.getByText('GitHub'))

    expect(await screen.findByText(/GitHub is not reachable from this folder/)).toBeTruthy()
  })
})
