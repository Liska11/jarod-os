/*
 * The system audit (electron/setup/audit.ts) as main and the renderer share it: hardware, prerequisites and their
 * fixes, checked at first run on every platform. (The Linux image's first-boot setup is a separate thing: IPC.setup*.)
 */

export type Environment = 'windows' | 'wsl2' | 'linux' | 'docker' | 'macos'

export interface Gpu {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'other'
  /** Dedicated memory; null when unknown. */
  vramMB: number | null
  integrated: boolean
  driver: string | null
}

export interface SystemFacts {
  platform: NodeJS.Platform
  environment: Environment
  os: { name: string; version: string; kernel: string }
  cpu: { model: string; cores: number; threads: number; avx2: boolean | null; avx512: boolean | null }
  gpus: Gpu[]
  npus: { name: string; ok: boolean }[]
  ramMB: number
  freeDiskMB: number | null
  /** Tool name → version string, null when absent. */
  software: Record<string, string | null>
  /** NVIDIA driver/CUDA as nvidia-smi reports it. */
  nvidiaSmi: string | null
  vulkan: boolean
}

export type CheckStatus = 'ok' | 'missing' | 'outdated' | 'info'

export interface Check {
  id: string
  label: string
  status: CheckStatus
  /** A critical failure blocks the first run. */
  critical: boolean
  detail: string
  /** Exact command(s) that fix it, when one exists. */
  fix?: string
}

export interface AuditReport {
  version: number
  at: string
  facts: SystemFacts
  checks: Check[]
  blocked: boolean
}
