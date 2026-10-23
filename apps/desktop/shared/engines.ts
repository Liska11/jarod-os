/*
 * Les moteurs que le cockpit sait conduire (docs/MULTI-RUNTIME-FAISABILITE.md) : le noyau Jarod, Hermes, DeepSeek Harness (DSH).
 *
 * Deux places différentes :
 *  - le moteur DU COCKPIT (chat principal, missions…) : Jarod ou Hermes, l'un ou l'autre, choisi au lancement (`backend`) ;
 *  - DSH, conduit à côté par ACP (Agent Client Protocol, stdio) : ses sessions sont les siennes, jamais prises au chat principal.
 * Une session garde le moteur qui l'a créée ; rien ne la fait passer d'un moteur à l'autre.
 */

export type EngineId = 'jarod' | 'hermes' | 'dsh'

/** Installé (sur le disque) → détecté (Jarod le trouve) → démarré → connecté (protocole ouvert). `failed` porte une raison. */
export type EngineState = 'absent' | 'detected' | 'starting' | 'connected' | 'stopped' | 'failed'

export const ENGINE_CAPABILITIES = ['sessions', 'streaming', 'tools', 'approvals', 'cancel', 'resume', 'memory', 'studio', 'usage'] as const
export type EngineCapability = (typeof ENGINE_CAPABILITIES)[number]

/** `partial` : la fonction existe avec une limite écrite dans `notes` (DSH : réponses par message entier, pas au fil des jetons). */
export type CapabilityLevel = 'available' | 'partial' | 'absent'

export interface EngineInfo {
  id: EngineId
  /** Protocole par lequel Jarod lui parle. */
  protocol: string
  installed: boolean
  /** Ce qu'on sait de la version sans exécuter le moteur. */
  version?: string
  /** Où il a été trouvé (dossier ou fichier). */
  location?: string
  state: EngineState
  /** Moteur du cockpit en ce moment (chat principal). */
  active: boolean
  capabilities: Record<EngineCapability, CapabilityLevel>
  /** Limites et remarques vérifiées, en clés de message ; jamais une capacité supposée. */
  notes: string[]
  error?: string
}

/** Le moteur du cockpit : `auto` garde la règle historique (le noyau Jarod quand la build en a un, sinon Hermes). */
export type CockpitBackendChoice = 'auto' | 'jarod' | 'hermes'

/**
 * Ce que Jarod répond à une demande d'accord d'un moteur conduit à côté (DSH) :
 * `ask` la présente (une seule fois, dans Jarod) ; `deny` la refuse sans demander ; `allow` l'accepte pour cette fois, sans demander.
 * La barrière du moteur reste en place dans tous les cas : Jarod ne fait que répondre à sa question.
 */
export type EnginePermissionPolicy = 'ask' | 'deny' | 'allow'

export interface EnginesPrefs {
  version: 1
  backend: CockpitBackendChoice
  dshPermission: EnginePermissionPolicy
}

export const DEFAULT_ENGINES_PREFS: EnginesPrefs = {
  version: 1,
  backend: 'auto',
  dshPermission: 'ask'
}

export function parseEnginesPrefs(raw: unknown): EnginesPrefs {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof EnginesPrefs, unknown>>
  const backend = value.backend === 'jarod' || value.backend === 'hermes' ? value.backend : 'auto'
  const dshPermission = value.dshPermission === 'deny' || value.dshPermission === 'allow' ? value.dshPermission : 'ask'

  return { version: 1, backend, dshPermission }
}

/**
 * Capacités vérifiées le 2026-10-22/23 (bancs `scripts/probes/`), pas déclarées par les moteurs.
 * Le noyau Jarod : ce que sert sa passerelle (`jarod-core/packages/cli/src/gateway/unavailable.ts` dit ce qu'elle ne sert pas).
 */
export const ENGINE_CAPABILITY_TABLE: Record<EngineId, Record<EngineCapability, CapabilityLevel>> = {
  jarod: {
    sessions: 'available',
    streaming: 'available',
    tools: 'available',
    approvals: 'available',
    cancel: 'available',
    resume: 'available',
    memory: 'available',
    studio: 'absent',
    usage: 'partial'
  },
  hermes: {
    sessions: 'available',
    streaming: 'available',
    tools: 'available',
    approvals: 'available',
    cancel: 'available',
    resume: 'available',
    memory: 'partial',
    studio: 'partial',
    usage: 'partial'
  },
  dsh: {
    sessions: 'available',
    streaming: 'partial',
    tools: 'available',
    approvals: 'available',
    cancel: 'available',
    resume: 'available',
    memory: 'absent',
    studio: 'absent',
    usage: 'absent'
  }
}

/** Un événement d'une session conduite à côté, déjà traduit dans le vocabulaire du shell (les noms de la passerelle Hermes). */
export type EngineEventType = 'message.delta' | 'thinking.delta' | 'message.complete' | 'tool.start' | 'tool.update' | 'tool.complete' | 'approval.request' | 'approval.resolved' | 'usage' | 'error'

export interface EngineEvent {
  engine: EngineId
  sessionId: string
  type: EngineEventType
  /** `message.delta` / `thinking.delta` : `text`. `message.complete` : `stopReason`. Outils : `toolCallId`, `title`, `status`. Accord : `requestId`, `title`, `options`. */
  payload: Record<string, unknown>
}

export interface EngineApprovalOption {
  optionId: string
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always` (ACP). */
  kind: string
  name: string
}

export type EngineResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }
