import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconDownload, IconFileText, IconFolder, IconInfoCircle, IconLifebuoy, IconServer } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { type HermesStatusPayload, rest } from '../../../lib/rest.ts'
import { dateLocale, useT } from '../../../lib/i18n.ts'
import { useBackendData, useLocalData } from '../../../lib/use-async.ts'
import { $backend, $env } from '../../../store/backend.ts'
import { openApp } from '../../../store/windows.ts'
import { AboutIdentity, BrandingSettings } from './BrandingSettings.tsx'
import { LogView, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

export function AboutSection() {
  const env = useStore($env)
  const backend = useStore($backend)
  const status = useBackendData(() => rest.get<HermesStatusPayload>('/api/status'))
  const [showLog, setShowLog] = useState(false)
  const jarodCore = backend.runtime?.kind === 'jarod'
  const { t } = useT()
  const log = useLocalData(() => (showLog ? window.heraldOS.backend.logTail(300) : Promise.resolve<string[]>([])), [showLog, backend.phase])

  return (
    <>
      <SectionTitle title={t('about.title')} subtitle={t('about.subtitle')} />

      <AboutIdentity />

      <SettingsGroup title={t('about.versions')}>
        <SettingsRow icon={<IconInfoCircle />} label="Jarod-OS" description={env?.isDev ? t('about.devBuild') : t('about.product')} keywords="version build shell">
          <Pill tone="accent">{env?.version ?? '—'}</Pill>
        </SettingsRow>
        <SettingsRow icon={<IconServer />} label={t('about.runtime')} description={<span className="selectable">{backend.runtime?.label ?? t('about.runtimeUnknown')}</span>} keywords="hermes jarod core agent version runtime backend">
          <Pill>{status.data?.version && status.data.version !== 'unknown' ? `v${String(status.data.version).replace(/^v/, '')}` : status.loading ? '…' : 'unknown'}</Pill>
          {backend.runtime && <Pill>{backend.runtime.kind}</Pill>}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('about.health')}>
        <SettingsRow
          icon={<IconLifebuoy />}
          label={t('about.safeMode')}
          description={env?.safeMode ? t('about.safeMode.on') : t('about.safeMode.off')}
          keywords="safe mode recovery crash plugins hooks troubleshoot"
        >
          {env?.safeMode && <Pill tone="warn">{t('about.safeMode.pill')}</Pill>}
          <GlassButton size="sm" onClick={() => void window.heraldOS.window.relaunch(!env?.safeMode)}>
            {env?.safeMode ? t('about.restartNormally') : t('about.restartSafe')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow
          icon={<IconAlertTriangle />}
          label={t('about.lastCrash')}
          description={env?.lastCrash ? t('about.lastCrash.some', { reason: env.lastCrash.reason, when: new Date(env.lastCrash.at).toLocaleString(dateLocale()) }) : t('about.lastCrash.none')}
          keywords="crash renderer reload health"
        >
          <Pill tone={env?.lastCrash ? 'warn' : 'ok'}>{env?.lastCrash ? t('about.lastCrash.crashed') : t('about.lastCrash.ok')}</Pill>
        </SettingsRow>
        <SettingsRow
          icon={<IconFolder />}
          label={t('about.settingsFolder')}
          description={<span className="selectable">{env?.userDataDir ?? '—'}</span>}
          keywords="data folder settings location backup userdata"
        >
          {env?.userDataDir && (
            <GlassButton size="sm" onClick={() => void window.heraldOS.fs.openPath(env.userDataDir)}>
              {t('about.open')}
            </GlassButton>
          )}
        </SettingsRow>
      </SettingsGroup>

      <BrandingSettings />

      <SettingsGroup title={t('about.maintenance')}>
        <SettingsRow
          icon={<IconDownload />}
          label={t('about.updates')}
          description={jarodCore ? t('about.updates.jarod') : t('about.updates.hermes')}
          keywords="upgrade update hermes jarod update terminal"
        >
          {!jarodCore && (
            <GlassButton size="sm" onClick={() => openApp('terminal')} aria-label={t('about.openTerminal')}>
              {t('about.openTerminal')}
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow
          icon={<IconFileText />}
          label={t('about.logs')}
          description={t('about.logs.description')}
          keywords="log output debug backend"
          below={showLog ? <LogView lines={log.data ?? []} empty={log.loading ? t('about.logs.loading') : t('about.logs.empty')} className="animate-rise" /> : undefined}
        >
          {showLog && (
            <GlassButton size="sm" variant="ghost" onClick={log.reload}>
              {t('about.logs.refresh')}
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={() => setShowLog(o => !o)} aria-label={showLog ? t('about.logs.hide') : t('about.logs')}>
            {showLog ? t('about.logs.hide') : t('about.logs')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
