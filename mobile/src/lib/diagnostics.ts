/** How the phone reaches the PC right now. */
export type LinkMode = 'lan' | 'tailscale' | 'offline'

/** Tailscale's range, 100.64.0.0/10, and its IPv6 one (fd7a:115c:a1e0::/48). */
export function isTailnetHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127
  return h.startsWith('fd7a:115c:a1e0:')
}

/** The mode of the address that answered; offline when no channel is open. */
export function linkMode(base: string | undefined, online: boolean): LinkMode {
  if (!online || !base) return 'offline'
  try {
    return isTailnetHost(new URL(base).hostname) ? 'tailscale' : 'lan'
  } catch {
    return 'lan'
  }
}

export const MODE_LABEL: Record<LinkMode, string> = {
  lan: 'Réseau local (Wi-Fi)',
  tailscale: 'Tailscale',
  offline: 'Hors ligne'
}

/** An address for a person: scheme dropped, the host and port kept. */
export function shortAddress(base: string): string {
  return base.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** Latency as the screen says it. */
export function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** One round trip to the PC, timed (a cheap call the PC answers at once). Null when it fails. */
export async function measureLatency(ping: () => Promise<unknown>, now: () => number = () => performance.now()): Promise<number | null> {
  const start = now()
  try {
    await ping()
    return now() - start
  } catch {
    return null
  }
}

/** What the OnePlus battery checklist can know about, as `JarodSystem.power()` reports it. */
export interface PowerState {
  ignoringBatteryOptimizations: boolean
  powerSave: boolean
  manufacturer: string
  model: string
  sdk: number
  /** Android 9+: 10 active, 20 working set, 30 frequent, 40 rare, 50 restricted; absent if unknown. */
  standbyBucket?: number
}

export type CheckState = 'ok' | 'todo' | 'unknown'

export interface BatteryCheck {
  id: 'optimization' | 'adaptive' | 'standby' | 'autostart' | 'saver'
  title: string
  state: CheckState
  help: string
  /** What the shortcut opens. */
  target: 'battery-optimization' | 'battery' | 'autostart' | 'battery-saver'
}

/**
 * The checklist for a phone that kills background apps (OnePlus' OxygenOS/ColorOS most of all). Only
 * two answers are readable by an app: the optimisation exemption and the standby bucket; the rest
 * is a reminder with a shortcut, shown as such (`unknown`), never as a green tick.
 */
export function batteryChecklist(p: PowerState | null): BatteryCheck[] {
  const bucket = p?.standbyBucket
  return [
    {
      id: 'optimization',
      title: 'Optimisation de la batterie : Jarod non restreint',
      state: p ? (p.ignoringBatteryOptimizations ? 'ok' : 'todo') : 'unknown',
      help: 'Choisissez « Toutes les applis », ouvrez Jarod et mettez « Ne pas optimiser ». Sans cela, le système peut endormir la veille.',
      target: 'battery-optimization'
    },
    {
      id: 'adaptive',
      title: 'Batterie adaptative : Jarod pas en « Restreint »',
      state: bucket === undefined ? 'unknown' : bucket >= 40 ? 'todo' : 'ok',
      help: bucket === undefined ? 'Réglages › Batterie : désactivez la batterie adaptative, ou ne limitez pas Jarod.' : `Groupe d’attente actuel : ${bucketLabel(bucket)}. « Rare » ou « Restreint » retarde la veille.`,
      target: 'battery'
    },
    {
      id: 'standby',
      title: 'Veille de sommeil (Sleep standby) : désactivée pour Jarod',
      state: 'unknown',
      help: 'Réglages › Batterie › Optimisation de la veille (nom variable) : excluez Jarod. Android ne laisse pas une appli lire ce réglage.',
      target: 'battery'
    },
    {
      id: 'autostart',
      title: 'Démarrage automatique autorisé',
      state: 'unknown',
      help: 'Autorisez Jarod à démarrer seul et à tourner en arrière-plan : c’est ce qui relance la veille après un redémarrage.',
      target: 'autostart'
    },
    {
      id: 'saver',
      title: 'Économiseur de batterie éteint',
      state: p ? (p.powerSave ? 'todo' : 'ok') : 'unknown',
      help: 'L’économiseur coupe les services d’arrière-plan : éteignez-le, ou autorisez Jarod.',
      target: 'battery-saver'
    }
  ]
}

export function bucketLabel(bucket: number): string {
  if (bucket <= 10) return 'actif'
  if (bucket <= 20) return 'utilisé régulièrement'
  if (bucket <= 30) return 'fréquent'
  if (bucket <= 40) return 'rare'
  return 'restreint'
}

export const isOnePlus = (p: PowerState | null): boolean => /oneplus|oppo|realme/i.test(p?.manufacturer ?? '')
