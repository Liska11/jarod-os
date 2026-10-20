import { openSetup } from '../store/setup.ts'
import { ok, type OsCommand } from '../store/os-commands.ts'

/*
 * The setup wizard and the system audit on demand (HANDOFF.md, section 7): run the system check again after installing
 * a tool, connect the Telegram bot or import API keys later. The agent can read the audit to know the hardware.
 */

export const setupCommands: readonly OsCommand[] = [
  {
    id: 'setup.open',
    title: 'Open the setup wizard',
    description: 'Show the setup wizard again: system check, Telegram bot, API keys import.',
    tier: 'act',
    args: [],
    phrases: ['setup wizard', 'first run setup', 'import api keys', 'connect telegram bot'],
    run: () => {
      openSetup()

      return ok('Opened the setup wizard')
    }
  },
  {
    id: 'system.audit',
    title: 'Check this computer',
    description: 'Audit the hardware (CPU, GPU, NPU, memory, disk) and the tools and drivers (Node.js, Python, CUDA, Docker, WSL2…) again; returns each check with the command that fixes it.',
    tier: 'read',
    args: [],
    phrases: ['system check', 'check my computer', 'hardware audit'],
    run: async () => {
      const report = await window.jarodOS.systemAudit.run()
      const toFix = report.checks.filter(c => c.status === 'missing' || c.status === 'outdated')

      return ok(report.blocked ? 'A critical requirement is missing' : `System checked: ${toFix.length} item(s) to install or update`, {
        data: { at: report.at, blocked: report.blocked, checks: report.checks.map(({ id, label, status, critical, detail, fix }) => ({ id, label, status, critical, detail, fix: fix ?? null })) }
      })
    }
  }
]
