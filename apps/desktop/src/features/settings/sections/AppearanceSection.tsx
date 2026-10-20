import { useStore } from '@nanostores/react'
import { IconBrandGit, IconCode, IconDroplet, IconLayoutBottombar, IconPhoto, IconSparkles, IconTypography, IconWand } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { ThemeSummary } from '../../../../shared/theme.ts'
import { GlassButton, GlassCard, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { $themes, applyTheme, generateTheme, installThemes, loadThemes } from '../../../store/themes.ts'
import { MenuBarSettings } from './MenuBarSettings.tsx'
import { errorText, Filterable, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { baseName } from '../../../../shared/path-names.ts'
import { type MessageKey, t, useT } from '../../../lib/i18n.ts'

const ACCENTS: { id: 'blue' | 'ice' | 'violet'; label: MessageKey; color: string }[] = [
  { id: 'blue', label: 'settings.appearance.accent.blue', color: '#2f7dff' },
  { id: 'ice', label: 'settings.appearance.accent.ice', color: '#4cc2ff' },
  { id: 'violet', label: 'settings.appearance.accent.violet', color: '#7c6cff' }
]

export function AppearanceSection() {
  useT()
  const prefs = useStore($prefs)

  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: t('settings.general.saveFailed'), body: errorText(error), level: 'error' })
    }
  }

  const chooseWallpaper = async () => {
    try {
      const [path] = await window.jarodOS.fs.pickFiles({ directory: false, multiple: false })

      if (path) {
        await save({ wallpaper: `file://${path}` })
      }
    } catch (error) {
      notify({ title: t('settings.appearance.wallpaperFailed'), body: errorText(error), level: 'error' })
    }
  }

  const wallpaperName = prefs.wallpaper ? baseName(decodeURIComponent(prefs.wallpaper.replace(/^file:\/\//, ''))) : null

  return (
    <>
      <SectionTitle title={t('settings.appearance.title')} subtitle={t('settings.appearance.subtitle')} />

      <ThemeGallery />
      <ThemeTools />

      <SettingsGroup title={t('settings.appearance.look')}>
        <SettingsRow icon={<IconDroplet />} label={t('settings.appearance.accent')} description={t('settings.appearance.accent.hint')} keywords="colour color highlight">
          <div className="flex items-center gap-2" role="radiogroup" aria-label={t('settings.appearance.accent.aria')}>
            {ACCENTS.map(accent => {
              const active = prefs.accent === accent.id

              return (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(accent.label)}
                  onClick={() => void save({ accent: accent.id })}
                  className={cn('size-6 rounded-full border border-white/30 transition-transform', active ? 'scale-110 shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_var(--color-fg-3)]' : 'opacity-75 hover:opacity-100')}
                  style={{ background: accent.color }}
                />
              )
            })}
          </div>
        </SettingsRow>
        <SettingsRow icon={<IconPhoto />} label={t('settings.appearance.wallpaper')} description={wallpaperName ? <span className="selectable">{wallpaperName}</span> : t('settings.appearance.wallpaper.default')} keywords="background image desktop">
          {prefs.wallpaper && (
            <GlassButton size="sm" variant="ghost" onClick={() => void save({ wallpaper: '' })} aria-label={t('settings.appearance.wallpaper.reset')}>
              t('settings.appearance.wallpaper.reset')
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={() => void chooseWallpaper()} aria-label={t('settings.appearance.wallpaper.choose')}>
            {t('settings.appearance.chooseImage')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <FontSettings />

      <MenuBarSettings />

      <SettingsGroup title={t('settings.appearance.dock')}>
        <SettingsRow icon={<IconLayoutBottombar />} label={t('settings.appearance.dock.hide')} description={t('settings.appearance.dock.hide.hint')} keywords="dock autohide hide show">
          <Toggle checked={prefs.dockAutoHide !== false} onChange={next => void save({ dockAutoHide: next })} label={t('settings.appearance.dock.hide')} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settings.appearance.motion')}>
        <SettingsRow icon={<IconSparkles />} label={t('settings.appearance.reduce')} description={t('settings.appearance.reduce.hint')} keywords="animation accessibility">
          <Toggle checked={prefs.reduceMotion} onChange={next => void save({ reduceMotion: next })} label={t('settings.appearance.reduce')} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

/** Every installed theme as a card of its own colours; choosing one restyles the whole environment. */
function ThemeGallery() {
  useT()
  const themes = useStore($themes)
  const prefs = useStore($prefs)
  const current = prefs.themeName ?? `herald-${prefs.theme}`
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void loadThemes()
  }, [])

  const choose = async (theme: ThemeSummary) => {
    setBusy(theme.name)

    try {
      await applyTheme(theme.name)
      markSaved()
    } catch (error) {
      notify({ title: t('settings.appearance.applyFailed', { theme: theme.label }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (themes.length === 0) {
    return null
  }

  return (
    <Filterable label={t('settings.appearance.theme')} description={t('settings.appearance.theme.choose')} keywords="theme dark light colour color look">
      <section className="flex flex-col gap-1.5">
        <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">{t('settings.appearance.theme')}</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5" role="radiogroup" aria-label={t('settings.appearance.theme')}>
          {themes.map(theme => {
            const active = theme.name === current

            return (
              <GlassCard
                key={theme.name}
                as="button"
                interactive
                selected={active}
                role="radio"
                aria-checked={active}
                aria-label={theme.label}
                data-os-target={`theme:${theme.name}`}
                onClick={() => void choose(theme)}
                className={cn('flex flex-col gap-2 p-2.5 text-left', busy === theme.name && 'opacity-60')}
              >
                <span className="flex h-12 overflow-hidden rounded-md border border-line" style={{ background: theme.colors.bg }} aria-hidden="true">
                  <span className="m-1.5 flex-1 rounded-sm" style={{ background: theme.colors.surface }}>
                    <span className="mx-1.5 mt-1.5 block h-1.5 w-8 rounded-full" style={{ background: theme.colors.fg }} />
                    <span className="mx-1.5 mt-1 block h-1.5 w-12 rounded-full" style={{ background: theme.colors.fg_dim }} />
                  </span>
                  <span className="my-1.5 mr-1.5 w-4 rounded-sm" style={{ background: theme.colors.accent }} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-fg">{theme.label}</span>
                  <span className="block truncate text-[11px] text-fg-3">
                    {theme.scheme === 'light' ? t('settings.appearance.light') : t('settings.appearance.dark')}
                    {theme.source === 'user' ? t('settings.appearance.yours') : ''}
                  </span>
                </span>
              </GlassCard>
            )
          })}
        </div>
      </section>
    </Filterable>
  )
}

function ThemeTools() {
  useT()
  const prefs = useStore($prefs)
  const [repo, setRepo] = useState('')
  const [working, setWorking] = useState<'generate' | 'install' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const make = async (image?: string) => {
    setError(null)

    try {
      const source = image ?? (await window.jarodOS.fs.pickFiles({ directory: false, multiple: false }))[0]

      if (!source) {
        return
      }

      setWorking('generate')
      const name = await generateTheme({ image: source })
      markSaved()
      notify({ title: t('settings.appearance.newTheme'), body: t('settings.appearance.newTheme.body', { theme: $themes.get().find(theme => theme.name === name)?.label ?? name }), level: 'success' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(null)
    }
  }

  const install = async () => {
    setError(null)
    setWorking('install')

    try {
      const names = await installThemes(repo.trim())
      setRepo('')
      notify({ title: t('settings.appearance.installed'), body: names.join(', '), level: 'success' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(null)
    }
  }

  return (
    <SettingsGroup title={t('settings.appearance.yoursGroup')}>
      <SettingsRow
        icon={<IconWand />}
        label={t('settings.appearance.fromImage')}
        description={t('settings.appearance.fromImage.hint')}
        keywords="generate create custom wallpaper colours"
        below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
      >
        {prefs.wallpaper && (
          <GlassButton size="sm" variant="ghost" disabled={working !== null} onClick={() => void make(prefs.wallpaper)}>
            {t('settings.appearance.fromWallpaper')}
          </GlassButton>
        )}
        <GlassButton size="sm" disabled={working !== null} onClick={() => void make()}>
          {working === 'generate' ? t('settings.appearance.making') : t('settings.appearance.chooseImage')}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconBrandGit />} label={t('settings.appearance.git')} description={t('settings.appearance.git.hint')} keywords="download share community">
        <input
          value={repo}
          onChange={event => setRepo(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && repo.trim() && void install()}
          placeholder="https://github.com/…"
          aria-label={t('settings.appearance.git.aria')}
          className="glass-input h-8 w-56 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
        />
        <GlassButton size="sm" disabled={!repo.trim() || working !== null} onClick={() => void install()}>
          {working === 'install' ? t('settings.appearance.installing') : t('settings.appearance.install')}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconSparkles />} label={t('settings.appearance.skins')} description={t('settings.appearance.skins.hint')} keywords="skin hermes cli tui sync">
        <Toggle
          checked={Boolean(prefs.followHermesSkin)}
          onChange={next => {
            void updatePrefs({ followHermesSkin: next }).then(markSaved)
          }}
          label={t('settings.appearance.skins')}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

function FontSettings() {
  useT()
  const prefs = useStore($prefs)
  const [families, setFamilies] = useState<string[]>([])

  const loadFamilies = () => {
    if (families.length === 0) {
      void window.jarodOS.fonts
        .list()
        .then(setFamilies)
        .catch(() => undefined)
    }
  }

  const set = (kind: 'ui' | 'mono', value: string) => {
    void updatePrefs({ fonts: { ...prefs.fonts, [kind]: value.trim() || undefined } }).then(markSaved)
  }

  const field = (kind: 'ui' | 'mono', label: string) => (
    <input
      key={`${kind}:${prefs.fonts?.[kind] ?? ''}`}
      defaultValue={prefs.fonts?.[kind] ?? ''}
      list="herald-font-families"
      onFocus={loadFamilies}
      onBlur={event => event.target.value.trim() !== (prefs.fonts?.[kind] ?? '') && set(kind, event.target.value)}
      onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
      placeholder={t('settings.appearance.font.default')}
      aria-label={label}
      className="glass-input h-8 w-52 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
    />
  )

  return (
    <SettingsGroup title={t('settings.appearance.fonts')}>
      <datalist id="herald-font-families">
        {families.map(family => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <SettingsRow icon={<IconTypography />} label={t('settings.appearance.font.ui')} description={t('settings.appearance.font.ui.hint')} keywords="font typeface text">
        {field('ui', t('settings.appearance.font.ui'))}
      </SettingsRow>
      <SettingsRow icon={<IconCode />} label={t('settings.appearance.font.mono')} description={t('settings.appearance.font.mono.hint')} keywords="font monospace terminal code">
        {field('mono', t('settings.appearance.font.mono'))}
      </SettingsRow>
    </SettingsGroup>
  )
}
