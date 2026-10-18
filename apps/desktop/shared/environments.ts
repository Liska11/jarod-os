/** Environments on the Jarod disk, as the renderer sees them (electron/environments.ts). */

export interface EnvironmentSummary {
  name: string
  kind: 'python' | 'node'
  requested: string
  version: string
  created: string
}

export interface EnvironmentsState {
  /** Environments need the Jarod disk (Settings › Storage). */
  available: boolean
  folder: string | null
  /** The environment being built, if any. */
  building: string | null
  list: EnvironmentSummary[]
}

export type EnvironmentResult = { ok: true; name?: string } | { ok: false; error: string }
