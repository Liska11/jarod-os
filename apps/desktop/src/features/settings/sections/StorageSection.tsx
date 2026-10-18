import { useStore } from '@nanostores/react'
import { useT } from '../../../lib/i18n.ts'
import { IconDeviceFloppy, IconHome } from '@tabler/icons-react'
import { GlassButton, GlassCard, ProgressBar } from '../../../components/ui/glass.tsx'
import { formatBytes } from '../../../lib/format.ts'
import { diskLabel } from '../../../lib/platform-labels.ts'
import { useLocalData } from '../../../lib/use-async.ts'
import { $env } from '../../../store/backend.ts'
import { sendPrompt } from '../../../store/chat.ts'
import { useSystemStats } from '../../../store/system.ts'
import { showPage } from '../../../store/windows.ts'
import { DataDiskPicker } from '../../setup/DataDiskPicker.tsx'
import { BackupsBlock } from './BackupsBlock.tsx'
import { SandboxesBlock } from './SandboxesBlock.tsx'
import { SectionTitle, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'

export function StorageSection() {
  const { t } = useT()
  const stats = useSystemStats()
  const env = useStore($env)
  const hermesHome = env?.hermesHome ?? null
  const homeSize = useLocalData(() => (hermesHome ? window.heraldOS.fs.dirSize(hermesHome) : Promise.resolve(null)), [hermesHome])

  const askHermes = () => {
    showPage('hermes')
    void sendPrompt(t('storage.askSpacePrompt'))
  }

  return (
    <>
      <SectionTitle title={t('storage.title')} subtitle={t('storage.subtitle')} />

      <SettingsBlock title={t('disk.settings.title')} label={t('disk.settings.title')} description={t('disk.settings.text')} keywords={t('disk.settings.keywords')}>
        <GlassCard className="flex flex-col gap-2 p-4">
          <p className="text-[12.5px] text-fg-3">{t('disk.settings.text')}</p>
          <DataDiskPicker />
        </GlassCard>
      </SettingsBlock>

      <BackupsBlock />

      <SandboxesBlock />

      <SettingsGroup title={t('storage.disks')}>
        {(stats?.disks ?? []).length === 0 && <SettingsRow icon={<IconDeviceFloppy />} label={t('storage.disks')} description={t('storage.reading')} keywords={t('storage.diskKw')} />}
        {(stats?.disks ?? []).map(disk => {
          const percent = disk.total > 0 ? (disk.used / disk.total) * 100 : 0

          return (
            <SettingsRow
              key={disk.mount}
              icon={<IconDeviceFloppy />}
              label={diskLabel(disk.mount)}
              description={t('storage.usedOfFree', { used: formatBytes(disk.used), total: formatBytes(disk.total), free: formatBytes(disk.free) })}
              keywords={t('storage.diskKw')}
              below={<ProgressBar value={percent} tone={percent > 90 ? 'progress' : 'accent'} />}
            >
              <span className="text-[12px] tabular-nums text-fg-2">{Math.round(percent)}%</span>
            </SettingsRow>
          )
        })}
      </SettingsGroup>

      <SettingsGroup title={t('storage.hermes')}>
        <SettingsRow
          icon={<IconHome />}
          label={t('storage.home')}
          description={
            <span className="selectable font-mono text-[11.5px]">
              {hermesHome ?? '—'}
              {homeSize.data ? ` \u00b7 ${t('storage.homeSize', { size: `${formatBytes(homeSize.data.bytes)}${homeSize.data.complete ? '' : '+'}`, files: homeSize.data.files.toLocaleString() })}` : homeSize.loading ? ` \u00b7 ${t('storage.measuring')}` : ''}
            </span>
          }
          keywords={t('storage.homeKw')}
        >
          <GlassButton size="sm" onClick={askHermes} aria-label={t('storage.askSpace')}>
            {t('storage.askSpace')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
