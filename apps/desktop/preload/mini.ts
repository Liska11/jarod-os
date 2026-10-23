import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MiniSummary } from '../shared/ipc.ts'

/*
 * Lot C : le preload de la mini-fenêtre. Il ne fait que RECEVOIR le résumé que le main lui pousse : aucun envoi, aucun autre canal, aucune
 * connexion au moteur. Un clic sur la fenêtre est lu par le main (événement de focus), pas par un canal.
 */
contextBridge.exposeInMainWorld('jarodMini', {
  onSummary: (listener: (summary: MiniSummary) => void): void => {
    ipcRenderer.on(IPC.miniPush, (_event, summary: MiniSummary) => listener(summary))
  }
})
