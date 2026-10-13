import type { AuditReport } from '../../shared/system-audit.ts'
import { auditFile, runAudit, type SystemFacts } from './audit.ts'

/*
 * The system audit in main: run in the background once main is ready, reused from its JSON afterwards
 * (`system-audit.json` in the shell's config folder). Concurrent callers share one run.
 */

export interface AuditServiceOptions {
  configDir: string
  log?: (message: string) => void
  /** Replaces the machine probes in tests. */
  collect?: () => Promise<SystemFacts>
}

export class AuditService {
  private running: Promise<AuditReport> | null = null

  constructor(private readonly options: AuditServiceOptions) {}

  /** The audit, at most one run at a time; `force` audits again even when a saved report exists. */
  get(force = false): Promise<AuditReport> {
    if (this.running && !force) return this.running
    const run = runAudit({ file: auditFile(this.options.configDir), force, collect: this.options.collect, log: this.options.log })
    this.running = run.catch(error => {
      this.running = null
      throw error
    })
    return this.running
  }
}
