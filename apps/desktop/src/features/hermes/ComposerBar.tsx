import { useStore } from '@nanostores/react'
import { IconChevronUp, IconCpu, IconFoldDown, IconPlug, IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { Pill } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import type { ChatState } from '../../lib/chat-model.ts'
import { type ContextTone, contextView } from '../../lib/context-meter.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { $compacting, compactChat } from '../../store/chat.ts'
import { $network } from '../../store/network.ts'
import { isLoopback } from '../../../shared/network-policy.ts'
import { gatewayRequest } from '../../store/gateway.ts'
import { notify } from '../../store/notifications.ts'
import { modelButtonLabel } from '../settings/sections/model-choice.ts'
import { errorText, useDismiss } from '../settings/sections/shared.tsx'
import { t, useT } from '../../lib/i18n.ts'
import { COLLAPSED_MODELS, firstMatch, searchModels } from './model-search.ts'

const BAR_TONE: Record<ContextTone, string> = { unknown: 'bg-fg-4', ok: 'bg-accent', warn: 'bg-warn', danger: 'bg-danger' }

/*
 * Under the composer: how full the context window is, and a button that compacts the old exchanges into a summary to free room.
 * The model this conversation talks to is chosen with the two buttons above the conversation (ModelPicker below).
 */
export function ComposerBar({ chat, online }: { chat: ChatState | null; online: boolean }) {
  useT()
  const view = contextView(chat?.usage)
  const compacting = useStore($compacting) === chat?.sessionId
  const canCompact = online && Boolean(chat) && !chat?.streaming && !compacting && (chat?.messages.length ?? 0) > 1

  return (
    <div className="flex items-center gap-2 px-1.5 pt-1.5 text-[11.5px] text-fg-3">
      <div className="ml-auto flex items-center gap-2.5">
        <div className="flex items-center gap-2" title={view.title} role="meter" aria-label={t('chat.context')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent ?? undefined} aria-valuetext={view.title}>
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
            <span className={cn('block h-full rounded-full transition-[width] duration-300', BAR_TONE[view.tone])} style={{ width: `${view.percent ?? 0}%` }} />
          </span>
          <span className={cn('tabular-nums', view.tone === 'warn' && 'text-warn', view.tone === 'danger' && 'text-danger')}>{view.label}</span>
        </div>
        <button
          type="button"
          disabled={!canCompact}
          onClick={() => void compactChat()}
          title={t('chat.compact.title')}
          aria-label={t('chat.compact.label')}
          className={cn(
            'flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            view.full && canCompact ? 'border-accent-strong/60 bg-accent/25 text-fg hover:bg-accent/40' : 'border-line text-fg-2 hover:bg-white/8 hover:text-fg'
          )}
        >
          {compacting ? <Spinner /> : <IconFoldDown size={13} />}
          {compacting ? t('chat.compacting') : t('chat.compact')}
        </button>
      </div>
    </div>
  )
}

/**
 * The model selector, above the conversation, in two buttons: the PROVIDER (DeepSeek, OpenRouter, NVIDIA, a local server…) and the MODEL of that
 * provider. Choosing a provider opens its models; choosing a model switches the conversation (or the default when none is open) to it.
 * Local servers come first when Jarod's Internet is off. Each menu has a search box; Enter picks the first match.
 */
export function ModelPicker({ chat, online }: { chat: ChatState | null; online: boolean }) {
  useT()
  const options = useBackendData(() => gatewayRequest('model.options', { include_unconfigured: false }), [], { enabled: online })
  const [menu, setMenu] = useState<'provider' | 'model' | null>(null)
  const [browse, setBrowse] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const ref = useDismiss(menu !== null, () => setMenu(null))
  const needsChoice = Boolean((options.data as { needs_choice?: boolean } | null | undefined)?.needs_choice)
  const current = options.data?.model ?? chat?.info.model
  // Jarod's Internet off: a cloud model cannot answer. It stays listed, marked, never switched away from silently; local ones come first.
  const offline = useStore($network)?.internet === false
  const rows = useMemo(() => {
    const all = (options.data?.providers ?? []).filter(p => (p.models?.length ?? 0) > 0).map(p => ({ ...p, local: isLocalProvider(p), models: p.models ?? [] }))

    return offline ? [...all].sort((a, b) => Number(b.local) - Number(a.local)) : all
  }, [options.data, offline])
  const currentRow = rows.find(p => p.is_current)
  const shown = rows.find(p => p.slug === (browse ?? currentRow?.slug)) ?? rows[0]
  const cloudOffline = offline && Boolean(currentRow) && !currentRow?.local
  const searching = filter.trim() !== ''
  const providerMatches = useMemo(() => searchModels(rows.map(p => ({ ...p, models: [p.name] })), filter).providers.map(p => p.slug), [rows, filter])
  const modelMatches = useMemo(() => (shown ? searchModels([shown], filter) : { providers: [], count: 0 }), [shown, filter])

  // The list is read again each time a menu opens (a model loaded since, a cloud provider's list), and the search starts empty.
  useEffect(() => {
    if (menu) {
      options.reload()
    } else {
      setFilter('')
      setExpanded(false)
      setBrowse(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `options.reload` changes at every render; only the opening matters
  }, [menu])

  const choose = async (providerSlug: string, model: string) => {
    setPending(`${providerSlug}:${model}`)

    try {
      if (chat) {
        await gatewayRequest('slash.exec', { session_id: chat.sessionId, command: `/model ${providerSlug}:${model}` })
      } else {
        await gatewayRequest('config.set', { key: 'model', value: `${providerSlug}:${model}` })
      }

      notify({ title: t('chat.model.changed'), body: `${providerSlug} · ${model}`, level: 'success' })
      setMenu(null)
      options.reload()
    } catch (error) {
      notify({ title: t('chat.model.failed'), body: errorText(error), level: 'error' })
    } finally {
      setPending(null)
    }
  }

  const pickProvider = (slug: string) => {
    setBrowse(slug)
    setFilter('')
    setExpanded(false)
    setMenu('model')
  }

  const button = 'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] transition-colors disabled:opacity-40'
  const tone = (warn: boolean) => (warn ? 'border-warn/50 bg-warn/10 text-warn hover:bg-warn/20' : 'border-line text-fg-2 hover:bg-white/8 hover:text-fg')
  const menuBox = 'float animate-pop absolute top-[calc(100%+6px)] left-0 z-30 flex w-[min(360px,90vw)] flex-col rounded-lg'
  const search = (placeholder: string, count: number | null, onEnter: () => void) => (
    <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
      <IconSearch size={14} className="text-fg-3" />
      <input
        autoFocus
        type="search"
        value={filter}
        onChange={event => setFilter(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onEnter()
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4"
      />
      {searching && count !== null && <span className="shrink-0 text-[11px] text-fg-4">{t('chat.model.count', { count })}</span>}
    </label>
  )

  return (
    <div ref={ref} className="relative flex min-w-0 items-center gap-2">
      <button
        type="button"
        disabled={!online || rows.length === 0}
        aria-haspopup="dialog"
        aria-expanded={menu === 'provider'}
        aria-label={t('chat.provider.choose')}
        title={t('chat.provider.title')}
        onClick={() => setMenu(menu === 'provider' ? null : 'provider')}
        className={cn(button, 'max-w-[min(220px,30vw)]', tone(needsChoice || cloudOffline))}
      >
        <IconPlug size={14} className="shrink-0" />
        <span className="truncate">{currentRow?.name ?? t('chat.provider.choose')}</span>
        <IconChevronUp size={12} className={cn('shrink-0 transition-transform', menu !== 'provider' && 'rotate-180')} aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={!online || rows.length === 0}
        aria-haspopup="dialog"
        aria-expanded={menu === 'model'}
        aria-label={t('chat.model.choose')}
        title={cloudOffline ? t('chat.model.cloudOffline') : t('chat.model.title')}
        onClick={() => setMenu(menu === 'model' ? null : 'model')}
        className={cn(button, 'max-w-[min(300px,40vw)]', tone(needsChoice || cloudOffline))}
      >
        <IconCpu size={14} className="shrink-0" />
        <span className="truncate" title={modelButtonLabel(options.data, chat?.info)}>{current || t('chat.model.pick')}</span>
        <IconChevronUp size={12} className={cn('shrink-0 transition-transform', menu !== 'model' && 'rotate-180')} aria-hidden="true" />
      </button>

      {menu === 'provider' && (
        <div className={menuBox} role="dialog" aria-label={t('chat.provider.choose')}>
          {search(t('chat.provider.filter'), providerMatches.length, () => providerMatches[0] && pickProvider(providerMatches[0]))}
          <div className="flex max-h-[320px] flex-col overflow-y-auto px-2 pb-2">
            {options.loading && rows.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('chat.model.loading')}</div>}
            {options.error && <div className="px-1 py-2 text-[12px] text-danger">{options.error}</div>}
            {rows
              .filter(p => providerMatches.includes(p.slug))
              .map(p => (
                <button key={p.slug} type="button" onClick={() => pickProvider(p.slug)} className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors', p.is_current ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}>
                  <span className="truncate">{p.name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px] text-fg-4">
                    {offline && !p.local && <Pill tone="warn">{t('chat.model.offline')}</Pill>}
                    {p.is_current && <Pill tone="accent">{t('chat.model.current')}</Pill>}
                    {t('chat.provider.models', { count: p.models.length })}
                  </span>
                </button>
              ))}
            {!options.loading && !options.error && providerMatches.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('chat.model.none')}</div>}
          </div>
        </div>
      )}

      {menu === 'model' && (
        <div className={cn(menuBox, 'left-[40px]')} role="dialog" aria-label={t('chat.model.choose')}>
          <div className="flex items-center gap-2 px-3 pt-2 text-[11.5px] font-medium text-fg-2">
            <span className="truncate">{shown?.name ?? ''}</span>
            {shown?.is_current && <Pill tone="accent">{t('chat.model.current')}</Pill>}
            {offline && shown && !shown.local && <Pill tone="warn">{t('chat.model.offline')}</Pill>}
          </div>
          {search(t('chat.model.filter'), modelMatches.count, () => {
            const first = firstMatch(modelMatches.providers)

            if (first && !pending && !(offline && !shown?.local)) {
              void choose(first.slug, first.model)
            }
          })}
          {cloudOffline && <div className="mx-2 mb-2 rounded-md bg-warn/10 px-2.5 py-2 text-[11.5px] leading-snug text-warn">{t('chat.model.cloudOffline')}</div>}
          <div className="flex max-h-[320px] flex-col overflow-y-auto px-2 pb-2">
            {options.loading && !shown && <div className="px-1 py-2 text-[12px] text-fg-4">{t('chat.model.loading')}</div>}
            {options.error && <div className="px-1 py-2 text-[12px] text-danger">{options.error}</div>}
            {shown && modelMatches.count === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('chat.model.none')}</div>}
            {(modelMatches.providers[0]?.models ?? []).slice(0, searching || expanded ? undefined : COLLAPSED_MODELS).map(model => {
              const active = Boolean(shown?.is_current) && model === current
              const busy = pending === `${shown?.slug}:${model}`

              return (
                <button key={model} type="button" disabled={Boolean(pending) || (offline && !shown?.local)} onClick={() => shown && void choose(shown.slug, model)} className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition-colors disabled:opacity-60', active ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg', busy && 'opacity-60')}>
                  <span className="truncate">{model}</span>
                  {active && <span className="ml-2 text-[10.5px] text-accent-strong">{t('chat.model.active')}</span>}
                </button>
              )
            })}
            {!searching && !expanded && (modelMatches.providers[0]?.models.length ?? 0) > COLLAPSED_MODELS && (
              <button type="button" onClick={() => setExpanded(true)} className="rounded-md px-2 py-1 text-left text-[11.5px] text-accent-strong hover:bg-white/8">
                {t('chat.model.showAll', { count: (modelMatches.providers[0]?.models.length ?? 0) - COLLAPSED_MODELS })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

type ProviderRow = { auth_type?: string | null; api_url?: string | null }

/** A provider that runs on this machine: no key (Jarod marks local servers so), or an address on loopback. */
function isLocalProvider(p: ProviderRow): boolean {
  if (p.auth_type === 'none') {
    return true
  }

  try {
    return Boolean(p.api_url) && isLoopback(new URL(String(p.api_url)).hostname)
  } catch {
    return false
  }
}
