import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/*
 * V-07 — les téléchargements des applications web du shell qui en ont la permission (`downloads`, shared/web-sites.ts : le navigateur) passent
 * par la quarantaine, comme les entrées externes du noyau (plugin-quarantine, `admitBytes`) :
 *  - le fichier est d'abord écrit dans un dossier de TRANSIT sous les données du shell, jamais directement chez la personne ;
 *  - une fois complet, il est analysé (Microsoft Defender, en arrière-plan : le processus principal n'attend pas) ;
 *  - propre : copié dans Téléchargements sous un nom libre (rien n'est écrasé), empreinte revérifiée ; infecté, non analysable ou interrompu :
 *    supprimé, et la personne est prévenue de la raison. Le transit est vidé dans tous les cas.
 * Un fichier non analysé n'arrive jamais : sans Defender, les téléchargements sont refusés, et la notification le dit.
 */

export type ScanVerdict = { verdict: 'clean' | 'infected' | 'unavailable'; scanner: string; detail?: string }

/** Ce que le module lit d'un `DownloadItem` d'Electron. */
export interface DownloadItemLike {
  getFilename(): string
  getURL(): string
  setSavePath(file: string): void
  getReceivedBytes(): number
  getTotalBytes(): number
  cancel(): void
  on(event: 'updated', listener: (event: unknown, state: 'progressing' | 'interrupted') => void): unknown
  once(event: 'done', listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void): unknown
}

export interface DownloadQuarantineDeps {
  /** Où les téléchargements attendent leur analyse. */
  stagingRoot: string
  /** Où arrive un fichier admis (Téléchargements de la personne). */
  downloadsDir: () => string
  scan: (file: string) => Promise<ScanVerdict>
  notify: (title: string, body: string) => void
  /** Une ligne par décision : empreinte, taille, verdict, jamais le contenu. */
  journal?: (entry: DownloadDecision) => void
  log?: (line: string) => void
}

export interface DownloadDecision {
  at: string
  site: string
  host: string
  name: string
  outcome: 'admitted' | 'refused' | 'cancelled'
  sha256?: string
  size?: number
  scanner?: string
  verdict?: string
  reason?: string
}

/** Le dernier segment du nom proposé par le site, sans caractère qui changerait de dossier ou que Windows refuse. */
export function safeDownloadName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: les caractères de contrôle sont précisément ce que Windows refuse dans un nom
  const base = path.win32.basename(path.posix.basename(name)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 150)

  return !base || base === '.' || base === '..' ? 'telechargement' : base
}

/** `nom.ext`, sinon `nom (1).ext`, `nom (2).ext`… : jamais un fichier existant. */
export function freePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)

  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`)

    if (!fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error('aucun nom libre dans le dossier des téléchargements')
}

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Prend en charge un téléchargement : le dirige vers le transit (ce qui retire aussi la boîte d'enregistrement d'Electron), puis décide à la fin.
 * La promesse rendue se résout avec la décision (les tests l'attendent ; l'application ne l'attend pas).
 */
export function quarantineDownload(item: DownloadItemLike, site: string, deps: DownloadQuarantineDeps): Promise<DownloadDecision> {
  fs.mkdirSync(deps.stagingRoot, { recursive: true })
  const staging = fs.mkdtempSync(path.join(deps.stagingRoot, 'dl-'))
  const name = safeDownloadName(item.getFilename())
  const staged = path.join(staging, name)
  const base = { site, host: hostOf(item.getURL()), name }

  item.setSavePath(staged)

  // Chromium fait déjà passer chaque fichier reçu par le gestionnaire de pièces jointes de Windows (donc Defender) : une menace l'interrompt
  // APRÈS réception complète, et `done` ne vient pas. Interrompu une fois tout reçu = bloqué à la réception ; interrompu avant = coupure.
  // Dans les deux cas l'élément est annulé (Jarod ne reprend pas un téléchargement), ce qui termine le transfert et libère le transit.
  let received = 0
  let blockedOnReceipt = false

  item.on('updated', (_event, state) => {
    if (state === 'progressing') {
      received = item.getReceivedBytes()
    } else {
      blockedOnReceipt = item.getTotalBytes() > 0 && received >= item.getTotalBytes()
      item.cancel()
    }
  })

  return new Promise<DownloadDecision>(resolve => {
    item.once('done', (_event, state) => {
      void (async (): Promise<DownloadDecision> => {
        if (state !== 'completed' && blockedOnReceipt) {
          deps.notify('Téléchargement refusé', `${name} — bloqué par l'analyse de Windows dès la réception.`)

          return { at: new Date().toISOString(), ...base, outcome: 'refused', verdict: 'infected', scanner: 'windows', reason: "bloqué par l'analyse de Windows dès la réception" }
        }

        if (state !== 'completed') {
          return { at: new Date().toISOString(), ...base, outcome: 'cancelled', reason: state }
        }

        // Terminé mais absent : la protection en temps réel l'a retiré dès l'écriture. C'est un refus, et la personne doit le savoir.
        if (!fs.existsSync(staged)) {
          deps.notify('Téléchargement refusé', `${name} — retiré par l'antivirus avant même l'analyse.`)

          return { at: new Date().toISOString(), ...base, outcome: 'refused', reason: "retiré par l'antivirus avant l'analyse" }
        }

        const size = fs.statSync(staged).size
        const digest = sha256(staged)
        const result = await deps.scan(staged)

        if (result.verdict !== 'clean') {
          const reason = result.verdict === 'infected' ? `menace détectée par ${result.scanner}` : `aucune analyse possible (${result.detail ?? `${result.scanner} indisponible`}) : un fichier non analysé n'arrive pas`
          deps.notify('Téléchargement refusé', `${name} — ${reason}. Le fichier a été supprimé.`)

          return { at: new Date().toISOString(), ...base, outcome: 'refused', sha256: digest, size, scanner: result.scanner, verdict: result.verdict, reason }
        }

        // L'empreinte revérifiée APRÈS l'analyse : un contenu changé entre-temps n'est pas celui qui a été jugé.
        if (sha256(staged) !== digest) {
          deps.notify('Téléchargement refusé', `${name} — le contenu a changé pendant l'analyse. Le fichier a été supprimé.`)

          return { at: new Date().toISOString(), ...base, outcome: 'refused', sha256: digest, size, scanner: result.scanner, verdict: 'tampered', reason: "le contenu a changé pendant l'analyse" }
        }

        const dir = deps.downloadsDir()
        fs.mkdirSync(dir, { recursive: true })
        const target = freePath(dir, name)
        fs.copyFileSync(staged, target, fs.constants.COPYFILE_EXCL)

        if (sha256(target) !== digest) {
          fs.rmSync(target, { force: true })
          deps.notify('Téléchargement refusé', `${name} — la copie ne correspond pas au fichier analysé. Rien n'a été gardé.`)

          return { at: new Date().toISOString(), ...base, outcome: 'refused', sha256: digest, size, scanner: result.scanner, verdict: 'clean', reason: 'copie différente du fichier analysé' }
        }

        deps.notify('Téléchargement analysé', `${path.basename(target)} est dans Téléchargements (analysé par ${result.scanner}).`)

        return { at: new Date().toISOString(), ...base, outcome: 'admitted', sha256: digest, size, scanner: result.scanner, verdict: 'clean' }
      })()
        .catch((error: unknown): DownloadDecision => {
          deps.notify('Téléchargement refusé', `${name} — ${String((error as Error)?.message ?? error)}.`)

          return { at: new Date().toISOString(), ...base, outcome: 'refused', reason: String((error as Error)?.message ?? error) }
        })
        .then(decision => {
          fs.rmSync(staging, { recursive: true, force: true })
          deps.journal?.(decision)
          deps.log?.(`download ${decision.outcome}: ${site} ${decision.host} ${decision.name}${decision.reason ? ` (${decision.reason})` : ''}`)
          resolve(decision)
        })
    })
  })
}

/** `MpCmdRun.exe`, le même analyseur que la quarantaine du noyau ; null s'il n'est pas là. */
export function defenderBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []

  if (env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'Windows Defender', 'MpCmdRun.exe'))
  }

  const platform = env.ProgramData ? path.join(env.ProgramData, 'Microsoft', 'Windows Defender', 'Platform') : null

  if (platform && fs.existsSync(platform)) {
    for (const version of fs.readdirSync(platform).sort().reverse()) {
      candidates.push(path.join(platform, version, 'MpCmdRun.exe'))
    }
  }

  return candidates.find(candidate => fs.existsSync(candidate)) ?? null
}

/**
 * L'analyse Defender, sans bloquer : `-DisableRemediation` (lecture seule). Code 0 = rien trouvé, 2 = menace ; tout autre code veut dire que
 * l'analyse n'a pas eu lieu — ce n'est PAS un « propre ».
 */
export function defenderScan(file: string, bin: string | null = process.platform === 'win32' ? defenderBinary() : null): Promise<ScanVerdict> {
  if (!bin) {
    return Promise.resolve({ verdict: 'unavailable', scanner: 'defender', detail: 'Microsoft Defender introuvable' })
  }

  return new Promise(resolve => {
    execFile(bin, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'], { windowsHide: true, timeout: 15 * 60_000 }, error => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : null) : 0

      if (code === 0) {
        resolve({ verdict: 'clean', scanner: 'defender' })
      } else if (code === 2) {
        resolve({ verdict: 'infected', scanner: 'defender' })
      } else {
        resolve({ verdict: 'unavailable', scanner: 'defender', detail: `Defender n'a pas analysé (code ${code ?? 'inconnu'})` })
      }
    })
  })
}
