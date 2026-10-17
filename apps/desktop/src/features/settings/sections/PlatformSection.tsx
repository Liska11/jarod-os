import { IconArchive, IconBox, IconCpu, IconPlugConnected, IconPuzzle, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Settings > Platform: a read-only snapshot of the platform plugins, the quarantine, the sandboxes and Hyper-V, plus the one gesture that
 * changes something: accepting an MCP tool whose description changed since it was approved. The tool stays out of the model's reach until
 * then. The window only ever names a server and a tool; it never sends a path, a content or a fingerprint.
 */

export interface PlatformStatus {
  plugins: { name: string; version: string; status: string; failures: number; reason?: string }[]
  sandboxes: { id: string; profile: string; state: string; createdAt: number }[]
  quarantine: { id: string; label: string; size: number; status: string; verdict: string | null }[]
  hyperv: { cmdlets: boolean; admin: boolean; detail: string } | null
  mcp: { id: string; name: string; enabled: boolean; state: string; error?: string; tools: string[]; pending: { tool: string; reason: 'changed' | 'new' }[] }[]
}

type Result = { success: boolean; error?: string }

const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`)

export function PlatformSection() {
  useT()
  const status = useBackendData(() => jarod<PlatformStatus>('platform-status'))
  const [busy, setBusy] = useState(false)

  if (isUnsupported(status.error)) {
    return (
      <>
        <SectionTitle title={t('settings.platform.title')} subtitle={t('settings.platform.subtitle')} />
        <InlineNote tone="info">{t('settings.platform.needsJarod')}</InlineNote>
      </>
    )
  }

  const data = status.data
  const pending = (data?.mcp ?? []).flatMap(server => server.pending.map(p => ({ server, ...p })))

  const approve = async (serverId: string, tool: string) => {
    setBusy(true)

    try {
      const result = await jarod<Result>('mcp-approve-tool', serverId, tool)

      if (!result.success) {
        throw new Error(result.error ?? t('settings.platform.approveFailed'))
      }

      markSaved()
      notify({ title: t('settings.platform.approved', { tool }), level: 'success' })
      status.reload()
    } catch (error) {
      reportEngineError(t('settings.platform.title'), error)
    } finally {
      setBusy(false)
    }
  }

  const hyperv = data?.hyperv

  return (
    <>
      <SectionTitle title={t('settings.platform.title')} subtitle={t('settings.platform.subtitle')} />

      <SettingsGroup title={t('settings.platform.mcp')}>
        {pending.length === 0 && <SettingsRow icon={<IconShieldCheck />} label={t('settings.platform.mcp.none')} description={t('settings.platform.mcp.none.hint')} keywords="mcp tools approval pin" />}
        {pending.map(item => (
          <SettingsRow
            key={`${item.server.id}:${item.tool}`}
            icon={<IconPlugConnected />}
            label={t('settings.platform.mcp.tool', { tool: item.tool, server: item.server.name })}
            description={item.reason === 'changed' ? t('settings.platform.mcp.changed') : t('settings.platform.mcp.new')}
            keywords="mcp tool pending"
          >
            <Pill tone="warn">{t('settings.platform.mcp.held')}</Pill>
            <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void approve(item.server.id, item.tool)} aria-label={t('settings.platform.approve.aria', { tool: item.tool, server: item.server.name })}>
              {t('settings.platform.approve')}
            </GlassButton>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.platform.plugins')}>
        {(data?.plugins.length ?? 0) === 0 && <SettingsRow icon={<IconPuzzle />} label={t('settings.platform.plugins.none')} description={t('settings.platform.plugins.none.hint')} keywords="platform plugins empty" />}
        {data?.plugins.map(plugin => (
          <SettingsRow key={plugin.name} icon={<IconPuzzle />} label={`${plugin.name} ${plugin.version}`} description={plugin.reason ?? (plugin.failures ? t('settings.platform.failures', { count: plugin.failures }) : undefined)} keywords="platform plugin">
            <Pill tone={plugin.status === 'enabled' ? 'ok' : plugin.status === 'failed' ? 'danger' : 'muted'}>{plugin.status}</Pill>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.platform.quarantine')}>
        {(data?.quarantine.length ?? 0) === 0 && <SettingsRow icon={<IconArchive />} label={t('settings.platform.quarantine.none')} description={t('settings.platform.quarantine.none.hint')} keywords="quarantine empty" />}
        {data?.quarantine.map(item => (
          <SettingsRow key={item.id} icon={<IconArchive />} label={item.label} description={`${sizeText(item.size)}${item.verdict ? ` · ${item.verdict}` : ''}`} keywords="quarantine file">
            <Pill tone={item.status === 'promoted' ? 'ok' : item.verdict === 'infected' ? 'danger' : 'muted'}>{item.status}</Pill>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.platform.sandboxes')}>
        {(data?.sandboxes.length ?? 0) === 0 && <SettingsRow icon={<IconBox />} label={t('settings.platform.sandboxes.none')} description={t('settings.platform.sandboxes.none.hint')} keywords="sandbox empty" />}
        {data?.sandboxes.map(box => (
          <SettingsRow key={box.id} icon={<IconBox />} label={box.id} description={t('settings.platform.sandboxes.profile', { profile: box.profile })} keywords="sandbox">
            <Pill tone={box.state === 'running' ? 'progress' : 'muted'}>{box.state}</Pill>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.platform.hyperv')}>
        <SettingsRow
          icon={<IconCpu />}
          label={t('settings.platform.hyperv.label')}
          description={hyperv ? hyperv.detail : status.loading ? t('settings.platform.loading') : t('settings.platform.hyperv.unknown')}
          keywords="hyper-v virtual machine vm"
        >
          {hyperv && <Pill tone={hyperv.cmdlets && hyperv.admin ? 'ok' : 'warn'}>{hyperv.cmdlets ? (hyperv.admin ? t('settings.platform.hyperv.ready') : t('settings.platform.hyperv.noadmin')) : t('settings.platform.hyperv.absent')}</Pill>}
        </SettingsRow>
      </SettingsGroup>

      <div>
        <GlassButton size="sm" variant="ghost" disabled={status.loading} onClick={() => status.reload()}>
          <IconRefresh size={14} /> {t('settings.platform.refresh')}
        </GlassButton>
      </div>
    </>
  )
}
