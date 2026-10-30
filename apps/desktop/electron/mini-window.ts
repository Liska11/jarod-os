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
 *  - 30/10 : c'est maintenant une BULLE ronde, déplaçable (`drag`) et cliquable (`click`) ; ces deux envois sont les seuls, vérifiés ici et
 *    dans main.ts. Un clic ouvre le chat compact : c'est là qu'on accorde ou refuse ;
 *  - le résumé vient de la fenêtre principale par un seul canal (`IPC.miniState`, gardé par le contrôle d'émetteur et accepté seulement de la
 *    fenêtre principale), puis est RE-VALIDÉ ici (`normalizeMiniSummary`) : des textes bornés, sans caractères de contrôle.
 */

const KINDS = new Set(['approval', 'clarify', 'sudo', 'secret'])
const VOICES = new Set<MiniSummary['voice']>(['off', 'listening', 'thinking', 'speaking'])
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
    agents: count(r.agents),
    voice: VOICES.has(r.voice as MiniSummary['voice']) ? (r.voice as MiniSummary['voice']) : 'off'
  }
}

/** La fenêtre de la bulle : un carré transparent un peu plus grand que la bulle (64 px) pour laisser place à son halo. */
export const MINI_SIZE = { width: 88, height: 88 }

interface Area {
  x: number
  y: number
  width: number
  height: number
}

/** Le coin haut-gauche de la bulle par défaut : en bas à droite de la zone de travail de l'écran principal. */
export function miniPosition(workArea: Area): { x: number; y: number } {
  return { x: Math.round(workArea.x + workArea.width - MINI_SIZE.width - 16), y: Math.round(workArea.y + workArea.height - MINI_SIZE.height - 16) }
}

/** Ramène un coin haut-gauche dans la zone de travail : la bulle ne peut pas être perdue hors de l'écran. */
export function clampToArea(pos: { x: number; y: number }, area: Area): { x: number; y: number } {
  const x = Math.min(Math.max(pos.x, area.x), area.x + area.width - MINI_SIZE.width)
  const y = Math.min(Math.max(pos.y, area.y), area.y + area.height - MINI_SIZE.height)

  return { x: Math.round(x), y: Math.round(y) }
}

/** Un déplacement reçu de la page : deux entiers raisonnables, sinon rien. */
export function normalizeDrag(dx: unknown, dy: unknown): { dx: number; dy: number } | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 400

  return ok(dx) && ok(dy) ? { dx, dy } : null
}

export interface MiniDeps {
  /** La fabrique de fenêtre d'Electron (injectée : le module se teste sans Electron). */
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindowType
  workArea: () => Area
  /** La zone de travail de l'écran où se trouve ce rectangle (la bulle peut être posée sur un autre écran). */
  workAreaAt?: (rect: Area) => Area
  /** Où la bulle avait été posée (absent : en bas à droite). */
  savedPosition?: () => { x: number; y: number } | null
  /** La bulle vient d'être lâchée ici : à garder pour la prochaine fois. */
  onMoved?: (pos: { x: number; y: number }) => void
  /** Le dossier de `dist/electron` (le preload) et l'adresse de la page : fichier empaqueté ou serveur de développement. */
  preloadPath: string
  page: { file: string } | { url: string }
  /** Un clic (sans déplacement) sur la bulle : ouvre ou referme le chat compact. */
  openMain: () => void
}

export class MiniWindow {
  private win: BrowserWindowType | null = null
  private last: MiniSummary = { working: [], workingCount: 0, waiting: [], waitingCount: 0, agents: 0, voice: 'off' }
  /** 30/10 : la bulle ne se montre que lorsque Jarod est réduit ou en chat compact (comme dans brahma), pas par-dessus le bureau ouvert. */
  private visible = false

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

  /** Montre ou cache la bulle sans la détruire (la fenêtre principale réduite, rouverte…). */
  setVisible(on: boolean): void {
    this.visible = on
    const win = this.window

    if (!win) {
      return
    }

    if (on && !win.isVisible()) {
      win.showInactive()
    } else if (!on && win.isVisible()) {
      win.hide()
    }
  }

  /** Un clic reçu de la page (sans déplacement). */
  click(): void {
    this.d.openMain()
  }

  /** Les limites actuelles de la bulle (pour placer le chat compact à côté). */
  get bounds(): Area | null {
    return this.window?.getBounds() ?? null
  }

  /** Déplace la bulle de (dx, dy) pixels, sans la laisser sortir de l'écran où elle se trouve. */
  dragBy(dx: number, dy: number): void {
    const win = this.window

    if (!win) {
      return
    }

    const now = win.getBounds()
    const area = this.d.workAreaAt?.(now) ?? this.d.workArea()
    const next = clampToArea({ x: now.x + dx, y: now.y + dy }, area)

    win.setBounds({ ...next, width: MINI_SIZE.width, height: MINI_SIZE.height })
  }

  /** Le geste est fini : la place est gardée. */
  dragEnd(): void {
    const b = this.bounds

    if (b) {
      this.d.onMoved?.({ x: b.x, y: b.y })
    }
  }

  /** Un nouveau résumé (déjà validé) : gardé, et poussé si la fenêtre est là. */
  push(summary: MiniSummary): void {
    this.last = summary
    this.window?.webContents.send(IPC.miniPush, summary)
  }

  private open(): void {
    const area = this.d.workArea()
    const saved = this.d.savedPosition?.() ?? null
    const { x, y } = clampToArea(saved ?? miniPosition(area), saved ? (this.d.workAreaAt?.({ ...saved, ...MINI_SIZE }) ?? area) : area)
    const win = this.d.createWindow({
      ...MINI_SIZE,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      // Un clic sur la bulle ne vole pas le focus à ce que l'utilisateur faisait.
      focusable: false,
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
    win.webContents.on('did-finish-load', () => win.webContents.send(IPC.miniPush, this.last))
    win.once('ready-to-show', () => {
      if (this.visible) {
        win.showInactive()
      }
    })
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
