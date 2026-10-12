import { IconDownload, IconFileImport, IconPlayerPlay, IconPlayerStop, IconSettings, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, ProgressBar, Toggle } from '../../../components/ui/glass.tsx'
import { jarod, onJarodEvent } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { draftOf, type EnginePreset, type EngineProgress, type EngineView, type FitView, fitSummary, formatBytes, percent, type PresetDraft, presetFromDraft, presetProblems } from './local-models-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * llama.cpp engine: Jarod can run its own llama.cpp server. Install it, add a model file as a preset (the file, its context size, GPU layers…), start it.
 * The engine refuses what could widen the server's reach: paths come from the OS file dialog only, and advanced arguments can be kept or cleared, never typed.
 */

export function EngineBlock() {
  const engine = useBackendData(() => jarod<EngineView>('local-engine-status'))
  const [progress, setProgress] = useState<EngineProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const reload = engine.reload

  useEffect(() => onJarodEvent('local-engine-progress', (...args) => setProgress((args[0] as EngineProgress | undefined) ?? null)), [])

  if (isUnsupported(engine.error)) {
    return null
  }

  const data = engine.data

  const run = async (key: string, title: string, action: () => Promise<unknown>) => {
    setBusy(key)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
    } catch (error) {
      notify({ title: 'llama.cpp engine', body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
      setProgress(null)
      reload()
    }
  }

  if (!data) {
    return engine.error ? <InlineNote tone="danger">Could not read the engine: {engine.error}</InlineNote> : null
  }

  const installing = busy === 'install' || data.installing
  const server = data.server

  return (
    <>
      <SettingsGroup title="llama.cpp engine">
        <SettingsRow
          icon={<IconDownload />}
          label={data.installed ? `Installed: ${data.installed.tag} (${data.installed.backend})` : 'Not installed'}
          description={
            data.installed && !data.installed.present
              ? 'The engine files are missing. Install it again.'
              : `Jarod downloads the official llama.cpp build for ${data.backend || data.detectedBackend} from github.com/ggml-org/llama.cpp and checks its SHA-256 when GitHub publishes one.`
          }
          keywords="llama.cpp engine install update download"
          below={installing && <EngineProgressBar progress={progress} />}
        >
          {installing ? (
            <GlassButton size="sm" variant="secondary" onClick={() => void jarod('local-engine-install-cancel')}>
              Cancel
            </GlassButton>
          ) : (
            <GlassButton size="sm" variant={data.installed ? 'secondary' : 'primary'} disabled={Boolean(busy)} onClick={() => void run('install', 'Engine installed', () => jarod('local-engine-install'))}>
              {data.installed ? 'Update' : 'Download'}
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconPlayerPlay />} label={server.running ? (server.ready ? `Running on port ${server.port}` : 'Starting…') : 'Server stopped'} description={server.lastError ? `Last error: ${server.lastError}` : server.model ? `Model: ${server.model}` : 'Starts when you load a preset.'} keywords="llama.cpp server running stopped">
          {server.running && (
            <GlassButton size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void run('stop', 'Server stopped', () => jarod('local-engine-stop'))}>
              <IconPlayerStop />
              Stop
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconSettings />} label="Start with Jarod" description="Start the active preset when Jarod opens." keywords="autostart launch llama.cpp">
          <Toggle checked={data.autoStart} label="Start the engine with Jarod" disabled={Boolean(busy) || !data.activePreset} onChange={value => void run('auto', 'Setting saved', () => jarod('local-engine-configure', { autoStart: value }))} />
        </SettingsRow>
        <SettingsRow icon={<IconSettings />} label="This PC" description={`${data.hardware.cpu} · ${data.hardware.ramGb} GB RAM${data.hardware.gpus.length ? ` · ${data.hardware.gpus.map(g => `${g.name}${g.vramGb ? ` ${g.vramGb} GB` : ''}`).join(', ')}` : ''} · memory budget ${data.hardware.budgetGb} GB (${data.hardware.budgetBasis})`} keywords="hardware gpu ram memory budget" />
      </SettingsGroup>

      <SettingsGroup title="Presets">
        {data.presets.length === 0 && <SettingsRow icon={<IconFileImport />} label="No preset yet" description="A preset is a .gguf model file with its settings. Add one to run it with the engine." keywords="preset empty" />}
        {data.presets.map(preset => (
          <PresetRow key={preset.id} preset={preset} active={data.activePreset === preset.id} running={server.running && server.model === preset.name} editing={editing === preset.id} busy={Boolean(busy)} onEdit={open => setEditing(open ? preset.id : null)} run={run} reload={reload} />
        ))}
        <SettingsRow icon={<IconFileImport />} label="Add a model file" description="Pick a .gguf file on this PC." keywords="add preset gguf file">
          <GlassButton size="sm" variant="primary" disabled={Boolean(busy)} onClick={() => void run('add', 'Preset added', () => jarod('local-engine-add-preset'))}>
            Choose file…
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function EngineProgressBar({ progress }: { progress: EngineProgress | null }) {
  const received = progress?.received ?? 0
  const total = progress?.total ?? 0

  return (
    <div className="flex flex-col gap-1">
      <ProgressBar value={percent(received, total)} />
      <div className="text-[11.5px] text-fg-4">
        {progress?.stage ?? 'Working'}
        {total > 0 ? ` · ${formatBytes(received)} of ${formatBytes(total)}` : ''}
      </div>
    </div>
  )
}

type Run = (key: string, title: string, action: () => Promise<unknown>) => Promise<void>

function PresetRow({ preset, active, running, editing, busy, onEdit, run, reload }: { preset: EnginePreset; active: boolean; running: boolean; editing: boolean; busy: boolean; onEdit: (open: boolean) => void; run: Run; reload: () => void }) {
  return (
    <SettingsRow
      icon={<IconPlayerPlay />}
      label={preset.name}
      description={`${preset.modelName}${preset.modelPresent ? '' : ' (file missing)'} · context ${preset.ctxSize.toLocaleString('en-US')} · GPU layers ${preset.gpuLayers}`}
      keywords={`preset ${preset.modelName}`}
      below={editing && <PresetEditor preset={preset} onClose={() => onEdit(false)} run={run} reload={reload} />}
    >
      {running && (
        <Pill tone="ok" dot>
          Running
        </Pill>
      )}
      {!running && active && <Pill tone="info">Active</Pill>}
      <GlassButton size="sm" variant="primary" disabled={busy || !preset.modelPresent} onClick={() => void run(`start-${preset.id}`, `${preset.name} loaded`, () => jarod('local-engine-start', preset.id))} aria-label={`Start ${preset.name}`}>
        Start
      </GlassButton>
      <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(!editing)} aria-label={`Edit ${preset.name}`}>
        Edit
      </GlassButton>
      <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(`rm-${preset.id}`, 'Preset removed', () => jarod('local-engine-preset-remove', preset.id))} aria-label={`Remove ${preset.name}`}>
        <IconTrash />
      </GlassButton>
    </SettingsRow>
  )
}

const SELECTS = {
  flashAttn: ['auto', 'on', 'off'],
  cacheType: ['f16', 'q8_0', 'q4_0'],
  reasoning: ['auto', 'on', 'off', 'deepseek']
} as const

function PresetEditor({ preset, onClose, run, reload }: { preset: EnginePreset; onClose: () => void; run: Run; reload: () => void }) {
  const [draft, setDraft] = useState<PresetDraft>(() => draftOf(preset))
  const [fit, setFit] = useState<FitView | null>(null)
  const [fitting, setFitting] = useState(false)
  const problems = presetProblems(draft)
  const set = <K extends keyof PresetDraft>(key: K, value: PresetDraft[K]) => setDraft(current => ({ ...current, [key]: value }))

  const check = async () => {
    setFitting(true)
    setFit(null)

    try {
      setFit(await jarod<FitView>('local-engine-fit', { id: preset.id, ctxSize: Number(draft.ctxSize), gpuLayers: Number(draft.gpuLayers), cacheType: draft.cacheType, parallelSlots: draft.parallelSlots.trim() ? Number(draft.parallelSlots) : null }))
    } catch (error) {
      notify({ title: 'Could not estimate memory', body: errorText(error), level: 'error' })
    } finally {
      setFitting(false)
    }
  }

  const field = (key: 'name' | 'ctxSize' | 'gpuLayers' | 'parallelSlots' | 'temperature' | 'topP' | 'topK' | 'minP', label: string, placeholder = '') => (
    <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
      {label}
      <input value={draft[key]} onChange={event => set(key, event.target.value)} placeholder={placeholder} spellCheck={false} className="glass-input h-8 rounded-lg px-2.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-4" />
    </label>
  )

  const select = (key: keyof typeof SELECTS, label: string) => (
    <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
      {label}
      <select value={draft[key]} onChange={event => set(key, event.target.value as never)} style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
        {SELECTS[key].map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <form
      className="flex flex-col gap-3 pt-1"
      onSubmit={event => {
        event.preventDefault()

        if (problems.length === 0) {
          void run(`save-${preset.id}`, 'Preset saved', () => jarod('local-engine-preset-save', presetFromDraft(preset, draft))).then(onClose)
        }
      }}
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {field('name', 'Name')}
        {field('ctxSize', 'Context size (tokens)')}
        {field('gpuLayers', 'GPU layers (-1 = all)')}
        {field('parallelSlots', 'Parallel slots', 'default')}
        {select('flashAttn', 'Flash attention')}
        {select('cacheType', 'Context cache type')}
        {select('reasoning', 'Reasoning')}
        <span />
        {field('temperature', 'Temperature', 'default')}
        {field('topP', 'Top P', 'default')}
        {field('topK', 'Top K', 'default')}
        {field('minP', 'Min P', 'default')}
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
        <span className="min-w-0 flex-1 truncate" title={preset.model}>
          Model file: {preset.modelName}
        </span>
        <GlassButton type="button" size="sm" variant="ghost" onClick={() => void run(`pick-${preset.id}`, 'Model file changed', () => jarod('local-engine-pick-model', preset.id, 'model')).then(reload)}>
          Choose another…
        </GlassButton>
      </div>
      {preset.extraArgs.length > 0 && (
        <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
          <span className="min-w-0 flex-1 truncate">Advanced arguments kept as they are: {preset.extraArgs.join(' ')}</span>
        </div>
      )}
      {problems.length > 0 && (
        <InlineNote tone="warn">
          {problems.map(problem => (
            <div key={problem}>{problem}</div>
          ))}
        </InlineNote>
      )}
      {fit && <InlineNote tone={fit.fit.status === 'does-not-fit' ? 'warn' : 'info'}>{fitSummary(fit)}</InlineNote>}
      <div className="flex justify-end gap-2">
        <GlassButton type="button" size="sm" variant="ghost" disabled={fitting || problems.length > 0} onClick={() => void check()}>
          {fitting ? 'Estimating…' : 'Will it fit?'}
        </GlassButton>
        <GlassButton type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={problems.length > 0}>
          Save
        </GlassButton>
      </div>
    </form>
  )
}
