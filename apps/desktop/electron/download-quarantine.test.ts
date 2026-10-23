import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defenderBinary, defenderScan, type DownloadDecision, type DownloadItemLike, freePath, quarantineDownload, safeDownloadName, type ScanVerdict } from './download-quarantine.ts'

const made: string[] = []
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-dlq-'))
  made.push(d)

  return d
}

afterEach(() => {
  for (const d of made.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** Un téléchargement d'Electron simulé : écrit `content` là où on l'a dirigé, puis se termine dans `state`. */
function item(name: string, content: string | null, state: 'completed' | 'cancelled' | 'interrupted' = 'completed'): DownloadItemLike & { savedTo: string | null } {
  let done: ((event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void) | null = null
  const fake = {
    savedTo: null as string | null,
    getFilename: () => name,
    getURL: () => 'https://files.example/x',
    getReceivedBytes: () => 0,
    getTotalBytes: () => 0,
    cancel: () => {},
    on: () => fake,
    setSavePath(file: string) {
      fake.savedTo = file
      setTimeout(() => {
        if (content !== null) {
          fs.writeFileSync(file, content)
        }

        done?.({}, state)
      }, 5)
    },
    once(_event: 'done', listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void) {
      done = listener
    }
  }

  return fake
}

/**
 * Comme Chromium quand l'analyse de Windows bloque à la réception (mesuré sur l'application réelle) : progression jusqu'à `total` octets reçus
 * sur `received`, puis « interrupted » dans `updated`, et `done` seulement après `cancel()`.
 */
function interruptedItem(name: string, total: number, received: number): DownloadItemLike & { cancelled: boolean } {
  let done: ((event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void) | null = null
  let updated: ((event: unknown, state: 'progressing' | 'interrupted') => void) | null = null
  let bytes = 0
  const fake = {
    cancelled: false,
    getFilename: () => name,
    getURL: () => 'https://files.example/x',
    getReceivedBytes: () => bytes,
    getTotalBytes: () => total,
    cancel() {
      fake.cancelled = true
      setTimeout(() => done?.({}, 'cancelled'), 1)
    },
    on(_event: 'updated', listener: (event: unknown, state: 'progressing' | 'interrupted') => void) {
      updated = listener

      return fake
    },
    setSavePath() {
      setTimeout(() => {
        bytes = received
        updated?.({}, 'progressing')
        bytes = 0
        updated?.({}, 'interrupted')
      }, 5)
    },
    once(_event: 'done', listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void) {
      done = listener
    }
  }

  return fake
}

function rig(verdict: ScanVerdict['verdict']) {
  const root = dir()
  const downloads = path.join(root, 'Téléchargements')
  const notes: string[] = []
  const journal: DownloadDecision[] = []
  const scanned: string[] = []

  return {
    root,
    downloads,
    notes,
    journal,
    scanned,
    deps: {
      stagingRoot: path.join(root, 'quarantine', 'downloads'),
      downloadsDir: () => downloads,
      scan: async (file: string): Promise<ScanVerdict> => {
        scanned.push(file)

        return { verdict, scanner: 'stub' }
      },
      notify: (title: string, body: string) => notes.push(`${title} | ${body}`),
      journal: (entry: DownloadDecision) => journal.push(entry)
    }
  }
}

const staged = (root: string) => fs.readdirSync(path.join(root, 'quarantine', 'downloads'))

describe('V-07 — téléchargements des applications web du shell', () => {
  it('propre : analysé dans le transit, puis copié dans Téléchargements ; le transit est vidé', async () => {
    const r = rig('clean')
    const download = item('rapport.pdf', 'contenu')
    const decision = await quarantineDownload(download, 'browser', r.deps)

    expect(download.savedTo).toContain(path.join('quarantine', 'downloads'))
    expect(r.scanned).toEqual([download.savedTo])
    expect(decision).toMatchObject({ outcome: 'admitted', site: 'browser', host: 'files.example', name: 'rapport.pdf', verdict: 'clean', size: 7 })
    expect(fs.readFileSync(path.join(r.downloads, 'rapport.pdf'), 'utf8')).toBe('contenu')
    expect(staged(r.root)).toEqual([])
    expect(r.notes).toEqual([expect.stringMatching(/^Téléchargement analysé \| rapport\.pdf est dans Téléchargements/)])
    expect(r.journal).toEqual([decision])
  })

  it('infecté ou non analysable : rien n’arrive dans Téléchargements, la personne lit pourquoi', async () => {
    const infected = rig('infected')
    expect(await quarantineDownload(item('setup.exe', 'x'), 'browser', infected.deps)).toMatchObject({ outcome: 'refused', verdict: 'infected' })
    expect(fs.existsSync(infected.downloads)).toBe(false)
    expect(staged(infected.root)).toEqual([])
    expect(infected.notes[0]).toMatch(/Téléchargement refusé \| setup\.exe — menace détectée par stub/)

    const unscanned = rig('unavailable')
    expect(await quarantineDownload(item('doc.pdf', 'y'), 'browser', unscanned.deps)).toMatchObject({ outcome: 'refused', verdict: 'unavailable' })
    expect(unscanned.notes[0]).toMatch(/un fichier non analysé n’arrive pas|un fichier non analysé n'arrive pas/)
  })

  it('interrompu ou annulé : ni analyse ni notification, le transit est vidé', async () => {
    const r = rig('clean')
    expect(await quarantineDownload(item('gros.iso', 'partiel', 'interrupted'), 'browser', r.deps)).toMatchObject({ outcome: 'cancelled', reason: 'interrupted' })
    expect(await quarantineDownload(item('gros.iso', null, 'cancelled'), 'browser', r.deps)).toMatchObject({ outcome: 'cancelled' })
    expect(r.scanned).toEqual([])
    expect(r.notes).toEqual([])
    expect(staged(r.root)).toEqual([])
  })

  it('bloqué par Windows une fois tout reçu (Chromium interrompt, `done` ne vient pas) : annulé par Jarod, compté comme un refus et dit', async () => {
    const r = rig('clean')
    const blocked = interruptedItem('eicar.txt', 68, 68)
    expect(await quarantineDownload(blocked, 'browser', r.deps)).toMatchObject({ outcome: 'refused', scanner: 'windows', reason: expect.stringMatching(/dès la réception/) })
    expect(blocked.cancelled).toBe(true)
    expect(r.notes[0]).toMatch(/^Téléchargement refusé \| eicar\.txt — bloqué par l'analyse de Windows/)
    expect(staged(r.root)).toEqual([])

    // Interrompu en cours de route (réseau coupé) : une simple annulation, sans alarme.
    const cut = interruptedItem('gros.iso', 1000, 10)
    expect(await quarantineDownload(cut, 'browser', r.deps)).toMatchObject({ outcome: 'cancelled' })
    expect(r.notes).toHaveLength(1)
  })

  it('terminé mais retiré par la protection en temps réel avant l’analyse : un refus, dit à la personne', async () => {
    const r = rig('clean')
    expect(await quarantineDownload(item('menace.exe', null, 'completed'), 'browser', r.deps)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/antivirus/) })
    expect(r.notes[0]).toMatch(/^Téléchargement refusé \| menace\.exe — retiré par l'antivirus/)
    expect(fs.existsSync(r.downloads)).toBe(false)
  })

  it('jamais d’écrasement : un deuxième « rapport.pdf » devient « rapport (1).pdf »', async () => {
    const r = rig('clean')
    await quarantineDownload(item('rapport.pdf', 'un'), 'browser', r.deps)
    await quarantineDownload(item('rapport.pdf', 'deux'), 'browser', r.deps)

    expect(fs.readFileSync(path.join(r.downloads, 'rapport.pdf'), 'utf8')).toBe('un')
    expect(fs.readFileSync(path.join(r.downloads, 'rapport (1).pdf'), 'utf8')).toBe('deux')
    expect(freePath(r.downloads, 'neuf.txt')).toBe(path.join(r.downloads, 'neuf.txt'))
  })

  it('le nom proposé par le site ne choisit jamais le dossier', () => {
    expect(safeDownloadName('../../Windows/evil.dll')).toBe('evil.dll')
    expect(safeDownloadName('C:\\Users\\x\\a.txt')).toBe('a.txt')
    // « a: » est lu comme une lettre de lecteur et retiré ; les caractères que Windows refuse deviennent « _ ».
    expect(safeDownloadName('a:b*c?.txt')).toBe('b_c_.txt')
    expect(safeDownloadName('note|v2<final>.txt')).toBe('note_v2_final_.txt')
    expect(safeDownloadName('..')).toBe('telechargement')
    expect(safeDownloadName('')).toBe('telechargement')
  })

  it('sans Defender : « indisponible », jamais « propre »', async () => {
    expect(await defenderScan('x', null)).toMatchObject({ verdict: 'unavailable', scanner: 'defender' })
  })

  const withDefender = process.platform === 'win32' && defenderBinary() ? it : it.skip

  // Le fichier de test EICAR (inoffensif, reconnu par tout antivirus), assemblé à l'exécution : jamais écrit dans le dépôt.
  withDefender('Defender réel, sans bloquer : un texte ordinaire est propre, le fichier de test EICAR est une menace', async () => {
    const d = dir()
    const ok = path.join(d, 'ok.txt')
    const bad = path.join(d, 'eicar.txt')
    fs.writeFileSync(ok, 'un texte ordinaire')
    fs.writeFileSync(bad, ['X5O!P%@AP[4', String.fromCharCode(92), 'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''))

    expect(await defenderScan(ok)).toEqual({ verdict: 'clean', scanner: 'defender' })
    expect(await defenderScan(bad)).toEqual({ verdict: 'infected', scanner: 'defender' })
  }, 120_000)
})
