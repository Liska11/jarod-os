import fs from 'node:fs'
import path from 'node:path'
import type { BackendState } from '../../shared/ipc.ts'
import { DEFAULT_ENGINES_PREFS, ENGINE_CAPABILITY_TABLE, type EngineInfo, type EnginesPrefs, type EngineState, parseEnginesPrefs } from '../../shared/engines.ts'
import { writeFileAtomic } from '../atomic-write.ts'
import { type JarodCore, jarodDataDir } from '../backend/jarod-core.ts'
import type { BackendRuntime } from '../../shared/ipc.ts'
import type { DshInstall } from './dsh.ts'

/*
 * Ce que le cockpit sait de chaque moteur, sans en exécuter aucun : présence, version lisible sur le disque, état, capacités
 * vérifiées (ENGINE_CAPABILITY_TABLE) et limites. « Installé » n'est jamais « connecté » : seul l'état du gestionnaire
 * (cockpit) ou de la connexion ACP (DSH) le dit.
 */

export const ENGINES_FILE = 'engines.json'

/** Le dossier DSH de Jarod : ni `~/.dsh` (DSH Desktop / DSH NEXT), ni leurs bases. */
export const dshHome = (): string => path.join(jarodDataDir(), 'engines', 'dsh')
/** Le dossier Hermes de Jarod quand le choix « Hermes » vient de ses réglages : jamais celui de Hermes Desktop. */
export const jarodHermesHome = (): string => path.join(jarodDataDir(), 'engines', 'hermes-home')

/**
 * Au lancement, avant que les chemins du shell ne se résolvent : le moteur choisi dans les réglages, sauf si l'environnement en
 * impose un (JAROD_OS_BACKEND, HERMES_HOME, JAROD_OS_BACKEND_URL gardent la main). Rend ce qui a été appliqué, pour le journal.
 */
export function applyBackendChoice(configDir: string, env: NodeJS.ProcessEnv = process.env, readFile?: (file: string) => string): string | null {
  const prefs = readEnginesPrefs(configDir, readFile)

  if (prefs.backend === 'auto' || env.JAROD_OS_BACKEND?.trim() || env.JAROD_OS_BACKEND_URL?.trim()) {
    return null
  }

  env.JAROD_OS_BACKEND = prefs.backend

  if (prefs.backend === 'hermes' && !env.HERMES_HOME?.trim()) {
    env.HERMES_HOME = jarodHermesHome()
  }

  return prefs.backend === 'hermes' ? `hermes (HERMES_HOME ${env.HERMES_HOME})` : prefs.backend
}

export function readEnginesPrefs(configDir: string, readFile: (file: string) => string = file => fs.readFileSync(file, 'utf8')): EnginesPrefs {
  try {
    return parseEnginesPrefs(JSON.parse(readFile(path.join(configDir, ENGINES_FILE))))
  } catch {
    return { ...DEFAULT_ENGINES_PREFS }
  }
}

export function writeEnginesPrefs(configDir: string, prefs: EnginesPrefs): void {
  fs.mkdirSync(configDir, { recursive: true })
  writeFileAtomic(path.join(configDir, ENGINES_FILE), `${JSON.stringify(parseEnginesPrefs(prefs), null, 2)}\n`)
}

/** La date de publication que porte une installation Hermes (`hermes_cli/__init__.py`), sans lancer Hermes : son lancement peut synchroniser des dépendances. */
export function hermesReleaseDate(root: string, readFile: (file: string) => string = file => fs.readFileSync(file, 'utf8')): string | undefined {
  try {
    return /__release_date__\s*=\s*["']([^"']+)["']/.exec(readFile(path.join(root, 'hermes_cli', '__init__.py')))?.[1]
  } catch {
    return undefined
  }
}

/** L'état du moteur du cockpit d'après le gestionnaire : `ready` est le seul « connecté » qu'il puisse affirmer (le shell s'y relie ensuite). */
function cockpitState(backend: BackendState): EngineState {
  switch (backend.phase) {
    case 'ready':
      return 'connected'
    case 'failed':
      return 'failed'
    case 'stopped':
    case 'idle':
      return 'stopped'
    default:
      return 'starting'
  }
}

export interface EngineFacts {
  backend: BackendState
  core: JarodCore | null
  hermes: BackendRuntime | null
  dsh: DshInstall | null
  dshState: { state: EngineState; error?: string }
}

export function listEngines(facts: EngineFacts): EngineInfo[] {
  const activeKind = facts.backend.runtime?.kind
  const jarodActive = activeKind === 'jarod'
  const hermesActive = Boolean(activeKind && activeKind !== 'jarod')

  const jarod: EngineInfo = {
    id: 'jarod',
    protocol: 'jsonrpc-ws',
    installed: Boolean(facts.core),
    location: facts.core?.dir,
    state: jarodActive ? cockpitState(facts.backend) : facts.core ? 'detected' : 'absent',
    active: jarodActive,
    capabilities: ENGINE_CAPABILITY_TABLE.jarod,
    notes: ['engines.note.jarod.unavailable'],
    ...(jarodActive && facts.backend.error ? { error: facts.backend.error } : {})
  }

  const hermesRoot = facts.hermes?.root
  const hermes: EngineInfo = {
    id: 'hermes',
    protocol: 'jsonrpc-ws',
    installed: Boolean(facts.hermes),
    version: hermesRoot ? hermesReleaseDate(hermesRoot) : undefined,
    location: hermesRoot ?? facts.hermes?.command[0],
    state: hermesActive ? cockpitState(facts.backend) : facts.hermes ? 'detected' : 'absent',
    active: hermesActive,
    capabilities: ENGINE_CAPABILITY_TABLE.hermes,
    notes: ['engines.note.hermes.home', 'engines.note.hermes.token', 'engines.note.hermes.desktop'],
    ...(hermesActive && facts.backend.error ? { error: facts.backend.error } : {})
  }

  const dsh: EngineInfo = {
    id: 'dsh',
    protocol: 'acp-stdio',
    installed: Boolean(facts.dsh),
    version: facts.dsh?.version,
    location: facts.dsh?.bin,
    // Jamais lancé ou arrêté proprement : seulement détecté. Démarré, connecté ou en échec : ce que dit la connexion ACP.
    state: !facts.dsh ? 'absent' : ['starting', 'connected', 'failed'].includes(facts.dshState.state) ? facts.dshState.state : 'detected',
    active: false,
    capabilities: ENGINE_CAPABILITY_TABLE.dsh,
    notes: ['engines.note.dsh.streaming', 'engines.note.dsh.home', 'engines.note.dsh.apps'],
    ...(facts.dshState.error ? { error: facts.dshState.error } : {})
  }

  return [jarod, hermes, dsh]
}
