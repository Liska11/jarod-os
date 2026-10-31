/*
 * The right-click menu (cut, copy, paste, select all, spelling, links, images): the template only, with no Electron import so it can be tested.
 * `context-menu.ts` pops it up. The standard items use Electron roles, whose labels the system localizes ("Copier", "Coller"…); the few custom
 * ones are labelled here in French or English.
 */

/** What the template needs from Electron's `context-menu` event parameters. */
export interface MenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  srcURL: string
  mediaType: string
  misspelledWord: string
  dictionarySuggestions: string[]
  x: number
  y: number
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

/** What the items do: wired to a WebContents by `context-menu.ts`, faked in the tests. */
export interface MenuActions {
  replaceMisspelling(word: string): void
  addToDictionary(word: string): void
  copyText(text: string): void
  openLink(url: string): void
  copyImageAt(x: number, y: number): void
}

export interface MenuItemTemplate {
  role?: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
  type?: 'separator'
  label?: string
  enabled?: boolean
  click?: () => void
}

const LABELS = {
  fr: { addWord: 'Ajouter au dictionnaire', copyLink: "Copier l'adresse du lien", openLink: 'Ouvrir le lien dans le navigateur', copyImage: "Copier l'image" },
  en: { addWord: 'Add to dictionary', copyLink: 'Copy link address', openLink: 'Open link in browser', copyImage: 'Copy image' }
} as const

const SEPARATOR: MenuItemTemplate = { type: 'separator' }

/** Only web addresses are handed to the system browser: never `file:`, `javascript:` or an application protocol. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)

    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** The menu for one right-click, or an empty list when there is nothing to offer (no menu is shown). */
export function contextMenuTemplate(params: MenuParams, actions: MenuActions, locale = 'en'): MenuItemTemplate[] {
  const l = LABELS[locale.toLowerCase().startsWith('fr') ? 'fr' : 'en']
  const groups: MenuItemTemplate[][] = []
  const flags = params.editFlags

  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord

    groups.push([
      ...params.dictionarySuggestions.slice(0, 5).map(suggestion => ({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) })),
      { label: l.addWord, click: () => actions.addToDictionary(word) }
    ])
  }

  if (params.linkURL) {
    const link = params.linkURL
    const items: MenuItemTemplate[] = [{ label: l.copyLink, click: () => actions.copyText(link) }]

    if (isWebUrl(link)) {
      items.unshift({ label: l.openLink, click: () => actions.openLink(link) })
    }

    groups.push(items)
  }

  if (params.mediaType === 'image' && params.srcURL) {
    groups.push([{ label: l.copyImage, click: () => actions.copyImageAt(params.x, params.y) }])
  }

  if (params.isEditable) {
    groups.push(
      [
        { role: 'undo', enabled: flags.canUndo },
        { role: 'redo', enabled: flags.canRedo }
      ],
      [
        { role: 'cut', enabled: flags.canCut },
        { role: 'copy', enabled: flags.canCopy },
        { role: 'paste', enabled: flags.canPaste }
      ],
      [{ role: 'selectAll', enabled: flags.canSelectAll }]
    )
  } else if (params.selectionText.trim()) {
    groups.push([{ role: 'copy', enabled: flags.canCopy }], [{ role: 'selectAll', enabled: flags.canSelectAll }])
  } else if (!params.linkURL && params.mediaType !== 'image') {
    // Nothing selected on plain page text: offer only what can still be done.
    if (flags.canSelectAll) {
      groups.push([{ role: 'selectAll', enabled: true }])
    }
  }

  return groups.filter(group => group.length > 0).flatMap((group, index) => (index === 0 ? group : [SEPARATOR, ...group]))
}
