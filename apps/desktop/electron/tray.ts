import { app, Menu, nativeImage, Tray } from 'electron'
import type { JarodOSPrefs } from '../shared/ipc.ts'
import { log } from './log.ts'

/*
 * The notification-area icon (A6 of the 2026-10-12 analysis): Jarod-OS stays one click away when its window is minimized or
 * behind others, and the menu offers what the window cannot when it is in trouble (safe mode). Windows only: macOS has the Dock
 * and Jarod-OS Linux is the session. Closing the window still quits; the icon is a way back, not a background mode.
 */

type Language = 'en' | 'fr'

const LABELS: Record<Language, { show: string; safe: string; normal: string; quit: string; mini: string }> = {
  en: { show: 'Show Jarod-OS', safe: 'Restart in safe mode', normal: 'Restart normally', quit: 'Quit Jarod-OS', mini: 'Mini window' },
  fr: { show: 'Afficher Jarod-OS', safe: 'Redémarrer en mode sans échec', normal: 'Redémarrer normalement', quit: 'Quitter Jarod-OS', mini: 'Mini-fenêtre' }
}

/** The menu's language: the one chosen in Settings, else the system's when it is French. */
export function trayLanguage(preference: JarodOSPrefs['language'], systemLocale: string): Language {
  if (preference === 'en' || preference === 'fr') {
    return preference
  }

  return systemLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

export function trayLabels(language: Language, safeMode: boolean): { show: string; restart: string; quit: string; mini: string } {
  const labels = LABELS[language]

  return { show: labels.show, restart: safeMode ? labels.normal : labels.safe, quit: labels.quit, mini: labels.mini }
}

export interface TrayActions {
  show: () => void
  relaunch: (safe: boolean) => void
  /** Lot C : la mini-fenêtre (en haut de l'écran), allumée ou éteinte depuis ce menu. */
  miniWindow?: { get: () => boolean; set: (on: boolean) => void }
}

export class ShellTray {
  private tray: Tray | null = null
  private language: Language = 'en'

  constructor(
    private readonly iconPath: string | undefined,
    private readonly safeMode: boolean,
    private readonly actions: TrayActions
  ) {}

  start(language: Language): void {
    if (process.platform !== 'win32' || this.tray) {
      return
    }

    try {
      const icon = this.iconPath ? nativeImage.createFromPath(this.iconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
      this.tray = new Tray(icon)
      this.tray.setToolTip('Jarod-OS')
      this.tray.on('click', () => this.actions.show())
      this.setLanguage(language)
    } catch (error) {
      log('tray', `no notification-area icon: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Redraws the menu in another language (the person changed it in Settings). */
  setLanguage(language: Language): void {
    this.language = language

    if (!this.tray) {
      return
    }

    const labels = trayLabels(language, this.safeMode)
    const mini = this.actions.miniWindow
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels.show, click: () => this.actions.show() },
        ...(mini ? [{ label: labels.mini, type: 'checkbox' as const, checked: mini.get(), click: (item: { checked: boolean }) => mini.set(item.checked) }] : []),
        { type: 'separator' },
        { label: labels.restart, click: () => this.actions.relaunch(!this.safeMode) },
        { label: labels.quit, click: () => app.quit() }
      ])
    )
  }

  /** Redessine le menu (une case a changé ailleurs, dans Réglages par exemple). */
  refresh(): void {
    this.setLanguage(this.language)
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
