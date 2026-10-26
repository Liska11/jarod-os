import type { CryptoKeyPair } from '@jarod-protocol'
import type { JarodChannel, PushedEvent } from '../lib/channel.ts'
import type { StoredMessage } from '../lib/chat-model.ts'
import type { PairedPc } from '../lib/pairing-store.ts'

/**
 * A pretend PC, for looking at the screens without one (`VITE_DEMO=1`, never in a release build):
 * canned conversations, news and one approval. Nothing here touches the protocol or the crypto.
 */
export const DEMO = import.meta.env.VITE_DEMO === '1'

export const demoPc: PairedPc = {
  v: 1,
  hostId: 'demo',
  hostKey: '',
  name: 'PC-de-Demo',
  urls: ['http://192.168.1.20:10492', 'http://100.101.102.103:10492'],
  lastUrl: 'http://192.168.1.20:10492',
  wrappedKey: '',
  deviceName: 'Nord 4',
  pairedAt: Date.now() - 3 * 86_400_000,
  // Off: the demo must never start the real watch service with a made-up token.
  watch: false
}

export const demoKeys = {} as CryptoKeyPair

const HOUR = 3_600_000
const sessions = [
  { id: 's1', title: 'Ranger le dossier Téléchargements', updatedAt: Date.now() - 4 * 60_000, running: true },
  { id: 's2', title: 'Script de sauvegarde nocturne', updatedAt: Date.now() - 2 * HOUR },
  { id: 's3', title: 'Résumé du rapport trimestriel', updatedAt: Date.now() - 26 * HOUR },
  { id: 's4', title: 'Rappels de la semaine', updatedAt: Date.now() - 3 * 24 * HOUR }
]

const history: StoredMessage[] = [
  { id: 'm1', role: 'user', content: 'Peux-tu écrire un petit script qui sauvegarde mes documents chaque nuit ?' },
  { id: 'm2', role: 'tool', toolName: 'list_dir', content: '' },
  { id: 'm3', role: 'tool', toolName: 'read_file', content: '' },
  { id: 'm4', role: 'tool', toolName: 'write_file', content: '' },
  {
    id: 'm5',
    role: 'assistant',
    content: [
      'Voilà, j’ai créé **`backup.ps1`** dans ton dossier Scripts. Il copie `Documents` vers le disque `D:` et garde les *7 dernières* sauvegardes.',
      '',
      '```powershell',
      '$source = "$env:USERPROFILE\\Documents"',
      '$cible  = "D:\\Sauvegardes\\$(Get-Date -Format yyyy-MM-dd)"',
      'robocopy $source $cible /MIR /R:1 /W:1',
      'Get-ChildItem D:\\Sauvegardes | Sort-Object Name -Descending | Select-Object -Skip 7 | Remove-Item -Recurse',
      '```',
      '',
      '| Étape | Quand |',
      '| --- | --- |',
      '| Copie | chaque nuit à 02:00 |',
      '| Nettoyage | juste après la copie |',
      '',
      '- Je peux aussi la planifier avec le Planificateur de tâches.',
      '- Dis-moi si tu veux exclure un dossier.'
    ].join('\n')
  },
  { id: 'm6', role: 'user', content: 'Oui, planifie-la.' }
]

const news = [
  { id: 'n1', kind: 'success', topic: 'task', title: 'Sauvegarde terminée', body: '2 418 fichiers copiés vers D:\\Sauvegardes (3,2 Go).', createdAt: Date.now() - 20 * 60_000 },
  { id: 'n2', kind: 'info', topic: 'reminder', title: 'Rappel : appeler le comptable', body: 'Demandé hier soir.', createdAt: Date.now() - 3 * HOUR },
  { id: 'n3', kind: 'warning', topic: 'alert', title: 'Espace disque faible sur C:', body: 'Il reste 4 % : pensez à vider les Téléchargements.', createdAt: Date.now() - 9 * HOUR },
  { id: 'n4', kind: 'info', topic: 'other', title: 'Nouvelle skill apprise', body: 'Jarod sait maintenant renommer des fichiers par lot.', createdAt: Date.now() - 30 * HOUR }
]

/** One approval, shown with `#approval` in the address (the countdown starts when the app opens). */
const approval = () => ({
  id: 'a1',
  sessionId: 's1',
  call: { name: 'delete_file', args: { path: 'C:\\Users\\demo\\Downloads\\ancien-installeur.exe', recursive: false } },
  description: 'Supprimer un ancien installeur du dossier Téléchargements.',
  expiresAt: Date.now() + 4 * 60_000 + 7_000,
  origin: 'background'
})

export function demoChannel(emit: (e: PushedEvent) => void): JarodChannel {
  const agent = (data: Record<string, unknown>) => emit({ event: 'agent', data })
  const reply = (sessionId: string) => {
    const streamId = `d${Date.now()}`
    const parts = ['D’accord, ', 'je m’en occupe ', 'tout de suite.']
    setTimeout(() => agent({ type: 'stream-start', sessionId, streamId }), 200)
    setTimeout(() => agent({ type: 'tool-start', sessionId, call: { id: `c${streamId}`, name: 'schedule_task', args: { cron: '0 2 * * *', script: 'backup.ps1' } } }), 700)
    parts.forEach((text, i) => setTimeout(() => agent({ type: 'delta', sessionId, streamId, text }), 1200 + i * 350))
    setTimeout(() => {
      agent({ type: 'message', sessionId, streamId, message: { id: `r${streamId}`, role: 'assistant', content: parts.join('') } })
      agent({ type: 'done', sessionId })
    }, 2400)
  }
  if (location.hash.includes('approval')) setTimeout(() => emit({ event: 'approval', data: approval() }), 1500)

  const methods: Record<string, (p?: Record<string, unknown>) => unknown> = {
    'sessions.list': () => sessions,
    'sessions.create': () => ({ id: 's-new', title: 'Nouvelle conversation' }),
    'sessions.rename': () => true,
    'sessions.delete': () => true,
    'messages.list': () => history,
    'approvals.pending': () => [],
    'notifications.list': () => news,
    'wake.register': () => ({ token: 'demo', seq: 0 }),
    'approval.resolve': () => true,
    'device.leave': () => true,
    'chat.stop': () => true,
    'chat.send': p => {
      reply(String(p?.sessionId ?? 's1'))
      return { kind: 'run' }
    }
  }
  const fake = {
    base: demoPc.lastUrl,
    isOpen: true,
    close: () => {},
    rpc: async (method: string, params?: Record<string, unknown>) => {
      await new Promise(r => setTimeout(r, 30))
      const handler = methods[method]
      if (!handler) throw new Error(`Démo : ${method} non simulé`)
      return handler(params)
    }
  }
  return fake as unknown as JarodChannel
}
