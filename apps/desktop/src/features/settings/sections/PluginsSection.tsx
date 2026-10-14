import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconFolder, IconPuzzle, IconRefresh, IconSparkles, IconWorld } from '@tabler/icons-react'
import { useState } from 'react'
import { type PluginManifest, type PluginView } from '../../../../shared/plugins.ts'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { notify } from '../../../store/notifications.ts'
import { $plugins } from '../../../store/plugins.ts'
import { openAsk } from '../../../store/surface.ts'
import { openApp } from '../../../store/windows.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { attempt } from '../../../lib/native.ts'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * The permissions a manifest asks for, phrased for the person about to turn it on. `describePermissions` in
 * shared/plugins.ts keeps the English wording the control socket reports; this is the interface's copy.
 */
function permissionLines(manifest: PluginManifest): string[] {
  const lines: string[] = []

  if (manifest.permissions.includes('stats')) {
    lines.push(t('plugins.perm.stats'))
  }

  if (manifest.permissions.includes('notify')) {
    lines.push(t('plugins.perm.notify'))
  }

  if (manifest.permissions.includes('storage')) {
    lines.push(t('plugins.perm.storage'))
  }

  for (const permission of manifest.permissions) {
    if (permission.startsWith('run:')) {
      lines.push(t('plugins.perm.run', { command: permission.slice(4) }))
    }
  }

  for (const host of manifest.hosts) {
    lines.push(t('plugins.perm.host', { host }))
  }

  return lines.length ? lines : [t('plugins.perm.none')]
}

/*
 * Settings > Plugins: widgets for the menu bar, the Overview and their own windows (ADR-019). Each
 * runs in a sandbox and gets only what its manifest asks for and the person accepted here; new ones
 * arrive turned off.
 */
export function PluginsSection() {
  const { t } = useT()
  const plugins = useStore($plugins)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)

    try {
      const added = await window.heraldOS.plugins.add(url.trim())
      setUrl('')
      notify({ title: t('plugins.installedToast', { name: added.manifest.name }), body: t('plugins.installedToast.body'), level: 'success' })
    } catch (error) {
      notify({ title: t('plugins.installFailed'), body: errorText(error), level: 'error' })
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('plugins.title')} subtitle={t('plugins.subtitle')} />

      <SettingsGroup title={t('plugins.installed')}>
        {plugins.length === 0 && <SettingsRow icon={<IconPuzzle />} label={t('plugins.none')} description={t('plugins.none.hint')} />}
        {plugins.map(plugin => (
          <PluginRow key={plugin.manifest.id} plugin={plugin} />
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('plugins.add')}>
        <SettingsRow icon={<IconWorld />} label={t('plugins.fromGit')} description={t('plugins.fromGit.hint')} keywords="install plugin widget git">
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()
              void add()
            }}
          >
            <input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/…/my-widget" aria-label={t('plugins.urlAria')} className="glass-input h-8 w-[260px] rounded-lg px-2.5 text-[12.5px] outline-none" />
            <GlassButton size="sm" type="submit" disabled={adding || !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(url.trim())}>
              {adding ? <Spinner /> : null} {t('plugins.add')}
            </GlassButton>
          </form>
        </SettingsRow>
        <SettingsRow icon={<IconSparkles />} label={t('plugins.makeWith')} description={t('plugins.makeWith.hint')} keywords="create widget hermes">
          <GlassButton size="sm" onClick={() => openAsk({ text: t('plugins.makePrompt') })}>
            {t('plugins.makeButton')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label={t('plugins.folder')} description={<span className="font-mono text-[11.5px]">~/.config/herald-os/plugins</span>} keywords="plugin folder files">
          <GlassButton size="sm" variant="ghost" onClick={() => void attempt('native.failed.pluginsFolder', () => window.heraldOS.fs.openPath('~/.config/herald-os/plugins'))}>
            {t('plugins.open')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function PluginRow({ plugin }: { plugin: PluginView }) {
  const { t } = useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { manifest } = plugin
  const broken = plugin.errors.length > 0

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)

    try {
      await window.heraldOS.plugins.setEnabled(manifest.id, enabled)
      markSaved()
    } catch (error) {
      notify({ title: t('plugins.toggleFailed', { name: manifest.name, state: enabled ? t('plugins.on') : t('plugins.off') }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const act = async (what: 'update' | 'remove') => {
    setBusy(true)

    try {
      await (what === 'update' ? window.heraldOS.plugins.update(manifest.id) : window.heraldOS.plugins.remove(manifest.id))
      notify({ title: what === 'update' ? t('plugins.updated', { name: manifest.name }) : t('plugins.removed', { name: manifest.name }), level: 'success' })
    } catch (error) {
      notify({ title: t('plugins.actionFailed', { name: manifest.name, action: what === 'update' ? t('plugins.updateAction') : t('plugins.removeAction') }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow
      icon={<IconPuzzle />}
      label={`${manifest.name}${manifest.version !== '0.0.0' ? ` ${manifest.version}` : ''}`}
      description={broken ? undefined : manifest.description || t('plugins.showsIn', { places: manifest.placement.join(', ') })}
      keywords={`${manifest.id} plugin widget`}
      below={
        broken ? (
          <InlineNote tone="danger">
            <IconAlertTriangle size={13} className="inline" /> {plugin.errors.join('; ')}
          </InlineNote>
        ) : confirming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[12.5px] text-fg-2">
            <span className="font-medium text-fg">{t('plugins.turnOnQuestion', { name: manifest.name })}</span>
            <ul className="list-disc pl-5 text-fg-3">
              {permissionLines(manifest).map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t('plugins.cancel')}
              </GlassButton>
              <GlassButton size="sm" variant="primary" onClick={() => void setEnabled(true)} disabled={busy}>
                {t('plugins.turnOn')}
              </GlassButton>
            </div>
          </div>
        ) : undefined
      }
    >
      {busy && <Spinner />}
      {plugin.enabled && manifest.placement.includes('panel') && (
        <GlassButton size="sm" variant="ghost" onClick={() => openApp('widget', { payload: { plugin: manifest.id }, title: manifest.name, singleton: false })}>
          Open
        </GlassButton>
      )}
      {plugin.git && (
        <GlassButton size="sm" variant="ghost" onClick={() => void act('update')} aria-label={t('plugins.updateAria', { name: manifest.name })} disabled={busy}>
          <IconRefresh size={14} />
        </GlassButton>
      )}
      <GlassButton size="sm" variant="ghost" onClick={() => void act('remove')} disabled={busy}>
        {t('plugins.remove')}
      </GlassButton>
      {!broken && <Pill tone={plugin.enabled ? 'ok' : 'muted'}>{plugin.enabled ? t('plugins.on') : t('plugins.off')}</Pill>}
      {!broken && <Toggle checked={plugin.enabled} onChange={next => (next ? setConfirming(true) : void setEnabled(false))} label={t('plugins.onToggle', { name: manifest.name })} />}
    </SettingsRow>
  )
}
