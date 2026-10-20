import { IconArchive, IconArrowsMinimize, IconPlugConnected, IconRoute } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { ChipsEditor, SwitchRow, useJarodSettings } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Settings > Context (cockpit, lots 3 and 4): what keeps the model's context under control, measured by the engine.
 * - Large tool outputs stay out of the context, whole and searchable (output_search / output_read): how many, how much was saved.
 * - The history compression proxy (billion-context), plugged into the transport for the providers named here, loopback only.
 *   For those providers Jarod's own compaction steps aside: one authority compresses a conversation, never two.
 */

export interface ContextStatus {
  outputs: { outputs: number; storedChars: number; previewChars: number; savedChars: number; threshold: number }
  compactThreshold: number
  proxy: { enabled: boolean; url: string; providers: string[]; health: 'ok' | 'unreachable' | 'off'; upstream?: string; detail?: string }
}

export const formatChars = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n))

/** A loopback http address without a path: the only kind the engine accepts for the proxy. */
export function proxyUrlProblem(url: string): string | null {
  try {
    const u = new URL(url.trim())

    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && (u.pathname === '/' || u.pathname === '') ? null : t('settings.context.proxy.urlProblem')
  } catch {
    return t('settings.context.proxy.urlProblem')
  }
}

export function ContextSection() {
  useT()
  const status = useBackendData(() => jarod<ContextStatus>('context-status'))
  const api = useJarodSettings()
  const [url, setUrl] = useState<string | null>(null)

  if (isUnsupported(status.error)) {
    return (
      <>
        <SectionTitle title={t('settings.context.title')} subtitle={t('settings.context.subtitle')} />
        <InlineNote tone="info">{t('settings.context.needsJarod')}</InlineNote>
      </>
    )
  }

  const st = status.data
  const cfg = api.settings?.contextProxy
  const save = (patch: Record<string, unknown>) => api.save({ contextProxy: patch }).then(ok => (status.reload(), ok))
  const draftUrl = url ?? cfg?.url ?? ''
  const urlProblem = url !== null ? proxyUrlProblem(url) : null

  return (
    <>
      <SectionTitle title={t('settings.context.title')} subtitle={t('settings.context.subtitle')} />

      <SettingsGroup title={t('settings.context.outputs')}>
        <SettingsRow
          icon={<IconArchive />}
          label={t('settings.context.outputs.kept', { count: st?.outputs.outputs ?? 0 })}
          description={t('settings.context.outputs.hint', { threshold: formatChars(st?.outputs.threshold ?? 8000) })}
          keywords="context outputs saved spill index"
        >
          <Pill tone="ok">{t('settings.context.outputs.saved', { chars: formatChars(st?.outputs.savedChars ?? 0) })}</Pill>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settings.context.proxy')}>
        <SwitchRow icon={<IconRoute />} label={t('settings.context.proxy.enabled')} description={t('settings.context.proxy.enabled.hint')} keywords="billion-context proxy compression history" value={cfg?.enabled ?? false} disabled={api.saving || !cfg} onChange={value => void save({ enabled: value })} />
        <SettingsRow
          icon={<IconPlugConnected />}
          label={t('settings.context.proxy.url')}
          description={st?.proxy.health === 'ok' ? t('settings.context.proxy.ok', { upstream: st.proxy.upstream ?? '' }) : st?.proxy.health === 'unreachable' ? t('settings.context.proxy.down', { detail: st.proxy.detail ?? '' }) : t('settings.context.proxy.off')}
          keywords="billion-context proxy url health"
          below={
            <form
              className="flex items-center gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (url !== null && !urlProblem) {
                  void save({ url: url.trim() }).then(ok => ok && setUrl(null))
                }
              }}
            >
              <label className="glass-input flex h-8 min-w-0 flex-1 items-center rounded-lg px-2.5">
                <span className="sr-only">{t('settings.context.proxy.url')}</span>
                <input value={draftUrl} onChange={event => setUrl(event.target.value)} spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none" />
              </label>
              <GlassButton type="submit" size="sm" variant="secondary" disabled={url === null || Boolean(urlProblem) || api.saving}>
                {t('settings.devices.save')}
              </GlassButton>
              {urlProblem && <InlineNote tone="warn">{urlProblem}</InlineNote>}
            </form>
          }
        >
          <Pill tone={st?.proxy.health === 'ok' ? 'ok' : st?.proxy.health === 'unreachable' ? 'danger' : 'muted'}>{t(`settings.context.proxy.health.${st?.proxy.health ?? 'off'}` as 'settings.context.proxy.health.off')}</Pill>
        </SettingsRow>
        <SettingsRow
          icon={<IconArrowsMinimize />}
          label={t('settings.context.proxy.providers')}
          description={t('settings.context.proxy.providers.hint')}
          keywords="billion-context providers authority compaction"
          below={<ChipsEditor items={cfg?.providers ?? []} validate={item => (/^[a-z0-9-]{1,40}$/.test(item.trim()) ? null : t('settings.context.proxy.providerProblem'))} onChange={items => save({ providers: items.map(i => i.trim()) })} disabled={api.saving || !cfg} placeholder="openai, anthropic…" label={t('settings.context.proxy.providers')} />}
        />
      </SettingsGroup>
    </>
  )
}
