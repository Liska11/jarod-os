import { useMemo, useState } from 'react'
import { GlassButton, Pill, type PillTone } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { formatRelative } from '../../../lib/format.ts'
import { type MessageKey, t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useLocalData } from '../../../lib/use-async.ts'
import { AUDIT_SOURCES, type AuditOutcome, type AuditSource, filterAudit, type UnifiedAudit, type UnifiedAuditLine, unifyAudit } from './audit-view-model.ts'

const LIMIT = 500

/**
 * V-03 — lit les cinq journaux (le noyau pour l'agent et `jarod mcp`, le shell pour le pont, le contrôle et les téléchargements) et les fusionne. Un backend sans le
 * canal `audit-recent` (Hermes) ne retire que sa part : les journaux du shell restent lisibles, et la vue le dit.
 */
async function loadUnifiedAudit(): Promise<UnifiedAudit & { coreMissing: boolean }> {
  const [core, shell] = await Promise.allSettled([jarod<{ agent: Record<string, unknown>[]; mcpServer: string[] }>('audit-recent', LIMIT), window.jarodOS.audit.journals(LIMIT)])
  const fromCore = core.status === 'fulfilled' && core.value && Array.isArray(core.value.agent) ? core.value : { agent: [], mcpServer: [] }
  const fromShell = shell.status === 'fulfilled' ? shell.value : { bridge: [], control: [], downloads: [] }

  return {
    ...unifyAudit({ agent: fromCore.agent, mcpServer: fromCore.mcpServer ?? [], bridge: fromShell.bridge, control: fromShell.control, downloads: fromShell.downloads ?? [] }, LIMIT),
    coreMissing: core.status === 'rejected'
  }
}

const SOURCE_LABEL: Record<AuditSource, MessageKey> = {
  agent: 'settings.audit.source.agent',
  bridge: 'settings.audit.source.bridge',
  control: 'settings.audit.source.control',
  'mcp-server': 'settings.audit.source.mcpServer',
  download: 'settings.audit.source.download'
}

const OUTCOME_TONE: Record<AuditOutcome, PillTone> = { ok: 'muted', decided: 'info', refused: 'warn', failed: 'danger' }

const PROBLEMS: ReadonlySet<AuditOutcome> = new Set(['refused', 'failed'])

function UnifiedAuditRow({ line }: { line: UnifiedAuditLine }) {
  return (
    <div data-testid="unified-audit-line" data-source={line.source} data-outcome={line.outcome} data-tool={line.tool} className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[12px] last:border-b-0">
      <span className="w-14 shrink-0 text-fg-4" title={new Date(line.at).toISOString()}>
        {formatRelative(line.at)}
      </span>
      <span className="w-20 shrink-0 truncate text-fg-4">{t(SOURCE_LABEL[line.source])}</span>
      <span className="w-40 shrink-0 truncate font-mono text-fg-2" title={line.tool}>
        {line.tool}
      </span>
      <Pill tone={OUTCOME_TONE[line.outcome]}>{line.decision}</Pill>
      {line.injection && <Pill tone="danger">{t('settings.audit.injection')}</Pill>}
      <span className="selectable min-w-0 flex-1 truncate text-fg-3" title={line.detail}>
        {line.detail}
      </span>
      {line.requestId && <span className="selectable shrink-0 font-mono text-[10.5px] text-fg-4">{line.requestId}</span>}
    </div>
  )
}

/** La vue unique des journaux d'audit : sources à cocher, refus et échecs seuls, recherche ; lecture seule. */
export function UnifiedAuditLog() {
  useT()
  const audit = useLocalData(loadUnifiedAudit)
  const [sources, setSources] = useState<ReadonlySet<AuditSource>>(new Set(AUDIT_SOURCES))
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [text, setText] = useState('')
  const lines = useMemo(() => filterAudit(audit.data?.lines ?? [], { sources, ...(problemsOnly ? { outcomes: PROBLEMS } : {}), text }), [audit.data, sources, problemsOnly, text])
  const unreadable = audit.data ? Object.values(audit.data.unreadable).reduce((a, b) => a + b, 0) : 0

  const toggle = (source: AuditSource) =>
    setSources(current => {
      const next = new Set(current)

      if (next.has(source)) {
        next.delete(source)
      } else {
        next.add(source)
      }

      return next
    })

  return (
    <div className="animate-rise flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {AUDIT_SOURCES.map(source => (
          <button
            key={source}
            type="button"
            aria-pressed={sources.has(source)}
            onClick={() => toggle(source)}
            className={cn('rounded-full border px-2.5 py-0.5 text-[11.5px]', sources.has(source) ? 'border-accent/50 bg-accent/15 text-fg-1' : 'border-line text-fg-4')}
          >
            {t(SOURCE_LABEL[source])}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={problemsOnly}
          onClick={() => setProblemsOnly(on => !on)}
          className={cn('rounded-full border px-2.5 py-0.5 text-[11.5px]', problemsOnly ? 'border-warn/50 bg-warn/15 text-fg-1' : 'border-line text-fg-4')}
        >
          {t('settings.audit.problemsOnly')}
        </button>
        <input
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder={t('settings.audit.search')}
          aria-label={t('settings.audit.search')}
          className="glass-input h-7 min-w-[140px] flex-1 rounded-lg px-2.5 text-[12px] outline-none placeholder:text-fg-4"
        />
        <GlassButton size="sm" variant="ghost" onClick={audit.reload}>
          {t('settings.privacy.refresh')}
        </GlassButton>
      </div>
      <div className="flex max-h-[420px] flex-col overflow-y-auto rounded-lg border border-line bg-black/20">
        {audit.loading && !audit.data && <div className="p-3 text-[12px] text-fg-4">{t('settings.privacy.loading')}</div>}
        {audit.data && lines.length === 0 && <div className="p-3 text-[12px] text-fg-4">{t('settings.privacy.noActivity')}</div>}
        {lines.map((line, index) => (
          <UnifiedAuditRow key={`${line.source}-${line.at}-${index}`} line={line} />
        ))}
      </div>
      {(audit.data?.coreMissing || unreadable > 0) && (
        <div className="text-[11.5px] text-fg-4">
          {audit.data?.coreMissing && <span>{t('settings.audit.coreMissing')} </span>}
          {unreadable > 0 && <span>{t('settings.audit.unreadable', { count: unreadable })}</span>}
        </div>
      )}
    </div>
  )
}
