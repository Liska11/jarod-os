import { useStore } from '@nanostores/react'
import { IconBrandSlack, IconPlugConnected, IconServer, IconTerminal2, IconWifi } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, type PillTone, Toggle } from '../../../components/ui/glass.tsx'
import { type HermesStatusPayload, rest } from '../../../lib/rest.ts'
import { useT } from '../../../lib/i18n.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $backend } from '../../../store/backend.ts'
import { $connection } from '../../../store/gateway.ts'
import { notify } from '../../../store/notifications.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { attempt } from '../../../lib/native.ts'

interface McpServerRow {
  name: string
  transport?: string
  url?: string | null
  command?: string | null
  enabled?: boolean
  [key: string]: unknown
}

const phaseTone = (phase: string): PillTone => (phase === 'ready' ? 'ok' : phase === 'failed' ? 'danger' : phase === 'stopped' || phase === 'idle' ? 'muted' : 'warn')

export function NetworkSection() {
  const { t } = useT()
  const backend = useStore($backend)
  const connection = useStore($connection)

  return (
    <>
      <SectionTitle title={t('network.title')} subtitle={t('network.subtitle')} />

      <SettingsGroup title={t('network.runtimeGroup')}>
        <SettingsRow icon={<IconServer />} label={t('network.backend')} description={<span className="selectable font-mono text-[11.5px]">{backend.baseUrl ?? t('network.notRunning')}</span>} keywords="hermes runtime server status">
          <Pill tone={phaseTone(backend.phase)} dot>
            {backend.phase}
          </Pill>
          <GlassButton size="sm" variant="ghost" onClick={() => void attempt('native.failed.restartEngine', () => window.jarodOS.backend.restart())} aria-label={t('network.restartAria')}>
            {t('network.restart')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconPlugConnected />} label={t('network.gatewaySocket')} description={t('network.gatewaySocket.hint')} keywords="websocket connection">
          <Pill tone={connection === 'open' ? 'ok' : connection === 'error' ? 'danger' : 'warn'} dot>
            {connection}
          </Pill>
        </SettingsRow>
        <SettingsRow
          icon={<IconTerminal2 />}
          label={t('network.runtimeCommand')}
          description={
            <span className="selectable font-mono text-[11.5px]">
              {backend.runtime?.kind === 'attached'
                ? t('network.using', { label: backend.runtime.label })
                : backend.runtime
                  ? backend.runtime.command.join(' ')
                  : '\u2014'}
            </span>
          }
          keywords="hermes command path managed attached shared"
        >
          {backend.runtime && <Pill>{backend.runtime.kind}</Pill>}
        </SettingsRow>
        {backend.sharedGateway && (
          <InlineNote tone="info">{t('network.sharedGateway', { pid: backend.sharedGateway })}</InlineNote>
        )}
      </SettingsGroup>

      <McpServersGroup />
      <PlatformsGroup />
    </>
  )
}

function McpServersGroup() {
  const { t } = useT()
  const servers = useBackendData(() => rest.get<{ servers: McpServerRow[] }>('/api/mcp/servers'))
  const [override, setOverride] = useState<{ base: unknown; name: string; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const rows = servers.data?.servers ?? []

  const toggle = async (row: McpServerRow, enabled: boolean) => {
    setOverride({ base: servers.data, name: row.name, enabled })
    setBusy(row.name)

    try {
      await rest.put(`/api/mcp/servers/${encodeURIComponent(row.name)}/enabled`, { enabled })
      markSaved()
      notify({ title: enabled ? t('network.mcpEnabled') : t('network.mcpDisabled'), body: t('network.mcpTakesEffect', { name: row.name }), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t('network.mcpUpdateFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
      servers.reload()
    }
  }

  return (
    <SettingsGroup title={t('network.mcpGroup')}>
      {rows.length === 0 && (
        <SettingsRow
          icon={<IconWifi />}
          label={t('network.mcpGroup')}
          description={servers.loading ? t('network.loading') : servers.error ? servers.error : t('network.noMcp')}
          keywords="mcp model context protocol"
        />
      )}
      {rows.map(row => {
        const enabled = override && override.base === servers.data && override.name === row.name ? override.enabled : row.enabled !== false
        const target = row.url ?? (row.command ? [row.command, ...((row.args as string[] | undefined) ?? [])].join(' ') : '')

        return (
          <SettingsRow key={row.name} icon={<IconWifi />} label={row.name} description={<span className="selectable font-mono text-[11.5px]">{target || row.transport || t('network.mcpServer')}</span>} keywords="mcp server">
            {row.transport && <Pill>{row.transport}</Pill>}
            <Toggle checked={enabled} onChange={next => void toggle(row, next)} label={t('network.enableAria', { name: row.name })} disabled={busy === row.name} />
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}

type PlatformState = { state?: string; status?: string; [key: string]: unknown } | string

function platformTone(value: PlatformState): PillTone {
  const state = String(typeof value === 'string' ? value : (value.state ?? value.status ?? '')).toLowerCase()

  if (['connected', 'running', 'ok'].includes(state)) {
    return 'ok'
  }

  if (['fatal', 'error', 'failed'].includes(state)) {
    return 'danger'
  }

  if (!state) {
    return 'muted'
  }

  return 'warn'
}

function PlatformsGroup() {
  const { t } = useT()
  const status = useBackendData(() => rest.get<HermesStatusPayload & { gateway_platforms?: Record<string, PlatformState>; platforms?: Record<string, PlatformState> | PlatformState[] }>('/api/status'))
  const raw = status.data?.gateway_platforms ?? status.data?.platforms
  const entries: [string, PlatformState][] = Array.isArray(raw) ? raw.map((item, index) => [typeof item === 'string' ? item : String(item.name ?? item.id ?? index), item]) : Object.entries(raw ?? {})

  return (
    <SettingsGroup title={t('network.platforms')}>
      {entries.length === 0 && (
        <SettingsRow
          icon={<IconBrandSlack />}
          label={t('network.platforms')}
          description={status.loading ? t('network.loading') : t('network.noPlatforms')}
          keywords="telegram discord slack whatsapp"
        />
      )}
      {entries.map(([name, value]) => {
        const state = typeof value === 'string' ? value : String(value.state ?? value.status ?? 'unknown')

        return (
          <SettingsRow key={name} icon={<IconBrandSlack />} label={name} description={t('network.platformConnected')} keywords="messaging platform">
            <Pill tone={platformTone(value)} dot>
              {state}
            </Pill>
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
