import { IconBrain, IconPlayerPlay, IconPlayerStop, IconRefresh, IconServer } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod, onJarodEvent } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { EngineBlock } from './LocalEngineBlock.tsx'
import { HuggingFaceBlock } from './HuggingFaceBlock.tsx'
import { contextAdvice, contextProblem, formatBytes, formatDuration, type LocalBackend, type LocalModelActivity, type LocalModelEntry, type LocalModelsView } from './local-models-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Local models: what is in memory on this PC and the means to put models there.
 *   - "In memory": the models LM Studio and Jarod's own llama.cpp engine have, load / unload, the hotswap switch, LM Studio's context length
 *   - "llama.cpp engine": install the engine, presets (a model file + its settings), start / stop
 *   - "Hugging Face": search, check that a model fits, download into the models folder
 * Everything binds to the engine's control channels (`local-models-*`, `local-engine-*`, `hf-*`).
 */

const BACKEND_TITLE: Record<LocalBackend, string> = { lmstudio: 'LM Studio', llamacpp: 'llama.cpp (Jarod’s engine)' }

export function LocalModelsSection() {
  return (
    <>
      <SectionTitle title="Local models" subtitle="Run models on this PC: what is loaded, the llama.cpp engine, and models to download." />
      <ModelsInMemory />
      <EngineBlock />
      <HuggingFaceBlock />
    </>
  )
}

function ModelsInMemory() {
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
    return <InlineNote tone="info">Local models need the Jarod engine.</InlineNote>
  }

  const data = view.data

  return (
    <>
      {view.error && <InlineNote tone="danger">Could not read the local models: {view.error}</InlineNote>}
      {activity && <ActivityNote activity={activity} />}
      {data && (
        <SettingsGroup title="Loading">
          <HotswapRow hotswap={data.hotswap} onChanged={reload} />
        </SettingsGroup>
      )}
      {data &&
        (Object.keys(BACKEND_TITLE) as LocalBackend[]).map(backend => (
          <BackendGroup key={backend} backend={backend} view={data.backends[backend]} onChanged={reload} />
        ))}
      {view.loading && !data && <div className="px-1 text-[12px] text-fg-4">Looking at what is loaded…</div>}
    </>
  )
}

function ActivityNote({ activity }: { activity: LocalModelActivity }) {
  const verb = activity.action === 'load' ? 'Loading' : 'Unloading'

  if (activity.phase === 'start') {
    return <InlineNote tone="info">{verb} {activity.model}…</InlineNote>
  }

  if (activity.phase === 'error') {
    return <InlineNote tone="danger">{verb} {activity.model} failed: {activity.error ?? 'unknown error'}</InlineNote>
  }

  return <InlineNote tone="info">{activity.model} {activity.action === 'load' ? 'loaded' : 'unloaded'}{activity.durationMs !== undefined ? ` in ${formatDuration(activity.durationMs)}` : ''}.</InlineNote>
}

function HotswapRow({ hotswap, onChanged }: { hotswap: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)

  const set = async (value: boolean) => {
    setBusy(true)

    try {
      await jarod('local-models-configure', { hotswap: value })
      markSaved()
      onChanged()
    } catch (error) {
      notify({ title: 'Could not change hotswap', body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow icon={<IconRefresh />} label="One chat model at a time (hotswap)" description="Picking a local model in the chat loads it and unloads the other chat models, so they do not fight for memory. Models used for document search stay loaded." keywords="hotswap memory vram swap">
      <Toggle checked={hotswap} onChange={value => void set(value)} label="Hotswap" disabled={busy} />
    </SettingsRow>
  )
}

function BackendGroup({ backend, view, onChanged }: { backend: LocalBackend; view: LocalModelsView['backends'][LocalBackend]; onChanged: () => void }) {
  return (
    <SettingsGroup title={BACKEND_TITLE[backend]}>
      {!view.available && (
        <SettingsRow icon={<IconServer />} label={backend === 'lmstudio' ? 'LM Studio is not answering' : 'The llama.cpp engine is not set up'} description={view.reason ?? 'Nothing to load.'} keywords={`${backend} unavailable`} />
      )}
      {view.available && view.models.length === 0 && <SettingsRow icon={<IconServer />} label="No models" description={backend === 'lmstudio' ? 'Download a model in LM Studio first.' : 'Add a model file below.'} keywords={`${backend} models empty`} />}
      {view.models.map(model => (
        <ModelRow key={model.id} backend={backend} model={model} onChanged={onChanged} />
      ))}
    </SettingsGroup>
  )
}

function ModelRow({ backend, model, onChanged }: { backend: LocalBackend; model: LocalModelEntry; onChanged: () => void }) {
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
      notify({ title: `Could not update ${model.name}`, body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const description = [
    model.kind === 'embedding' ? 'document search' : 'chat',
    formatBytes(model.sizeBytes),
    model.loaded && model.loadedContext ? `in memory with ${model.loadedContext.toLocaleString('en-US')} tokens` : model.contextLength ? `loads with ${model.contextLength.toLocaleString('en-US')} tokens` : null,
    model.loadable ? null : 'cannot be loaded as is'
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
                  void run('Context length saved', () => jarod('local-models-configure', { contextLength: { model: model.id, tokens: ctx.trim() ? Number(ctx.trim()) : null } })).then(() => setEditing(false))
                }
              }}
            >
              <label className="glass-input flex h-9 items-center gap-2 rounded-lg px-3">
                <span className="sr-only">Context length of {model.name}</span>
                <input autoFocus value={ctx} onChange={event => setCtx(event.target.value)} inputMode="numeric" placeholder={model.maxContext ? `LM Studio default · up to ${model.maxContext.toLocaleString('en-US')}` : 'LM Studio default'} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4" />
              </label>
              {problem && <InlineNote tone="warn">{problem}</InlineNote>}
              <div className="text-[11.5px] text-fg-4">A model already in memory keeps its old context: unload it, then load it again.</div>
              <div className="flex justify-end gap-2">
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </GlassButton>
                <GlassButton type="submit" size="sm" variant="primary" disabled={busy || Boolean(problem)}>
                  Save
                </GlassButton>
              </div>
            </form>
          )}
        </>
      }
    >
      {model.loaded && (
        <Pill tone="ok" dot>
          Loaded
        </Pill>
      )}
      {backend === 'lmstudio' && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => (setCtx(model.contextLength ? String(model.contextLength) : ''), setEditing(true))} aria-label={`Set the context length of ${model.name}`}>
          Context
        </GlassButton>
      )}
      {model.loaded ? (
        <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void run('Unloaded', () => jarod('local-models-unload', backend, model.id))} aria-label={`Unload ${model.name}`}>
          <IconPlayerStop />
          Unload
        </GlassButton>
      ) : (
        <GlassButton size="sm" variant="primary" disabled={busy || !model.loadable} onClick={() => void run('Loaded', () => jarod('local-models-load', backend, model.id))} aria-label={`Load ${model.name}`}>
          <IconPlayerPlay />
          Load
        </GlassButton>
      )}
    </SettingsRow>
  )
}
