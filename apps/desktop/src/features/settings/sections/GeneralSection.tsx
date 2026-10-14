import { useStore } from '@nanostores/react'
import { IconCoffee, IconDeviceDesktop, IconDeviceDesktopOff, IconDownload, IconFolder, IconKeyboard, IconLock, IconMaximize, IconMicrophone, IconMoodSmile, IconMoon, IconPower, IconRefresh, IconStack2, IconSunset2, IconTerminal2, IconZzz } from '@tabler/icons-react'
import { useEffect } from 'react'
import type { SwitchName } from '../../../../shared/ipc.ts'
import { GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { Kbd } from '../../../components/ui/primitives.tsx'
import { hostPlatform } from '../../../lib/platform-labels.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $catalog, loadCatalog } from '../../../store/catalog.ts'
import { openEmojiPicker } from '../../../store/emoji.ts'
import { notify } from '../../../store/notifications.ts'
import { $spaces } from '../../../store/spaces.ts'
import { $switches, setSwitch, SWITCH_LABELS } from '../../../store/switches.ts'
import { errorText, markSaved, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow, Stepper } from './shared.tsx'
import { attempt } from '../../../lib/native.ts'
import { LanguageSettings } from './LanguageSettings.tsx'
import { t, useT } from '../../../lib/i18n.ts'
import { KeysStep } from '../../setup/KeysStep.tsx'
import { useState } from 'react'

export function GeneralSection() {
  useT()
  const prefs = useStore($prefs)
  const spaces = useStore($spaces)
  const activeSpace = spaces.find(space => space.id === prefs.activeSpace) ?? spaces[0]
  const [showKeysImport, setShowKeysImport] = useState(false)

  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: t('settings.general.saveFailed'), body: errorText(error), level: 'error' })
    }
  }

  const chooseFolder = async (key: 'defaultCwd' | 'projectsRoot' = 'defaultCwd') => {
    try {
      const [path] = await window.heraldOS.fs.pickFiles({ directory: true })

      if (path) {
        await save({ [key]: path })
      }
    } catch (error) {
      notify({ title: t('settings.general.folderFailed'), body: errorText(error), level: 'error' })
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.general.title')} subtitle={t('settings.general.subtitle')} />

      <LanguageSettings />

      <SettingsGroup title={t('settings.general.startup')}>
        <SettingsRow icon={<IconMaximize />} label={t('settings.general.fullscreen')} description={t('settings.general.fullscreen.hint')} keywords="full screen start">
          <Toggle checked={prefs.fullscreenOnLaunch} onChange={next => void save({ fullscreenOnLaunch: next })} label={t('settings.general.fullscreen')} />
        </SettingsRow>
        <SettingsRow icon={<IconStack2 />} label={t('settings.general.space')} description={t('settings.general.space.hint')}>
          <MenuDropdown
            ariaLabel={t('settings.general.space')}
            label={
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: activeSpace?.color }} />
                {activeSpace?.name ?? t('settings.general.space.personal')}
              </span>
            }
            value={activeSpace?.id}
            items={spaces.map(space => ({
              id: space.id,
              label: (
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: space.color }} />
                  {space.name}
                </span>
              )
            }))}
            onSelect={id => void save({ activeSpace: id })}
          />
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label={t('settings.general.folder')} description={<span className="selectable font-mono text-[11.5px]">{prefs.defaultCwd || '~'}</span>} keywords="working directory cwd">
          <GlassButton size="sm" onClick={() => void chooseFolder()} aria-label={t('settings.general.folder.choose')}>
            {t('settings.general.choose')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label={t('settings.general.projects')} description={<span className="selectable font-mono text-[11.5px]">{prefs.projectsRoot || '~/Projects'}</span>} keywords="build studio code website app">
          <GlassButton size="sm" onClick={() => void chooseFolder('projectsRoot')} aria-label={t('settings.general.projects.choose')}>
            {t('settings.general.choose')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <SwitchesGroup />
      {hostPlatform() === 'linux' && <IdleGroup />}
      <TypingGroup />


      <SettingsGroup title={t('settings.general.session')}>
              {hostPlatform() === 'linux' ? (
                <SettingsRow icon={<IconPower />} label={t('settings.general.restart')} description={t('settings.general.restart.hint')} keywords="exit close quit">
                  <GlassButton size="sm" variant="danger" onClick={() => void attempt('quit Jarod-OS', () => window.heraldOS.window.quit())} aria-label={t('settings.general.restart')}>
                    {t('settings.general.restart.button')}
                  </GlassButton>
                </SettingsRow>
              ) : (
                <SettingsRow icon={<IconPower />} label={t('settings.general.quit')} description={t('settings.general.quit.hint')} keywords="exit close">
                  <GlassButton size="sm" variant="danger" onClick={() => void attempt('quit Jarod-OS', () => window.heraldOS.window.quit())} aria-label={t('settings.general.quit')}>
                    {t('settings.general.quit.button')}
                  </GlassButton>
                </SettingsRow>
              )}
            </SettingsGroup>

            <SettingsGroup title={t('settings.general.system')}>
              <SettingsRow icon={<IconRefresh />} label={t('settings.general.systemCheck')} description={t('settings.general.systemCheck.hint')} keywords="audit hardware software check">
                <GlassButton size="sm" onClick={() => void window.heraldOS.systemAudit.run()} aria-label={t('settings.general.systemCheck')}>
                  {t('settings.general.systemCheck')}
                </GlassButton>
              </SettingsRow>
              <SettingsRow icon={<IconDownload />} label={t('settings.general.importKeys')} description={t('settings.general.importKeys.hint')} keywords="api keys tokens import">
                <GlassButton size="sm" onClick={() => setShowKeysImport(true)} aria-label={t('settings.general.importKeys')}>
                  {t('settings.general.importKeys')}
                </GlassButton>
              </SettingsRow>
            </SettingsGroup>

      {showKeysImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowKeysImport(false)} role="dialog" aria-modal="true">
          <div className="mx-4 max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl bg-card p-6 shadow-2xl" onClick={event => event.stopPropagation()}>
            <KeysStep onDone={() => setShowKeysImport(false)} />
          </div>
        </div>
      )}
    </>
  )
}

function SwitchesGroup() {
  useT()
  const switches = useStore($switches)
  const prefs = useStore($prefs)

  const flip = (name: SwitchName, enabled: boolean) =>
    void setSwitch(name, enabled)
      .then(markSaved)
      .catch(error => notify({ title: t('settings.general.switchFailed', { name: SWITCH_LABELS[name].toLowerCase() }), body: errorText(error), level: 'error' }))

  return (
    <SettingsGroup title={t('settings.general.switches')}>
      <SettingsRow icon={<IconMoon />} label={t('settings.general.dnd')} description={t('settings.general.dnd.hint')} keywords="dnd quiet focus silence">
        <Toggle checked={switches.doNotDisturb} onChange={next => flip('doNotDisturb', next)} label={t('settings.general.dnd')} />
      </SettingsRow>
      <SettingsRow icon={<IconCoffee />} label={t('settings.general.awake')} description={t('settings.general.awake.hint')} keywords="caffeine inhibit idle sleep">
        <Toggle checked={switches.stayAwake} onChange={next => flip('stayAwake', next)} label={t('settings.general.awake')} />
      </SettingsRow>
      {switches.nightLight !== null && (
        <SettingsRow icon={<IconSunset2 />} label={t('settings.general.night')} description={t('settings.general.night.hint')} keywords="blue light warm wlsunset">
          <Toggle checked={switches.nightLight} onChange={next => flip('nightLight', next)} label={t('settings.general.night')} />
        </SettingsRow>
      )}
      <SettingsRow icon={<IconDeviceDesktop />} label={t('settings.general.screensaver')} description={t('settings.general.screensaver.hint')} keywords="screen saver idle clock">
        {switches.screensaver && (
          <Stepper value={prefs.screensaver?.afterMinutes ?? 5} min={1} max={60} label={t('settings.general.screensaver.minutes')} onChange={afterMinutes => void updatePrefs({ screensaver: { enabled: true, afterMinutes } }).then(markSaved)} />
        )}
        <Toggle checked={switches.screensaver} onChange={next => flip('screensaver', next)} label={t('settings.general.screensaver')} />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** Dictation and emoji in any app, and (Linux) the keymap niri runs with. */
function TypingGroup() {
  useT()
  const prefs = useStore($prefs)
  const linux = hostPlatform() === 'linux'
  const mod = linux ? 'Super' : 'Cmd'
  const keymap = prefs.keymap === 'omarchy' ? 'omarchy' : 'herald'

  return (
    <SettingsGroup title={t('settings.general.typing')}>
      <SettingsRow icon={<IconMicrophone />} label={t('settings.general.dictation')} description={t('settings.general.dictation.hint')} keywords="speech to text voice typing dictate">
        <Kbd>{mod}+Ctrl+X</Kbd>
      </SettingsRow>
      <SettingsRow icon={<IconMoodSmile />} label={t('settings.general.emoji')} description={linux ? t('settings.general.emoji.linux') : t('settings.general.emoji.other')} keywords="emoji picker smiley">
        <Kbd>{mod}+Ctrl+E</Kbd>
        <GlassButton size="sm" onClick={openEmojiPicker} aria-label={t('settings.general.emoji.open')}>
          {t('settings.general.open')}
        </GlassButton>
      </SettingsRow>
      {linux && <DefaultTerminalRow />}
      {linux && (
        <SettingsRow icon={<IconKeyboard />} label={t('settings.general.keymap')} description={t('settings.general.keymap.hint')} keywords="keyboard shortcuts omarchy copy paste super hotkeys">
          <MenuDropdown
            ariaLabel={t('settings.general.keymap')}
            label={keymap === 'omarchy' ? 'Omarchy' : 'Jarod'}
            value={keymap}
            items={[
              { id: 'herald', label: 'Jarod' },
              { id: 'omarchy', label: 'Omarchy' }
            ]}
            onSelect={id => void updatePrefs({ keymap: id === 'omarchy' ? 'omarchy' : 'herald' }).then(markSaved)}
          />
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}

/** Jarod-OS Linux: what Super+Return opens; terminals installed from Software join the list. */
function DefaultTerminalRow() {
  useT()
  const prefs = useStore($prefs)
  const catalog = useStore($catalog)

  useEffect(() => {
    if (!catalog.loaded) {
      void loadCatalog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const installed = catalog.groups.flatMap(group => group.entries).filter(entry => entry.terminalApp && entry.installed)
  const items = [{ id: 'herald', label: 'Jarod-OS Terminal' }, { id: 'foot', label: 'Foot' }, ...installed.map(entry => ({ id: entry.terminalApp as string, label: entry.label }))]
  const current = prefs.defaultTerminal ?? 'herald'

  return (
    <SettingsRow icon={<IconTerminal2 />} label={t('settings.general.terminal')} description={t('settings.general.terminal.hint')} keywords="terminal default ghostty kitty alacritty foot">
      <MenuDropdown ariaLabel={t('settings.general.terminal')} label={items.find(item => item.id === current)?.label ?? current} value={current} items={items} onSelect={id => void updatePrefs({ defaultTerminal: id }).then(markSaved)} />
    </SettingsRow>
  )
}

/** Jarod-OS Linux: the idle timings swayidle runs with. */
function IdleGroup() {
  useT()
  const prefs = useStore($prefs)
  const idle = { lockAfter: 10, screenOffAfter: 15, suspendAfter: 0, ...prefs.idle }
  const set = (patch: Partial<typeof idle>) => void updatePrefs({ idle: { ...idle, ...patch } }).then(markSaved)

  return (
    <SettingsGroup title={t('settings.general.idle')}>
      <SettingsRow icon={<IconLock />} label={t('settings.general.lock')} description={t('settings.general.lock.hint')} keywords="lock idle timeout">
        <Stepper value={idle.lockAfter} min={1} max={120} label={t('settings.general.lock.minutes')} onChange={lockAfter => set({ lockAfter })} />
      </SettingsRow>
      <SettingsRow icon={<IconDeviceDesktopOff />} label={t('settings.general.screens')} description={t('settings.general.idleMinutes')} keywords="display off power idle">
        <Stepper value={idle.screenOffAfter} min={1} max={180} label={t('settings.general.screens.minutes')} onChange={screenOffAfter => set({ screenOffAfter })} />
      </SettingsRow>
      <SettingsRow icon={<IconZzz />} label={t('settings.general.sleep')} description={idle.suspendAfter ? t('settings.general.idleMinutes') : t('settings.general.sleep.never')} keywords="suspend sleep idle">
        <Stepper value={idle.suspendAfter || null} min={0} max={240} label={t('settings.general.sleep.minutes')} onChange={suspendAfter => set({ suspendAfter })} />
      </SettingsRow>
    </SettingsGroup>
  )
}
