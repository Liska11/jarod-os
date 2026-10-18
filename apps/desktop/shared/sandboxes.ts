/** Sandboxes on the Jarod disk, as the renderer sees them (electron/sandboxes.ts). */

export interface SandboxSummary {
  name: string
  source: string
  created: string
  full: boolean
}

export interface SandboxChangeInfo {
  path: string
  kind: 'added' | 'modified' | 'removed'
}

export interface SandboxesState {
  /** Sandboxes need the Jarod disk (Settings › Storage). */
  available: boolean
  folder: string | null
  busy: boolean
  list: SandboxSummary[]
}

export type SandboxResult = { ok: true; name?: string; path?: string; changes?: SandboxChangeInfo[] } | { ok: false; error: string }
