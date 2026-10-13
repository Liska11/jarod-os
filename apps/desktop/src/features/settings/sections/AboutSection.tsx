import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconDownload, IconFileText, IconFolder, IconInfoCircle, IconLifebuoy, IconServer } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { type HermesStatusPayload, rest } from '../../../lib/rest.ts'
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
  const log = useLocalData(() => (showLog ? window.heraldOS.backend.logTail(300) : Promise.resolve<string[]>([])), [showLog, backend.phase])

  return (
    <>
      <SectionTitle title="About" subtitle="Versions, the runtime underneath, your branding, and where to look when something is off." />

      <AboutIdentity />

      <SettingsGroup title="Versions">
        <SettingsRow icon={<IconInfoCircle />} label="Jarod-OS" description={env?.isDev ? 'Development build.' : 'Agent-native operating system.'} keywords="version build shell">
          <Pill tone="accent">{env?.version ?? '—'}</Pill>
        </SettingsRow>
        <SettingsRow icon={<IconServer />} label="Agent runtime" description={<span className="selectable">{backend.runtime?.label ?? 'Not resolved yet.'}</span>} keywords="hermes jarod core agent version runtime backend">
          <Pill>{status.data?.version && status.data.version !== 'unknown' ? `v${String(status.data.version).replace(/^v/, '')}` : status.loading ? '…' : 'unknown'}</Pill>
          {backend.runtime && <Pill>{backend.runtime.kind}</Pill>}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Health">
        <SettingsRow
          icon={<IconLifebuoy />}
          label="Safe mode"
          description={
            env?.safeMode
              ? 'On: widget plugins, hook scripts and event automations are off until you restart normally.'
              : 'Restart without widget plugins, hook scripts and event automations, to find out whether one of them is the problem.'
          }
          keywords="safe mode recovery crash plugins hooks troubleshoot"
        >
          {env?.safeMode && <Pill tone="warn">On</Pill>}
          <GlassButton size="sm" onClick={() => void window.heraldOS.window.relaunch(!env?.safeMode)}>
            {env?.safeMode ? 'Restart normally' : 'Restart in safe mode'}
          </GlassButton>
        </SettingsRow>
        <SettingsRow
          icon={<IconAlertTriangle />}
          label="Last crash"
          description={env?.lastCrash ? `The Jarod-OS window crashed (${env.lastCrash.reason}) at ${new Date(env.lastCrash.at).toLocaleString()}; it was reloaded.` : 'The Jarod-OS window has not crashed since it started.'}
          keywords="crash renderer reload health"
        >
          <Pill tone={env?.lastCrash ? 'warn' : 'ok'}>{env?.lastCrash ? 'Crashed' : 'None'}</Pill>
        </SettingsRow>
        <SettingsRow
          icon={<IconFolder />}
          label="Settings folder"
          description={<span className="selectable">{env?.userDataDir ?? '—'}</span>}
          keywords="data folder settings location backup userdata"
        >
          {env?.userDataDir && (
            <GlassButton size="sm" onClick={() => void window.heraldOS.fs.openPath(env.userDataDir)}>
              Open
            </GlassButton>
          )}
        </SettingsRow>
      </SettingsGroup>

      <BrandingSettings />

      <SettingsGroup title="Maintenance">
        <SettingsRow
          icon={<IconDownload />}
          label="Check for updates"
          description={
            jarodCore
              ? 'The Jarod core ships inside Jarod-OS: a new version of Jarod-OS updates both.'
              : 'Jarod-OS runs whatever Hermes is installed. Run “hermes update” in Terminal, then restart Hermes from Network.'
          }
          keywords="upgrade update hermes jarod update terminal"
        >
          {!jarodCore && (
            <GlassButton size="sm" onClick={() => openApp('terminal')} aria-label="Open Terminal">
              Open Terminal
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow
          icon={<IconFileText />}
          label="Open logs"
          description="The last 300 lines from the shell and the backend it started."
          keywords="log output debug backend"
          below={showLog ? <LogView lines={log.data ?? []} empty={log.loading ? 'Loading…' : 'No log output yet.'} className="animate-rise" /> : undefined}
        >
          {showLog && (
            <GlassButton size="sm" variant="ghost" onClick={log.reload}>
              Refresh
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={() => setShowLog(o => !o)} aria-label={showLog ? 'Hide logs' : 'Open logs'}>
            {showLog ? 'Hide logs' : 'Open logs'}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
