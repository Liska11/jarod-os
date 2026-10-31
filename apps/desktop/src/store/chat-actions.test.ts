import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
const renameSession = vi.fn()
const downloaded: Array<{ name: string; text: string }> = []
const notified: Array<{ title: string; body?: string; level?: string }> = []

vi.mock('./gateway.ts', () => ({
  gatewayRequest: (...args: unknown[]) => request(...args),
  gatewayCall: vi.fn(),
  onAnyGatewayEvent: () => () => undefined
}))
vi.mock('./backend.ts', () => ({ $env: atom({ homeDir: '/home/me' }), $prefs: atom({ defaultCwd: null }) }))
vi.mock('./notifications.ts', () => ({ notify: (n: { title: string }) => void notified.push(n) }))
vi.mock('./sessions.ts', () => ({
  $sessions: atom([{ id: 'stored-b', title: 'Titre du rail' }]),
  refreshSessions: async () => undefined,
  rememberRuntimeId: vi.fn(),
  renameSession: (...args: unknown[]) => renameSession(...args)
}))
vi.mock('../lib/clipboard.ts', () => ({ downloadText: (name: string, text: string) => void downloaded.push({ name, text }) }))
vi.mock('../lib/i18n.ts', () => ({
  $assistantName: atom('Jarod'),
  t: (key: string, vars?: Record<string, string>) => (vars?.date ? `${key} ${vars.date}` : key)
}))

const { $chats, resetChats } = await import('./chat.ts')
const { exportConversation, renameChat } = await import('./chat-actions.ts')
const { appendUser, emptyChat } = await import('../lib/chat-model.ts')

beforeEach(() => {
  request.mockReset()
  renameSession.mockReset()
  downloaded.length = 0
  notified.length = 0
  resetChats()
})

describe('renameChat', () => {
  it('has the core keep the title, then the open chat shows it', async () => {
    $chats.setKey('s1', emptyChat('s1', 'stored-a'))
    renameSession.mockResolvedValue('Les comptes')

    await renameChat('stored-a', '  Les comptes  ')

    expect(renameSession).toHaveBeenCalledWith('stored-a', 'Les comptes')
    expect($chats.get().s1?.title).toBe('Les comptes')
    expect($chats.get().s1?.info.title).toBe('Les comptes')
  })

  it('does nothing for an empty title', async () => {
    await renameChat('stored-a', '   ')

    expect(renameSession).not.toHaveBeenCalled()
  })

  it('lets the error reach the caller, who says it, and leaves the chat as it was', async () => {
    $chats.setKey('s1', { ...emptyChat('s1', 'stored-a'), title: 'Avant' })
    renameSession.mockRejectedValue(new Error('unknown session'))

    await expect(renameChat('stored-a', 'Après')).rejects.toThrow('unknown session')
    expect($chats.get().s1?.title).toBe('Avant')
  })
})

describe('exportConversation', () => {
  it('exports an open chat without asking the core', async () => {
    $chats.setKey('s1', { ...appendUser(emptyChat('s1', 'stored-a'), 'Bonjour'), title: 'Salut' })

    await exportConversation('stored-a')

    expect(request).not.toHaveBeenCalled()
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0]!.name).toMatch(/^Salut - \d{4}-\d{2}-\d{2}\.md$/)
    expect(downloaded[0]!.text).toContain('# Salut')
    expect(downloaded[0]!.text).toContain('## chat.export.you')
    expect(downloaded[0]!.text).toContain('Bonjour')
    expect(notified[0]).toMatchObject({ title: 'chat.exported', level: 'success' })
  })

  it('reads a conversation that is not open from the core, with the rail title as fallback', async () => {
    request.mockResolvedValue({
      session_id: 'x',
      stored_session_id: 'stored-b',
      messages: [
        { role: 'user', text: 'Question' },
        { role: 'assistant', text: 'Réponse' }
      ],
      info: {}
    })

    await exportConversation('stored-b')

    expect(request).toHaveBeenCalledWith('session.resume', expect.objectContaining({ session_id: 'stored-b' }))
    expect(downloaded[0]!.text).toContain('# Titre du rail')
    expect(downloaded[0]!.text).toContain('Question')
    expect(downloaded[0]!.text).toContain('Réponse')
  })

  it('says so when there is nothing to export', async () => {
    request.mockResolvedValue({ session_id: 'x', messages: [], info: {} })

    await exportConversation('stored-b')

    expect(downloaded).toEqual([])
    expect(notified[0]).toMatchObject({ title: 'chat.exportEmpty' })
  })

  it('reports a failure instead of throwing', async () => {
    request.mockRejectedValue(new Error('gateway closed'))

    await exportConversation('stored-b')

    expect(downloaded).toEqual([])
    expect(notified[0]).toMatchObject({ title: 'chat.exportFailed', body: 'gateway closed', level: 'error' })
  })
})
