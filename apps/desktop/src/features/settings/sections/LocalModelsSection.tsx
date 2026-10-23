import { IconBrain, IconClockPause, IconPlayerPlay, IconPlayerStop, IconRefresh, IconServer } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { type MessageKey, useT, dateLocale } from '../../../lib/i18n.ts'
import { jarod, onJarodEvent } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { EngineBlock } from './LocalEngineBlock.tsx'
import { HuggingFaceBlock } from './HuggingFaceBlock.tsx'
import { contextAdvice, contextProblem, formatBytes, formatDuration, idleUnloadLabel, idleUnloadOptions, type LocalBackend, type LocalModelActivity, type LocalModelEntry, type LocalModelsView } from './local-models-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Local models: what is in memory on this PC and the means to put models there.
 *   - "In memory": the models LM Studio and Jarod's own llama.cpp engine have, load / unload, the hotswap switch, LM Studio's context length
 *   - "llama.cpp engine": install the engine, presets (a model file + its settings), start / stop
 *   - "Hugging Face": search, check that a model fits, download into the models folder
 * Everything binds to the engine's control channels (`local-models-*`, `local-engine-*`, `hf-*`).
 */

/** Each backend's name in the catalogue. */
const BACKEND_KEY: Record<LocalBackend, MessageKey> = {
  lmstudio: 'localmodels.backend.lmstudio',
  llamacpp: 'localmodels.backend.llamacpp'
}

/** Numbers read the way the language writes them: 8,192 in English, 8 192 in French. */
const num = (value: number): string => value.toLocaleString(dateLocale())

export function LocalModelsSection() {
  const { t } = useT()

  return (
    <>
      <SectionTitle title={t('localmodels.title')} subtitle={t('localmodels.subtitle')} />
      <ModelsInMemory />
      <EngineBlock />
      <HuggingFaceBlock />
    </>
  )
}

function ModelsInMemory() {
  const { t } = useT()
  const view = useBackendData(() => jarod<LocalModelsView>('local-models-list'))
  const [activity, setActivity] = useState<LocalModelActivity | null>(null)
  const reload = view.reload

  useEffect(
    () =>
      onJarodEvent('local-models-activity', (...args) => {
        const a = args[0] as LocalModelActivity | undefined

        if (!a) {
          return
        }

        setActivity(a)

        if (a.phase !== 'start') {
          reload()
        }
      }),
    [reload]
  )

  if (isUnsupported(view.error)) {
    return <InlineNote tone="info">{t('localmodels.needEngine')}</InlineNote>
  }

  const data = view.data

  return (
    <>
      {view.error && <InlineNote tone="danger">{t('localmodels.readFailed', { error: view.error })}</InlineNote>}
      {activity && <ActivityNote activity={activity} />}
      {data && (
        <SettingsGroup title={t('localmodels.loadingGroup')}>
          <HotswapRow hotswap={data.hotswap} onChanged={reload} />
          <IdleUnloadRow minutes={data.idleUnloadMinutes ?? 0} onChanged={reload} />
        </SettingsGroup>
      )}
      {data &&
        (Object.keys(BACKEND_KEY) as LocalBackend[]).filter(backend => backend !== 'llamacpp' || data.backends.llamacpp.available).map(backend => (
          <BackendGroup key={backend} backend={backend} view={data.backends[backend]} onChanged={reload} />
        ))}
      {view.loading && !data && <div className="px-1 text-[12px] text-fg-4">{t('localmodels.looking')}</div>}
    </>
  )
}

function ActivityNote({ activity }: { activity: LocalModelActivity }) {
  const { t } = useT()
  const load = activity.action === 'load'

  if (activity.phase === 'start') {
    return <InlineNote tone="info">{t(load ? 'localmodels.start.load' : 'localmodels.start.unload', { model: activity.model })}</InlineNote>
  }

  if (activity.phase === 'error') {
    return (
      <InlineNote tone="danger">
        {t(load ? 'localmodels.failed.load' : 'localmodels.failed.unload', { model: activity.model, error: activity.error ?? t('localmodels.unknownError') })}
      </InlineNote>
    )
  }

  const duration = activity.durationMs === undefined ? '' : t('localmodels.activity.in', { duration: formatDuration(activity.durationMs) })

  if (!load && activity.reason === 'inactivité') {
    return <InlineNote tone="info">{t('localmodels.done.unloadIdle', { model: activity.model })}</InlineNote>
  }

  return <InlineNote tone="info">{t(load ? 'localmodels.done.load' : 'localmodels.done.unload', { model: activity.model, duration })}</InlineNote>
}

/** « Unload after inactivity »: the delay after which Jarod unloads a chat model it loaded and nobody uses (never during a response). */
function IdleUnloadRow({ minutes, onChanged }: { minutes: number; onChanged: () => void }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)

  const set = async (value: number) => {
    setBusy(true)

    try {
      await jarod('local-models-configure', { idleUnloadMinutes: value })
      markSaved()
      onChanged()
    } catch (error) {
      notify({ title: t('localmodels.idleFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow icon={<IconClockPause />} label={t('localmodels.idle')} description={t('localmodels.idle.hint')} keywords="idle inactivity unload memory vram ttl inactivité décharger">
      <select
        value={minutes}
        disabled={busy}
        onChange={event => void set(Number(event.target.value))}
        aria-label={t('localmodels.idle')}
        style={{ colorScheme: 'dark' }}
        className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none"
      >
        {idleUnloadOptions(minutes).map(option => (
          <option key={option} value={option}>
            {idleUnloadLabel(option)}
          </option>
        ))}
      </select>
    </SettingsRow>
  )
}

function HotswapRow({ hotswap, onChanged }: { hotswap: boolean; onChanged: () => void }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)

  const set = async (value: boolean) => {
    setBusy(true)

    try {
      await jarod('local-models-configure', { hotswap: value })
      markSaved()
      onChanged()
    } catch (error) {
      notify({ title: t('localmodels.hotswapFailed'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow icon={<IconRefresh />} label={t('localmodels.hotswap')} description={t('localmodels.hotswap.hint')} keywords="hotswap memory vram swap">
      <Toggle checked={hotswap} onChange={value => void set(value)} label={t('localmodels.hotswap.toggle')} disabled={busy} />
    </SettingsRow>
  )
}

function BackendGroup({ backend, view, onChanged }: { backend: LocalBackend; view: LocalModelsView['backends'][LocalBackend]; onChanged: () => void }) {
  const { t } = useT()

  return (
    <SettingsGroup title={t(BACKEND_KEY[backend])}>
      {!view.available && (
        <SettingsRow icon={<IconServer />} label={backend === 'lmstudio' ? t('localmodels.notAnswering') : t('localmodels.notSetUp')} description={view.reason ?? t('localmodels.nothingToLoad')} keywords={`${backend} unavailable`} />
      )}
      {view.available && view.models.length === 0 && <SettingsRow icon={<IconServer />} label={t('localmodels.noModels')} description={backend === 'lmstudio' ? t('localmodels.downloadFirst') : t('localmodels.addBelow')} keywords={`${backend} models empty`} />}
      {view.foreign && <InlineNote tone="info">{t('localmodels.foreign')}</InlineNote>}
      {view.models.map(model => (
        <ModelRow key={model.id} backend={backend} model={model} onChanged={onChanged} />
      ))}
    </SettingsGroup>
  )
}

const OWNER_LABEL = { jarod: 'localmodels.owner.jarod', incertaine: 'localmodels.owner.incertaine', externe: 'localmodels.owner.externe' } as const
const OWNER_HINT = { jarod: 'localmodels.owner.jarod.hint', incertaine: 'localmodels.owner.incertaine.hint', externe: 'localmodels.owner.externe.hint' } as const

function ModelRow({ backend, model, onChanged }: { backend: LocalBackend; model: LocalModelEntry; onChanged: () => void }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [ctx, setCtx] = useState('')
  const problem = editing ? contextProblem(ctx, { allowEmpty: true, max: model.maxContext }) : null
  const advice = model.loaded ? contextAdvice(model.loadedContext) : null

  const run = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, body: model.name, level: 'success' })
      onChanged()
    } catch (error) {
      notify({ title: t('localmodels.updateFailed', { name: model.name }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const description = [
    model.kind === 'embedding' ? t('localmodels.kind.embedding') : t('localmodels.kind.chat'),
    formatBytes(model.sizeBytes),
    model.loaded && model.loadedContext
      ? t('localmodels.inMemory', { tokens: num(model.loadedContext) })
      : model.contextLength
        ? t('localmodels.loadsWith', { tokens: num(model.contextLength) })
        : null,
    model.loadable ? null : t('localmodels.notLoadable')
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <SettingsRow
      icon={<IconBrain />}
      label={model.name}
      description={description}
      keywords={`${backend} model ${model.model} ${model.kind}`}
      below={
        <>
          {advice && <InlineNote tone="warn">{advice}</InlineNote>}
          {editing && (
            <form
              className="flex flex-col gap-2 pt-1"
              onSubmit={event => {
                event.preventDefault()

                if (!problem) {
                  void run(t('localmodels.contextSaved'), () => jarod('local-models-configure', { contextLength: { model: model.id, tokens: ctx.trim() ? Number(ctx.trim()) : null } })).then(() => setEditing(false))
                }
              }}
            >
              <label className="glass-input flex h-9 items-center gap-2 rounded-lg px-3">
                <span className="sr-only">{t('localmodels.contextOf', { name: model.name })}</span>
                <input autoFocus value={ctx} onChange={event => setCtx(event.target.value)} inputMode="numeric" placeholder={model.maxContext ? t('localmodels.context.placeholderUpTo', { max: num(model.maxContext) }) : t('localmodels.context.placeholder')} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4" />
              </label>
              {problem && <InlineNote tone="warn">{problem}</InlineNote>}
              <div className="text-[11.5px] text-fg-4">{t('localmodels.context.hint')}</div>
              <div className="flex justify-end gap-2">
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  {t('localmodels.cancel')}
                </GlassButton>
                <GlassButton type="submit" size="sm" variant="primary" disabled={busy || Boolean(problem)}>
                  {t('localmodels.save')}
                </GlassButton>
              </div>
            </form>
          )}
        </>
      }
    >
      {model.loaded && (
        <Pill tone="ok" dot>
          {t('localmodels.loaded')}
        </Pill>
      )}
      {model.loaded && model.owner && (
        <span title={t(OWNER_HINT[model.owner])} data-testid="model-owner">
          <Pill tone={model.owner === 'jarod' ? 'muted' : 'warn'}>{t(OWNER_LABEL[model.owner])}</Pill>
        </span>
      )}
      {model.loaded && model.owner === 'incertaine' && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('localmodels.adoptedTitle'), () => jarod('local-models-adopt', model.id))} aria-label={t('localmodels.adoptAria', { name: model.name })}>
          {t('localmodels.adopt')}
        </GlassButton>
      )}
      {backend === 'lmstudio' && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => (setCtx(model.contextLength ? String(model.contextLength) : ''), setEditing(true))} aria-label={t('localmodels.contextAria', { name: model.name })}>
          {t('localmodels.context')}
        </GlassButton>
      )}
      {model.loaded ? (
        <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void run(t('localmodels.unloadedTitle'), () => jarod('local-models-unload', backend, model.id))} aria-label={t('localmodels.unloadAria', { name: model.name })}>
          <IconPlayerStop />
          {t('localmodels.unload')}
        </GlassButton>
      ) : (
        <GlassButton size="sm" variant="primary" disabled={busy || !model.loadable} onClick={() => void run(t('localmodels.loaded'), () => jarod('local-models-load', backend, model.id))} aria-label={t('localmodels.loadAria', { name: model.name })}>
          <IconPlayerPlay />
          {t('localmodels.load')}
        </GlassButton>
      )}
    </SettingsRow>
  )
}
