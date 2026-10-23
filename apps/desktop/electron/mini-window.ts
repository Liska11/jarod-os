import path from 'node:path'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import type { MiniSummary } from '../shared/ipc.ts'
import { IPC } from '../shared/ipc.ts'
import { log } from './log.ts'

/*
 * Lot C (2026-10-21) : la mini-fenêtre, inspirée de Coucou (Louis-CFM/coucou, MIT pour le code ; son nom, sa mascotte et ses sons ne sont
 * pas repris — et aucun code n'est copié, seulement l'idée) : un îlot en haut de l'écran qui dit ce que fait Jarod et ce qui attend une
 * réponse, même quand la fenêtre principale est cachée.
 *
 * Surface minimale, avant que BL-01 ne soit entièrement levé :
 *  - la mini-fenêtre charge sa PROPRE page statique (pas la page du shell) avec un preload qui ne fait que RECEVOIR le résumé : aucun canal
 *    du shell, aucune connexion au moteur ;
 *  - elle ne répond à rien : un clic dessus ramène la fenêtre principale (événement `focus` lu ici, aucun canal IPC) — c'est là qu'on
 *    accorde ou refuse ;
 *  - le résumé vient de la fenêtre principale par un seul canal (`IPC.miniState`, gardé par le contrôle d'émetteur et accepté seulement de la
 *    fenêtre principale), puis est RE-VALIDÉ ici (`normalizeMiniSummary`) : des textes bornés, sans caractères de contrôle.
 */

const KINDS = new Set(['approval', 'clarify', 'sudo', 'secret'])
// biome-ignore lint/suspicious/noControlCharactersInRegex: intended, control characters are stripped
const CONTROL = /[\u0000-\u001f\u007f]/g
const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').trim().slice(0, n) : '')
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, 999) : 0)

/** Le résumé tel que la mini-fenêtre peut l'afficher, quoi que la fenêtre principale ait envoyé ; null s'il n'a pas la forme attendue. */
export function normalizeMiniSummary(raw: unknown): MiniSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const r = raw as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 3) : [])
  const working = list(r.working)
    .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === 'object')
    .map(w => ({ title: clip(w.title, 80), status: clip(w.status, 80) }))
  const waiting = list(r.waiting)
    .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === 'object' && KINDS.has(String((w as Record<string, unknown>).kind)))
    .map(w => ({ kind: w.kind as MiniSummary['waiting'][number]['kind'], text: w.kind === 'secret' || w.kind === 'sudo' ? '' : clip(w.text, 100) }))

  return {
    working,
    workingCount: Math.max(count(r.workingCount), working.length),
    waiting,
    waitingCount: Math.max(count(r.waitingCount), waiting.length),
    agents: count(r.agents)
  }
}

export const MINI_SIZE = { width: 420, height: 76 }

/** Le coin haut-gauche de la mini-fenêtre : centrée en haut de la zone de travail de l'écran principal. */
export function miniPosition(workArea: { x: number; y: number; width: number }): { x: number; y: number } {
  return { x: Math.round(workArea.x + (workArea.width - MINI_SIZE.width) / 2), y: workArea.y + 8 }
}

export interface MiniDeps {
  /** La fabrique de fenêtre d'Electron (injectée : le module se teste sans Electron). */
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindowType
  workArea: () => { x: number; y: number; width: number }
  /** Le dossier de `dist/electron` (le preload) et l'adresse de la page : fichier empaqueté ou serveur de développement. */
  preloadPath: string
  page: { file: string } | { url: string }
  /** Ramener la fenêtre principale (clic sur la mini-fenêtre). */
  openMain: () => void
}

export class MiniWindow {
  private win: BrowserWindowType | null = null
  private last: MiniSummary = { working: [], workingCount: 0, waiting: [], waitingCount: 0, agents: 0 }

  constructor(private readonly d: MiniDeps) {}

  get window(): BrowserWindowType | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  setEnabled(on: boolean): void {
    if (on && !this.window) {
      this.open()
    } else if (!on && this.window) {
      this.win!.destroy()
      this.win = null
    }
  }

  /** Un nouveau résumé (déjà validé) : gardé, et poussé si la fenêtre est là. */
  push(summary: MiniSummary): void {
    this.last = summary
    this.window?.webContents.send(IPC.miniPush, summary)
  }

  private open(): void {
    const { x, y } = miniPosition(this.d.workArea())
    const win = this.d.createWindow({
      ...MINI_SIZE,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Jarod — mini',
      webPreferences: { preload: this.d.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false }
    })

    win.setAlwaysOnTop(true, 'floating')
    // Aucune navigation, aucune nouvelle fenêtre : la page ne fait qu'afficher.
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Un clic donne le focus à la mini-fenêtre : on le rend à la fenêtre principale.
    win.on('focus', () => {
      win.blur()
      this.d.openMain()
    })
    win.webContents.on('did-finish-load', () => win.webContents.send(IPC.miniPush, this.last))
    win.once('ready-to-show', () => win.showInactive())
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
      }
    })

    const page = this.d.page

    void ('file' in page ? win.loadFile(page.file) : win.loadURL(page.url)).catch(error => log('mini', `page non chargée : ${String(error)}`))
    this.win = win
  }
}

/** Où sont le preload et la page, selon que l'application est empaquetée ou servie par Vite. */
export function miniPaths(distElectronDir: string, devServer: string | null): { preloadPath: string; page: { file: string } | { url: string } } {
  return {
    preloadPath: path.join(distElectronDir, 'mini-preload.cjs'),
    // `public/mini.html` : copié tel quel par Vite dans dist/renderer (aucun code du shell dans cette page).
    page: devServer ? { url: `${devServer.replace(/\/$/, '')}/mini.html` } : { file: path.join(distElectronDir, '..', 'renderer', 'mini.html') }
  }
}
