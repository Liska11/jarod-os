/** WSL machines and the Jarod disk, as the renderer sees them (electron/vms.ts). */

export interface VmSummary {
  name: string
  state: string
  version: number
  default: boolean
  location: string | null
  /** Its disk is in <Jarod disk>\vms. */
  onDisk: boolean
}

export interface VmsState {
  /** WSL machines are a Windows feature. */
  available: boolean
  /** The Jarod disk's root (new machines go to <root>\vms); null without one. */
  root: string | null
  /** The operation under way, if any. */
  busy: string | null
  list: VmSummary[]
}

export type VmResult = { ok: true } | { ok: false; error: string }
