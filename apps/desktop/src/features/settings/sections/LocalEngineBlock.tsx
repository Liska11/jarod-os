import { IconDownload, IconFileImport, IconPlayerPlay, IconPlayerStop, IconSettings, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, ProgressBar, Toggle } from '../../../components/ui/glass.tsx'
import { jarod, onJarodEvent } from '../../../lib/jarod.ts'
import { useT } from '../../../lib/i18n.ts'
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
  const { t } = useT()
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
      notify({ title: t('engine.notify'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
      setProgress(null)
      reload()
    }
  }

  if (!data) {
    return engine.error ? <InlineNote tone="danger">{t('engine.readFailed', { error: engine.error })}</InlineNote> : null
  }

  const installing = busy === 'install' || data.installing
  const server = data.server

  return (
    <>
      <SettingsGroup title={t('engine.group')}>
        <SettingsRow
          icon={<IconDownload />}
          label={data.installed ? t('engine.installed', { tag: data.installed.tag, backend: data.installed.backend }) : t('engine.notInstalled')}
          description={
            data.installed && !data.installed.present
              ? t('engine.missingFiles')
              : t('engine.downloadHint', { backend: data.backend || data.detectedBackend })
          }
          keywords="llama.cpp engine install update download"
          below={installing && <EngineProgressBar progress={progress} />}
        >
          {installing ? (
            <GlassButton size="sm" variant="secondary" onClick={() => void jarod('local-engine-install-cancel')}>
              {t('engine.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" variant={data.installed ? 'secondary' : 'primary'} disabled={Boolean(busy)} onClick={() => void run('install', t('engine.installedTitle'), () => jarod('local-engine-install'))}>
              {data.installed ? t('engine.update') : t('engine.download')}
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconPlayerPlay />} label={server.running ? (server.ready ? t('engine.runningPort', { port: server.port ?? '' }) : t('engine.starting')) : t('engine.stopped')} description={server.lastError ? t('engine.lastError', { error: server.lastError }) : server.model ? t('engine.model', { model: server.model }) : t('engine.startsOnPreset')} keywords="llama.cpp server running stopped">
          {server.running && (
            <GlassButton size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void run('stop', t('engine.stopTitle'), () => jarod('local-engine-stop'))}>
              <IconPlayerStop />
              {t('engine.stop')}
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconSettings />} label={t('engine.autostart')} description={t('engine.autostart.hint')} keywords="autostart launch llama.cpp">
          <Toggle checked={data.autoStart} label={t('engine.autostart.toggle')} disabled={Boolean(busy) || !data.activePreset} onChange={value => void run('auto', t('engine.saved'), () => jarod('local-engine-configure', { autoStart: value }))} />
        </SettingsRow>
        <SettingsRow icon={<IconSettings />} label={t('engine.thisPc')} description={t('engine.hardware', { cpu: data.hardware.cpu, ram: data.hardware.ramGb, gpus: data.hardware.gpus.length ? t('engine.gpus', { list: data.hardware.gpus.map(g => (g.vramGb ? t('engine.gpuVram', { name: g.name, vram: g.vramGb }) : g.name)).join(', ') }) : '', budget: data.hardware.budgetGb, basis: data.hardware.budgetBasis })} keywords="hardware gpu ram memory budget" />
      </SettingsGroup>

      <SettingsGroup title={t('engine.presets')}>
        {data.presets.length === 0 && <SettingsRow icon={<IconFileImport />} label={t('engine.noPreset')} description={t('engine.noPreset.hint')} keywords="preset empty" />}
        {data.presets.map(preset => (
          <PresetRow key={preset.id} preset={preset} active={data.activePreset === preset.id} running={server.running && server.model === preset.name} editing={editing === preset.id} busy={Boolean(busy)} onEdit={open => setEditing(open ? preset.id : null)} run={run} reload={reload} />
        ))}
        <SettingsRow icon={<IconFileImport />} label={t('engine.addFile')} description={t('engine.addFile.hint')} keywords="add preset gguf file">
          <GlassButton size="sm" variant="primary" disabled={Boolean(busy)} onClick={() => void run('add', t('engine.presetAdded'), () => jarod('local-engine-add-preset'))}>
            {t('engine.chooseFile')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function EngineProgressBar({ progress }: { progress: EngineProgress | null }) {
  const { t } = useT()
  const received = progress?.received ?? 0
  const total = progress?.total ?? 0

  return (
    <div className="flex flex-col gap-1">
      <ProgressBar value={percent(received, total)} />
      <div className="text-[11.5px] text-fg-4">
        {progress?.stage ?? t('engine.working')}
        {total > 0 ? t('engine.progressOf', { received: formatBytes(received), total: formatBytes(total) }) : ''}
      </div>
    </div>
  )
}

type Run = (key: string, title: string, action: () => Promise<unknown>) => Promise<void>

function PresetRow({ preset, active, running, editing, busy, onEdit, run, reload }: { preset: EnginePreset; active: boolean; running: boolean; editing: boolean; busy: boolean; onEdit: (open: boolean) => void; run: Run; reload: () => void }) {
  const { t } = useT()

  return (
    <SettingsRow
      icon={<IconPlayerPlay />}
      label={preset.name}
      description={t('engine.presetDetail', { model: preset.modelName, missing: preset.modelPresent ? '' : t('engine.fileMissing'), ctx: preset.ctxSize.toLocaleString('en-US'), layers: preset.gpuLayers })}
      keywords={`preset ${preset.modelName}`}
      below={editing && <PresetEditor preset={preset} onClose={() => onEdit(false)} run={run} reload={reload} />}
    >
      {running && (
        <Pill tone="ok" dot>
          {t('engine.running')}
        </Pill>
      )}
      {!running && active && <Pill tone="info">{t('engine.active')}</Pill>}
      <GlassButton size="sm" variant="primary" disabled={busy || !preset.modelPresent} onClick={() => void run(`start-${preset.id}`, t('engine.loadedTitle', { name: preset.name }), () => jarod('local-engine-start', preset.id))} aria-label={t('engine.startAria', { name: preset.name })}>
        {t('engine.start')}
      </GlassButton>
      <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(!editing)} aria-label={t('engine.editAria', { name: preset.name })}>
        {t('engine.edit')}
      </GlassButton>
      <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(`rm-${preset.id}`, t('engine.removeTitle'), () => jarod('local-engine-preset-remove', preset.id))} aria-label={t('engine.removeAria', { name: preset.name })}>
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
  const { t } = useT()
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
      notify({ title: t('engine.fitFailed'), body: errorText(error), level: 'error' })
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
          void run(`save-${preset.id}`, t('engine.presetSaved'), () => jarod('local-engine-preset-save', presetFromDraft(preset, draft))).then(onClose)
        }
      }}
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {field('name', t('engine.field.name'))}
        {field('ctxSize', t('engine.field.ctx'))}
        {field('gpuLayers', t('engine.field.gpuLayers'))}
        {field('parallelSlots', t('engine.field.slots'), t('engine.optional'))}
        {select('flashAttn', t('engine.field.flashAttn'))}
        {select('cacheType', t('engine.field.cache'))}
        {select('reasoning', t('engine.field.reasoning'))}
        <span />
        {field('temperature', t('engine.field.temperature'), t('engine.optional'))}
        {field('topP', t('engine.field.topP'), t('engine.optional'))}
        {field('topK', t('engine.field.topK'), t('engine.optional'))}
        {field('minP', t('engine.field.minP'), t('engine.optional'))}
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
        <span className="min-w-0 flex-1 truncate" title={preset.model}>
          {t('engine.modelFile', { name: preset.modelName })}
        </span>
        <GlassButton type="button" size="sm" variant="ghost" onClick={() => void run(`pick-${preset.id}`, t('engine.modelChanged'), () => jarod('local-engine-pick-model', preset.id, 'model')).then(reload)}>
          {t('engine.chooseAnother')}
        </GlassButton>
      </div>
      {preset.extraArgs.length > 0 && (
        <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
          <span className="min-w-0 flex-1 truncate">{t('engine.extraArgs', { args: preset.extraArgs.join(' ') })}</span>
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
          {fitting ? t('engine.estimating') : t('engine.willItFit')}
        </GlassButton>
        <GlassButton type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('engine.cancel')}
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={problems.length > 0}>
          {t('engine.save')}
        </GlassButton>
      </div>
    </form>
  )
}
