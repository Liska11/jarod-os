import { IconCloud, IconFlask, IconRadar, IconRefresh, IconTool } from '@tabler/icons-react'
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
  integration: 'agent-tool' | 'skill' | 'detection-only' | 'external-app'
  state: CapabilityState
  detail: string
  version?: string
  missing?: string[]
  locality: 'local' | 'remote' | 'mixed'
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

/** Integrations first, then the agent's own tools folded into one line (the Tools screen already lists them). */
export function splitRows(rows: CapabilityRow[]) {
  const own = rows.filter(r => !r.id.startsWith('tool.'))
  const tools = rows.filter(r => r.id.startsWith('tool.'))
  const blocked = tools.filter(r => r.state !== 'available').length

  return { own, tools: { total: tools.length, available: tools.length - blocked, blocked } }
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

  const { own, tools } = splitRows(list.data ?? [])

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

      <SettingsGroup title={t('settings.capabilities.tools')}>
        <SettingsRow icon={<IconTool />} label={t('settings.capabilities.tools.summary', { available: tools.available, blocked: tools.blocked })} description={t('settings.capabilities.tools.hint')} keywords="capability tools agent" />
      </SettingsGroup>
    </>
  )
}
