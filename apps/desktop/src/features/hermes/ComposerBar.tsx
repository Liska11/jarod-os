import { useStore } from '@nanostores/react'
import { IconChevronUp, IconCpu, IconFoldDown, IconSearch } from '@tabler/icons-react'
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
 * The model this conversation talks to is chosen in the conversation's header (ModelPicker below).
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
 * The model button, at the right of the conversation's header: the choice made (or the invitation to make one), and a menu of what the
 * machine offers, local servers first. The menu opens downwards and is aligned on the button's right edge.
 */
export function ModelPicker({ chat, online }: { chat: ChatState | null; online: boolean }) {
  useT()
  const options = useBackendData(() => gatewayRequest('model.options', { include_unconfigured: false }), [], { enabled: online })
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const ref = useDismiss(open, () => setOpen(false))
  const needsChoice = Boolean((options.data as { needs_choice?: boolean } | null | undefined)?.needs_choice)
  const current = options.data?.model ?? chat?.info.model
  // Jarod's Internet off: a cloud model cannot answer. It stays listed, marked, never switched away from silently; local ones come first.
  const offline = useStore($network)?.internet === false
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const found = useMemo(() => {
    const rows = (options.data?.providers ?? [])
      .filter(p => (p.models?.length ?? 0) > 0)
      .map(p => ({ ...p, local: isLocalProvider(p), models: p.models ?? [] }))
    const result = searchModels(rows, filter)

    return { count: result.count, providers: offline ? [...result.providers].sort((a, b) => Number(b.local) - Number(a.local)) : result.providers }
  }, [options.data, filter, offline])
  const providers = found.providers
  const searching = filter.trim() !== ''

  // The list is read again each time the menu opens (a model loaded since, a cloud provider's list), and the search starts empty.
  useEffect(() => {
    if (open) {
      options.reload()
    } else {
      setFilter('')
      setExpanded(new Set())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `options.reload` changes at every render; only the opening matters
  }, [open])
  const currentRow = (options.data?.providers ?? []).find(p => p.is_current)
  const cloudOffline = offline && Boolean(currentRow) && !isLocalProvider(currentRow as ProviderRow)

  const choose = async (providerSlug: string, model: string) => {
    setPending(`${providerSlug}:${model}`)

    try {
      if (chat) {
        await gatewayRequest('slash.exec', { session_id: chat.sessionId, command: `/model ${providerSlug}:${model}` })
      } else {
        await gatewayRequest('config.set', { key: 'model', value: `${providerSlug}:${model}` })
      }

      notify({ title: t('chat.model.changed'), body: `${providerSlug} · ${model}`, level: 'success' })
      setOpen(false)
      options.reload()
    } catch (error) {
      notify({ title: t('chat.model.failed'), body: errorText(error), level: 'error' })
    } finally {
      setPending(null)
    }
  }

  return (
    // Not `relative`: the menu is placed against the conversation header (Conversation.tsx), so a narrow panel never clips it.
    <div ref={ref} className="min-w-0">
      <button
        type="button"
        disabled={!online}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('chat.model.choose')}
        title={cloudOffline ? t('chat.model.cloudOffline') : t('chat.model.title')}
        onClick={() => setOpen(v => !v)}
        className={cn('flex h-7 max-w-[min(300px,32vw)] items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors disabled:opacity-40', needsChoice || cloudOffline ? 'border-warn/50 bg-warn/10 text-warn hover:bg-warn/20' : 'border-line text-fg-2 hover:bg-white/8 hover:text-fg')}
      >
        <IconCpu size={13} className="shrink-0" />
        <span className="truncate" title={modelButtonLabel(options.data, chat?.info)}>{modelButtonLabel(options.data, chat?.info)}</span>
        <IconChevronUp size={12} className={cn('shrink-0 transition-transform', !open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="float animate-pop absolute top-[calc(100%+6px)] right-3 z-30 flex w-[min(360px,calc(100%-24px))] flex-col rounded-lg" role="dialog" aria-label={t('chat.model.choose')}>
          <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
            <IconSearch size={14} className="text-fg-3" />
            <input
              autoFocus
              type="search"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              onKeyDown={event => {
                // Enter picks the first match, so typing a few letters then Enter is enough.
                const first = firstMatch(providers)

                if (event.key === 'Enter' && first && !pending && !(offline && !providers[0]?.local)) {
                  event.preventDefault()
                  void choose(first.slug, first.model)
                }
              }}
              placeholder={t('chat.model.filter')}
              aria-label={t('chat.model.filter')}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4"
            />
            {searching && <span className="shrink-0 text-[11px] text-fg-4">{t('chat.model.count', { count: found.count })}</span>}
          </label>
          {cloudOffline && <div className="mx-2 mb-2 rounded-md bg-warn/10 px-2.5 py-2 text-[11.5px] leading-snug text-warn">{t('chat.model.cloudOffline')}</div>}
          <div className="flex max-h-[320px] flex-col gap-3 overflow-y-auto px-2 pb-2">
            {options.loading && providers.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('chat.model.loading')}</div>}
            {options.error && <div className="px-1 py-2 text-[12px] text-danger">{options.error}</div>}
            {!options.loading && !options.error && providers.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t('chat.model.none')}</div>}
            {providers.map(p => (
              <section key={p.slug}>
                <div className="mb-1 flex items-center gap-2 px-1">
                  <span className="text-[11.5px] font-medium text-fg-2">{p.name}</span>
                  {p.is_current && <Pill tone="accent">{t('chat.model.current')}</Pill>}
                  {offline && !p.local && <Pill tone="warn">{t('chat.model.offline')}</Pill>}
                </div>
                <div className="flex flex-col">
                  {p.models.slice(0, searching || expanded.has(p.slug) ? p.models.length : COLLAPSED_MODELS).map(model => {
                    const active = Boolean(p.is_current) && model === current
                    const busy = pending === `${p.slug}:${model}`

                    return (
                      <button key={model} type="button" disabled={Boolean(pending) || (offline && !p.local)} onClick={() => void choose(p.slug, model)} className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition-colors disabled:opacity-60', active ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg', busy && 'opacity-60')}>
                        <span className="truncate">{model}</span>
                        {active && <span className="ml-2 text-[10.5px] text-accent-strong">{t('chat.model.active')}</span>}
                      </button>
                    )
                  })}
                  {!searching && !expanded.has(p.slug) && p.models.length > COLLAPSED_MODELS && (
                    <button type="button" onClick={() => setExpanded(prev => new Set(prev).add(p.slug))} className="rounded-md px-2 py-1 text-left text-[11.5px] text-accent-strong hover:bg-white/8">
                      {t('chat.model.showAll', { count: p.models.length - COLLAPSED_MODELS })}
                    </button>
                  )}
                </div>
              </section>
            ))}
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
