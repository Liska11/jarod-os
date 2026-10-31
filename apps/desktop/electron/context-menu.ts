import { app, clipboard, Menu, shell } from 'electron'
import { contextMenuTemplate, isWebUrl, type MenuActions, type MenuParams } from './context-menu-template.ts'

/**
 * Right-click menu for every window and panel the app opens: cut / copy / paste / select all in text fields, copy on selected text, spelling
 * suggestions, link and image actions. Without it a right-click did nothing, so pasting needed the keyboard.
 */
export function installContextMenu(): void {
  app.on('web-contents-created', (_event, contents) => {
    // Pages loaded for the agent in the background and DevTools have no user to click on them.
    const type = contents.getType()

    if (type !== 'window' && type !== 'webview' && type !== 'browserView') {
      return
    }

    contents.on('context-menu', (_e, params) => {
      const actions: MenuActions = {
        replaceMisspelling: word => contents.replaceMisspelling(word),
        addToDictionary: word => contents.session.addWordToSpellCheckerDictionary(word),
        copyText: text => clipboard.writeText(text),
        openLink: url => {
          if (isWebUrl(url)) {
            void shell.openExternal(url)
          }
        },
        copyImageAt: (x, y) => contents.copyImageAt(x, y)
      }
      const template = contextMenuTemplate(params as unknown as MenuParams, actions, app.getLocale())

      if (template.length > 0) {
        Menu.buildFromTemplate(template).popup()
      }
    })
  })
}

