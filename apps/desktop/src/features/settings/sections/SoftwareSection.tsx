import { useStore } from '@nanostores/react'
import { useT } from '../../../lib/i18n.ts'
import { IconApps, IconBrain, IconBrandWindows, IconCode, IconDeviceGamepad2, IconDownload, IconKey, IconMovie, IconRefresh, IconTerminal2, IconWorld } from '@tabler/icons-react'
import { type ComponentType, useEffect, useState } from 'react'
import type { CatalogEntryView } from '../../../../shared/ipc.ts'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { deviceNoun, hostPlatform } from '../../../lib/platform-labels.ts'
import { $catalog, loadCatalog, runCatalog, switchHermesToLocalModel } from '../../../store/catalog.ts'
import { notify } from '../../../store/notifications.ts'
import { openTerminalProgram } from '../../../store/terminal.ts'
import { errorText, InlineNote, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

const GROUP_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  ai: IconBrain,
  developer: IconCode,
  editors: IconCode,
  terminals: IconTerminal2,
  gaming: IconDeviceGamepad2,
  windows: IconBrandWindows,
  media: IconMovie,
  services: IconKey,
  webapps: IconWorld
}

/*
 * Software: the install catalog, grouped. Each row installs the right way for this machine
 * (Flatpak, the package manager, npm or mise in ~/.local, a web app), or says why it cannot.
 */
export function SoftwareSection() {
  const { t } = useT()
  const catalog = useStore($catalog)
  const [refreshing, setRefreshing] = useState(false)
  const linux = hostPlatform() === 'linux'

  useEffect(() => {
    void loadCatalog()
  }, [])

  const refresh = () => {
    setRefreshing(true)
    void loadCatalog().finally(() => setRefreshing(false))
  }

  return (
    <>
      <SectionTitle title={t('software.title')} subtitle={linux ? t('software.subtitle') : t('software.subtitle.desktop', { device: deviceNoun() })} />

      {catalog.error && <InlineNote tone="danger">{catalog.error}</InlineNote>}
      {!catalog.loaded && (
        <div className="flex items-center gap-3 px-1 py-4 text-[12.5px] text-fg-3">
          <Spinner /> {t('software.checking')}
        </div>
      )}

      {catalog.groups.map(group => {
        const Icon = GROUP_ICONS[group.id] ?? IconApps

        return (
          <SettingsGroup key={group.id} title={group.label}>
            {group.entries.map(entry => (
              <CatalogRow key={entry.id} entry={entry} icon={<Icon size={16} />} busy={catalog.busy[entry.id]} />
            ))}
          </SettingsGroup>
        )
      })}

      {catalog.loaded && (
        <div className="flex justify-end">
          <GlassButton size="sm" variant="ghost" onClick={refresh} disabled={refreshing} aria-label={t('software.checkAgain')}>
            <IconRefresh size={14} /> {t('software.checkAgain')}
          </GlassButton>
        </div>
      )}
    </>
  )
}

function CatalogRow({ entry, icon, busy }: { entry: CatalogEntryView; icon: React.ReactNode; busy?: 'install' | 'remove' }) {
  const { t } = useT()
  const description = entry.available || entry.installed ? entry.description : `${entry.description} ${entry.reason ? `(${entry.reason[0]?.toUpperCase()}${entry.reason.slice(1)}.)` : ''}`

  return (
    <SettingsRow icon={icon} label={entry.label} description={description} keywords={`${entry.id} ${entry.group} install`}>
      {busy ? (
        <span className="flex items-center gap-2 text-[12px] text-fg-3">
          <Spinner /> {busy === 'install' ? t('software.installing') : t('software.removing')}
        </span>
      ) : entry.installed ? (
        <>
          <Pill tone="ok">{t('software.installed')}</Pill>
          {entry.terminal && (
            <GlassButton size="sm" onClick={() => openTerminalProgram(entry.id, entry.label)} aria-label={t('software.openAria', { label: entry.label })}>
              <IconTerminal2 size={14} /> {t('software.open')}
            </GlassButton>
          )}
          {entry.hermes && <UseWithHermes kind={entry.hermes} label={entry.label} />}
          {entry.removable && (
            <GlassButton size="sm" variant="ghost" onClick={() => void runCatalog(entry.id, 'remove')} aria-label={t('software.removeAria', { label: entry.label })}>
              {t('software.remove')}
            </GlassButton>
          )}
        </>
      ) : entry.available ? (
        <GlassButton size="sm" onClick={() => void runCatalog(entry.id, 'install')} aria-label={t('software.installAria', { label: entry.label })}>
          <IconDownload size={14} /> {entry.method === 'link' ? t('software.download') : t('software.install')}
        </GlassButton>
      ) : (
        <span className="text-[12px] text-fg-4">{t('software.notHere')}</span>
      )}
    </SettingsRow>
  )
}

/** Point Hermes at one of the local server's models. */
function UseWithHermes({ kind, label }: { kind: 'ollama' | 'lmstudio'; label: string }) {
  const { t } = useT()
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)

    try {
      setModels(await window.jarodOS.catalog.localModels(kind))
    } catch (error) {
      notify({ title: t('software.notReady', { label }), body: errorText(error), level: 'warn' })
    } finally {
      setLoading(false)
    }
  }

  const choose = async (model: string) => {
    try {
      await switchHermesToLocalModel(kind, model)
      notify({ title: t('software.usesModel', { model }), body: t('software.usesModel.hint', { label }), level: 'success' })
    } catch (error) {
      notify({ title: t('software.switchFailed'), body: errorText(error), level: 'error' })
    }
  }

  if (!models) {
    return (
      <GlassButton size="sm" onClick={() => void load()} disabled={loading} aria-label={t('software.useAria', { label })}>
        {loading ? <Spinner /> : <IconBrain size={14} />} {t('software.use')}
      </GlassButton>
    )
  }

  return <MenuDropdown ariaLabel={t('software.modelOnAria', { label })} label={t('software.chooseModel')} items={models.map(model => ({ id: model, label: model }))} onSelect={model => void choose(model)} />
}
