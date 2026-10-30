import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MiniSummary } from '../shared/ipc.ts'

/*
 * Lot C : le preload de la mini-fenêtre. Il reçoit le résumé que le main lui pousse. 30/10 : la bulle ronde se déplace à la souris et se
 * clique, donc deux envois (et rien d'autre) : `drag(dx, dy)` — de petits entiers — et `click()` — sans rien. Le main vérifie l'émetteur,
 * borne les valeurs et ne s'en sert que pour bouger la bulle ou ouvrir le chat compact. Aucune connexion au moteur.
 */
contextBridge.exposeInMainWorld('jarodMini', {
  onSummary: (listener: (summary: MiniSummary) => void): void => {
    ipcRenderer.on(IPC.miniPush, (_event, summary: MiniSummary) => listener(summary))
  },
  drag: (dx: number, dy: number): void => ipcRenderer.send(IPC.miniDrag, Math.trunc(dx), Math.trunc(dy)),
  click: (): void => ipcRenderer.send(IPC.miniClick)
})
