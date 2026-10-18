import { useStore } from '@nanostores/react'
import { t, useT } from '../../../lib/i18n.ts'
import { IconId, IconLock, IconPhoto } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../../components/herald-logo.tsx'
import { GlassButton, GlassCard } from '../../../components/ui/glass.tsx'
import { $env } from '../../../store/backend.ts'
import { $branding } from '../../../store/branding.ts'
import { notify } from '../../../store/notifications.ts'
import { runCommand } from '../../../store/os-commands.ts'
import { markSaved, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'
import { baseName } from '../../../../shared/path-names.ts'

async function run(command: string, args: Record<string, unknown>) {
  const result = await runCommand(command, args, { source: 'ui' })

  if (result.ok) {
    markSaved()
  } else {
    notify({ title: t('branding.changeFailed'), body: result.error ?? result.summary, level: 'error' })
  }
}

async function choose(kind: 'logo' | 'lock') {
  try {
    const [file] = await window.heraldOS.fs.pickFiles({ directory: false, multiple: false })

    if (file) {
      await run('branding.set', { [kind]: file })
    }
  } catch (error) {
    notify({ title: t('branding.chooseFailed'), body: error instanceof Error ? error.message : String(error), level: 'error' })
  }
}

/** The top of About: the Herald logo, or the logo and name the person set. */
export function AboutIdentity() {
  const { t } = useT()
  const env = useStore($env)
  const branding = useStore($branding)

  return (
    <SettingsBlock label="Jarod-OS" description={branding.name ?? undefined} keywords={t('branding.aboutKw')}>
      <GlassCard className="flex items-center gap-4 p-5">
        {branding.logo ? <img src={branding.logo} alt={branding.name ? t('branding.logoAltNamed', { name: branding.name }) : t('branding.logoAlt')} className="h-12 max-w-[180px] object-contain" /> : <HeraldLogo height={56} />}
        <div className="min-w-0">
          {branding.name && <div className="truncate text-[15px] font-semibold text-fg">{branding.name}</div>}
          <div className={branding.name ? 'text-[12.5px] text-fg-3' : 'text-[15px] font-semibold text-fg'}>Jarod-OS {env?.version ?? ''}</div>
        </div>
      </GlassCard>
    </SettingsBlock>
  )
}

/** Settings > About > Branding: the logo, a name under it, and the lock-screen picture on Linux. */
export function BrandingSettings() {
  const { t } = useT()
  const env = useStore($env)
  const branding = useStore($branding)
  const [name, setName] = useState(branding.name ?? '')

  useEffect(() => setName(branding.name ?? ''), [branding.name])

  const saveName = () => {
    if (name.trim() !== (branding.name ?? '')) {
      void run('branding.set', { name: name.trim() })
    }
  }

  return (
    <SettingsGroup title={t('branding.group')}>
      <SettingsRow icon={<IconPhoto />} label={t('branding.logoAlt')} description={branding.logo ? t('branding.logoYours') : t('branding.logoDefault')} keywords={t('branding.logoKw')}>
        {branding.logo && (
          <GlassButton size="sm" variant="ghost" onClick={() => void run('branding.reset', { what: 'logo' })}>
            {t('branding.useJarod')}
          </GlassButton>
        )}
        <GlassButton size="sm" onClick={() => void choose('logo')}>
          {t('branding.choose')}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconId />} label={t('branding.name')} description={t('branding.nameDesc')} keywords={t('branding.nameKw')}>
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
          maxLength={40}
          placeholder={t('branding.namePlaceholder')}
          aria-label={t('branding.nameAria')}
          className="glass-input h-8 w-[200px] rounded-lg px-2.5 text-[12.5px] outline-none"
        />
      </SettingsRow>
      {env?.platform === 'linux' && (
        <SettingsRow
          icon={<IconLock />}
          label={t('branding.lock')}
          description={branding.lock ? <span className="selectable">{baseName(branding.lock)}</span> : t('branding.lockDesc')}
          keywords={t('branding.lockKw')}
        >
          {branding.lock && (
            <GlassButton size="sm" variant="ghost" onClick={() => void run('branding.reset', { what: 'lock' })}>
              {t('branding.useTheme')}
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={() => void choose('lock')}>
            {t('branding.choose')}
          </GlassButton>
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}
