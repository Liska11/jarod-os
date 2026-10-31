import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc.ts'
import { clampToArea, MINI_SIZE, MiniWindow, miniPaths, miniPosition, normalizeDrag, normalizeMiniSummary } from './mini-window.ts'

describe('mini-fenêtre : le résumé re-validé par le main', () => {
  it('garde des textes bornés sans caractère de contrôle, au plus trois lignes, des nombres entiers', () => {
    const s = normalizeMiniSummary({
      working: [{ title: `Titre\u0007 ${'x'.repeat(200)}`, status: 'écrit un fichier' }, {}, {}, { title: 'quatrième' }],
      workingCount: 7,
      waiting: [{ kind: 'approval', text: 'Supprimer\n le dossier' }, { kind: 'inconnu', text: 'x' }],
      waitingCount: -3,
      agents: 2.5
    })

    expect(s!.working).toHaveLength(3)
    expect(s!.working[0]!.title).not.toMatch(/\u0007/)
    expect(s!.working[0]!.title.length).toBeLessThanOrEqual(80)
    expect(s!.workingCount).toBe(7)
    expect(s!.waiting).toEqual([{ kind: 'approval', text: 'Supprimer  le dossier' }])
    expect(s!.waitingCount).toBe(1)
    expect(s!.agents).toBe(0)
  })

  it('jamais le texte d’une demande de secret ou de mot de passe administrateur ; une forme inattendue est refusée', () => {
    expect(normalizeMiniSummary({ waiting: [{ kind: 'secret', text: 'jeton GITHUB' }, { kind: 'sudo', text: 'mdp' }] })!.waiting).toEqual([
      { kind: 'secret', text: '' },
      { kind: 'sudo', text: '' }
    ])
    expect(normalizeMiniSummary(null)).toBeNull()
    expect(normalizeMiniSummary([1, 2])).toBeNull()
  })

  it('bulle ronde : en bas à droite par défaut, jamais hors de l’écran, déplacement validé', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 }
    expect(MINI_SIZE).toEqual({ width: 88, height: 88 })
    expect(miniPosition(area)).toEqual({ x: 1920 - 88 - 16, y: 1040 - 88 - 16 })
    expect(clampToArea({ x: -50, y: 5000 }, area)).toEqual({ x: 0, y: 1040 - 88 })
    expect(clampToArea({ x: 300, y: 200 }, area)).toEqual({ x: 300, y: 200 })
    expect(normalizeDrag(3, -4)).toEqual({ dx: 3, dy: -4 })
    for (const bad of [[1.5, 0], [0, '4'], [9999, 0], [NaN, 0], [null, undefined]]) expect(normalizeDrag(bad[0], bad[1])).toBeNull()
  })

  it('le résumé porte l’état de la voix (écoute, réflexion, parole), `off` sinon', () => {
    expect(normalizeMiniSummary({ voice: 'listening' })!.voice).toBe('listening')
    expect(normalizeMiniSummary({ voice: 'speaking' })!.voice).toBe('speaking')
    expect(normalizeMiniSummary({ voice: 'hack' })!.voice).toBe('off')
    expect(normalizeMiniSummary({})!.voice).toBe('off')
  })

  it('page et preload à part du shell', () => {
    const dist = path.resolve('app', 'dist')
    expect(miniPaths(path.join(dist, 'electron'), null)).toEqual({ preloadPath: path.join(dist, 'electron', 'mini-preload.cjs'), page: { file: path.join(dist, 'renderer', 'mini.html') } })
    expect(miniPaths('/d/e', 'http://127.0.0.1:5180/').page).toEqual({ url: 'http://127.0.0.1:5180/mini.html' })
  })
})

describe('mini-fenêtre : la fenêtre', () => {
  function fakeWindow() {
    const handlers = new Map<string, (...a: unknown[]) => void>()
    const contents = new Map<string, (...a: unknown[]) => void>()
    let destroyed = false
    let openHandler: ((d: unknown) => unknown) | undefined
    const win = {
      on: (e: string, f: (...a: unknown[]) => void) => handlers.set(e, f),
      once: (e: string, f: (...a: unknown[]) => void) => handlers.set(e, f),
      setAlwaysOnTop: vi.fn(),
      showInactive: vi.fn(),
      blur: vi.fn(),
      loadFile: vi.fn(async () => undefined),
      loadURL: vi.fn(async () => undefined),
      destroy: () => void (destroyed = true),
      isDestroyed: () => destroyed,
      webContents: {
        on: (e: string, f: (...a: unknown[]) => void) => contents.set(e, f),
        setWindowOpenHandler: (f: (d: unknown) => unknown) => void (openHandler = f),
        send: vi.fn()
      }
    }

    return { win, handlers, contents, openHandler: () => openHandler }
  }

  it('fenêtre isolée (sandbox, sans Node), sans navigation ni nouvelle fenêtre ; un clic ramène Jarod ; éteindre la détruit', () => {
    const f = fakeWindow()
    const created: Electron.BrowserWindowConstructorOptions[] = []
    const openMain = vi.fn()
    const mini = new MiniWindow({
      createWindow: options => {
        created.push(options)

        return f.win as never
      },
      workArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      preloadPath: 'mini-preload.cjs',
      page: { file: 'mini.html' },
      openMain
    })

    mini.setEnabled(true)
    expect(created[0]!.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, preload: 'mini-preload.cjs' })
    expect(created[0]!.alwaysOnTop).toBe(true)
    expect(f.win.loadFile).toHaveBeenCalledWith('mini.html')
    const nav = { preventDefault: vi.fn() }

    f.contents.get('will-navigate')!(nav)
    expect(nav.preventDefault).toHaveBeenCalled()
    expect(f.openHandler()!({ url: 'https://ailleurs.example' })).toEqual({ action: 'deny' })
    expect(f.handlers.has('focus')).toBe(false) // le clic vient de la page (`click`), plus du focus
    expect(created[0]).toMatchObject({ focusable: false, movable: false, width: 88, height: 88, transparent: true, frame: false })
    mini.click()
    expect(openMain).toHaveBeenCalledTimes(1)

    const summary = normalizeMiniSummary({ waiting: [{ kind: 'approval', text: 'x' }], waitingCount: 1 })!

    mini.push(summary)
    expect(f.win.webContents.send).toHaveBeenCalledWith(IPC.miniPush, summary)
    mini.setEnabled(true) // déjà ouverte : aucune seconde fenêtre
    expect(created).toHaveLength(1)
    mini.setEnabled(false)
    expect(mini.window).toBeNull()
  })
})
