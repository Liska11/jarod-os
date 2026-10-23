import { IconAppWindow, IconCloud, IconCpu, IconFlask, IconRadar, IconRefresh, IconTerminal2, IconTool } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { type MessageKey, t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Settings > Capabilities (cockpit, lot 1): what Jarod can do right now, each state measured by a probe in the engine, never read from a
 * document. Read-only: the window can only ask to probe one capability again, by its id. Nothing here installs, runs or declares anything.
 */

export type CapabilityState = 'unknown' | 'not-installed' | 'installed-unconfigured' | 'available' | 'degraded' | 'blocked-permission' | 'error'

export interface CapabilityRow {
  id: string
  name: string
  description: string
  owner: string
  integration: 'agent-tool' | 'skill' | 'detection-only' | 'external-app' | 'dev-tool' | 'infrastructure' | 'shell-command'
  state: CapabilityState
  detail: string
  version?: string
  missing?: string[]
  locality: 'local' | 'remote' | 'mixed'
  /** The tier the shell applies (V-12 shows it for shell and window commands). */
  risk?: 'read' | 'act' | 'mutate' | 'destructive'
  limits: string[]
  experimental?: boolean
  provenance?: { repo: string; license: string; pinned: string | null; status: string }
}

const TONE: Record<CapabilityState, 'ok' | 'warn' | 'danger' | 'muted'> = {
  unknown: 'muted',
  'not-installed': 'muted',
  'installed-unconfigured': 'warn',
  available: 'ok',
  degraded: 'warn',
  'blocked-permission': 'danger',
  error: 'danger'
}

const FAMILIES = ['tool.', 'shell.', 'ui.', 'rust.'] as const

/**
 * Integrations first, then the agent's own tools folded into one line (the Tools screen already lists them). V-12: the shell's control surface
 * (C2 matrix), its window's command registry and the Rust host are in the same registry, shown in their own groups.
 */
export function splitRows(rows: CapabilityRow[]) {
  const own = rows.filter(r => !FAMILIES.some(prefix => r.id.startsWith(prefix)))
  const tools = rows.filter(r => r.id.startsWith('tool.'))
  const blocked = tools.filter(r => r.state !== 'available').length

  return {
    own,
    tools: { total: tools.length, available: tools.length - blocked, blocked },
    shell: rows.filter(r => r.id.startsWith('shell.')),
    window: rows.filter(r => r.id.startsWith('ui.')),
    rust: rows.filter(r => r.id.startsWith('rust.'))
  }
}

const TIER_TONE: Record<string, 'muted' | 'warn' | 'danger'> = { read: 'muted', act: 'muted', mutate: 'warn', destructive: 'danger' }

/** One family of commands (the shell's control surface, or its window's registry): a summary row that unfolds into the list, each with its tier. */
function CommandFamily({ testId, icon, label, rows, state, detail }: { testId: string; icon: React.ReactNode; label: string; rows: CapabilityRow[]; state: CapabilityState; detail: string }) {
  useT()
  const [open, setOpen] = useState(false)

  return (
    <SettingsRow
      icon={icon}
      label={label}
      description={detail}
      keywords={`capability shell ${testId}`}
      below={
        open && rows.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {rows.map(row => (
              <span key={row.id} title={[row.description, ...row.limits].join(' — ')} className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-fg-2">
                <span className="font-mono">{row.id.replace(/^(shell|ui)\./, '')}</span>
                <Pill tone={TIER_TONE[row.risk ?? 'act'] ?? 'muted'}>{row.risk ?? 'act'}</Pill>
              </span>
            ))}
          </div>
        ) : undefined
      }
    >
      <span data-testid={testId} data-state={state} data-count={rows.length} className="contents">
        <Pill tone={TONE[state]}>{t(`settings.capabilities.state.${state}` as MessageKey)}</Pill>
      </span>
      {rows.length > 0 && (
        <GlassButton size="sm" variant="ghost" onClick={() => setOpen(o => !o)}>
          {open ? t('settings.capabilities.shell.hide') : t('settings.capabilities.shell.show')}
        </GlassButton>
      )}
    </SettingsRow>
  )
}

export function CapabilitiesSection() {
  useT()
  const list = useBackendData(() => jarod<CapabilityRow[]>('capabilities-list'))
  const [busy, setBusy] = useState<string | null>(null)

  if (isUnsupported(list.error)) {
    return (
      <>
        <SectionTitle title={t('settings.capabilities.title')} subtitle={t('settings.capabilities.subtitle')} />
        <InlineNote tone="info">{t('settings.capabilities.needsJarod')}</InlineNote>
      </>
    )
  }

  const { own, tools, shell, window, rust } = splitRows(list.data ?? [])

  const recheck = async (id: string) => {
    setBusy(id)

    try {
      await jarod<CapabilityRow | null>('capabilities-check', id)
      list.reload()
    } catch (error) {
      reportEngineError(t('settings.capabilities.title'), error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.capabilities.title')} subtitle={t('settings.capabilities.subtitle')} />

      <SettingsGroup title={t('settings.capabilities.integrations')}>
        {own.map(row => {
          const description = [
            row.description,
            row.detail,
            row.missing?.length ? t('settings.capabilities.missing', { list: row.missing.join(', ') }) : '',
            row.provenance ? `${row.provenance.repo} · ${row.provenance.license}` : ''
          ]
            .filter(Boolean)
            .join(' — ')

          return (
            <SettingsRow
              key={row.id}
              icon={row.experimental ? <IconFlask /> : row.locality === 'remote' ? <IconCloud /> : <IconRadar />}
              label={`${row.name}${row.version ? ` ${row.version}` : ''}`}
              description={description}
              keywords={`capability ${row.id} ${row.owner}`}
            >
              <Pill tone="muted">{t(`settings.capabilities.integration.${row.integration}` as MessageKey)}</Pill>
              {row.locality !== 'local' && <Pill tone="warn">{t('settings.capabilities.remote')}</Pill>}
              <Pill tone={TONE[row.state]}>{t(`settings.capabilities.state.${row.state}` as MessageKey)}</Pill>
              <GlassButton size="sm" variant="secondary" disabled={busy !== null} onClick={() => void recheck(row.id)} aria-label={t('settings.capabilities.recheck.aria', { name: row.name })}>
                <IconRefresh size={14} />
              </GlassButton>
            </SettingsRow>
          )
        })}
      </SettingsGroup>

      {shell.length > 0 && (
        <SettingsGroup title={t('settings.capabilities.shell')}>
          <CommandFamily testId="capabilities-shell" icon={<IconTerminal2 />} label={t('settings.capabilities.shell.surface', { count: shell.length })} rows={shell} state={shell[0]!.state} detail={shell[0]!.detail} />
          <CommandFamily
            testId="capabilities-window"
            icon={<IconAppWindow />}
            label={t('settings.capabilities.shell.window', { count: window.length })}
            rows={window}
            state={window.length ? 'available' : 'installed-unconfigured'}
            detail={window.length ? t('settings.capabilities.shell.window.live') : t('settings.capabilities.shell.window.none')}
          />
        </SettingsGroup>
      )}

      {rust.length > 0 && (
        <SettingsGroup title={t('settings.capabilities.rust')}>
          {rust.map(row => (
            <SettingsRow key={row.id} icon={<IconCpu />} label={row.name} description={[row.description, row.detail].filter(Boolean).join(' — ')} keywords={`capability rust ${row.id}`}>
              <span data-testid={`capability-${row.id}`} data-state={row.state} className="contents">
                <Pill tone={TONE[row.state]}>{t(`settings.capabilities.state.${row.state}` as MessageKey)}</Pill>
              </span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      <SettingsGroup title={t('settings.capabilities.tools')}>
        <SettingsRow icon={<IconTool />} label={t('settings.capabilities.tools.summary', { available: tools.available, blocked: tools.blocked })} description={t('settings.capabilities.tools.hint')} keywords="capability tools agent" />
      </SettingsGroup>
    </>
  )
}
