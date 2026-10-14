/*
 * Local models: the data side of the section (no React). Shapes mirror what the Jarod engine's control channels return (`local-models-*`,
 * `local-engine-*`, `hf-*`; see jarod-core/packages/bridge) so a change there shows up here as a type error.
 */

import { t } from '../../../lib/i18n.ts'

export type LocalBackend = 'llamacpp' | 'lmstudio'

export interface LocalModelEntry {
  id: string
  name: string
  model: string
  kind: 'chat' | 'embedding'
  loaded: boolean
  loadable: boolean
  sizeBytes: number | null
  contextLength: number | null
  loadedContext: number | null
  maxContext: number | null
}

export interface LocalBackendView {
  available: boolean
  reason: string | null
  models: LocalModelEntry[]
}

export interface LocalModelsView {
  hotswap: boolean
  backends: Record<LocalBackend, LocalBackendView>
}

export interface LocalModelActivity {
  id: number
  action: 'load' | 'unload'
  phase: 'start' | 'done' | 'error'
  backend: LocalBackend
  model: string
  at: number
  durationMs?: number
  error?: string
}

export interface EnginePreset {
  id: string
  name: string
  model: string
  draftModel: string
  extraArgs: string[]
  ctxSize: number
  gpuLayers: number
  flashAttn: 'auto' | 'on' | 'off'
  cacheType: 'f16' | 'q8_0' | 'q4_0'
  temperature: number | null
  topP: number | null
  topK: number | null
  minP: number | null
  reasoning: 'auto' | 'on' | 'off' | 'deepseek'
  parallelSlots?: number
  modelName: string
  modelPresent: boolean
  draftModelName: string
}

export interface EngineView {
  installed: { tag: string; backend: string; at: number; present: boolean } | null
  installing: boolean
  backend: string
  detectedBackend: string
  port: number
  autoStart: boolean
  activePreset: string
  presets: EnginePreset[]
  server: { running: boolean; ready: boolean; port: number | null; model: string | null; restarts: number; lastError: string | null }
  logs: string[]
  hardware: { cpu: string; ramGb: number; gpus: { name: string; vramGb: number | null; kind: string }[]; budgetGb: number; budgetBasis: string }
}

export interface EngineProgress {
  stage?: string
  received?: number
  total?: number
  [key: string]: unknown
}

export interface FitView {
  fit: { status: string; reason?: string; breakdown?: { weightsBytes: number; kvBytes: number; stateBytes: number; headroomBytes: number }; contextTokens?: number }
  maxContext?: { tokens?: number } | null
  budgetBytes?: number
}

export interface HfSearchRow {
  id: string
  downloads: number
  likes: number
}

export interface HfEntryView {
  key: string
  totalBytes: number
  shardCount: number
  complete: boolean
  missing: string[]
  projector: boolean
  analyzed: boolean
}

export interface HfRepoView {
  repo: string
  sha: string
  gated: false | string
  license: string | null
  truncated: boolean
  entries: HfEntryView[]
}

export interface HfProgress {
  file: string
  index: number
  count: number
  received: number
  total: number
  stage: string
}

export interface HfFitEntry {
  key: string
  state: 'checked' | 'not-checked' | 'not-read'
  report?: FitView
  reason?: string
}

// ---- formatting ----------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`
}

export function percent(received: number, total: number): number {
  if (!(total > 0)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round((received / total) * 100)))
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return ''
  }

  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

export function formatCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const FIT_KEY: Record<string, 'local.fit.fits' | 'local.fit.doesNotFit' | 'local.fit.estimated' | 'local.fit.beyondNative' | 'local.fit.notEstimated'> = {
  fits: 'local.fit.fits',
  'does-not-fit': 'local.fit.doesNotFit',
  estimated: 'local.fit.estimated',
  'beyond-native-context': 'local.fit.beyondNative',
  'not-estimated': 'local.fit.notEstimated'
}

/** One line for a "does it fit?" report: the verdict, then the memory it would take when known. An indication, never a blocker. */
export function fitSummary(view: FitView | undefined | null): string {
  if (!view) {
    return ''
  }

  const key = FIT_KEY[view.fit.status]
  const label = key ? t(key) : view.fit.status
  const b = view.fit.breakdown

  if (!b) {
    return view.fit.reason ? t('local.fit.reason', { label, reason: view.fit.reason }) : label
  }

  const total = b.weightsBytes + b.kvBytes + b.stateBytes + b.headroomBytes
  const budget = view.budgetBytes ? t('local.fit.budgetOf', { budget: formatBytes(view.budgetBytes) }) : ''

  return t('local.fit.about', { label, total: formatBytes(total), budget, weights: formatBytes(b.weightsBytes), context: formatBytes(b.kvBytes) })
}

// ---- validation (mirrors the engine; the engine stays the authority) ------------------------

export const MIN_CONTEXT = 512
export const MAX_CONTEXT = 16_777_216

/** Why a context length is refused, or null. Empty means "the server's own default" and is fine where `allowEmpty`. */
export function contextProblem(text: string, options: { allowEmpty?: boolean; max?: number | null } = {}): string | null {
  const value = text.trim()

  if (!value) {
    return options.allowEmpty ? null : t('local.ctx.required')
  }

  if (!/^\d+$/.test(value)) {
    return t('local.ctx.integer')
  }

  const n = Number(value)

  if (n < MIN_CONTEXT) {
    return t('local.ctx.min', { min: MIN_CONTEXT })
  }

  if (n > MAX_CONTEXT || (options.max && n > options.max)) {
    return t('local.ctx.max', { max: (options.max && options.max < MAX_CONTEXT ? options.max : MAX_CONTEXT).toLocaleString('en-US') })
  }

  return null
}

/** A chat model needs room for the agent's tool list; warn (not block) when the loaded context is below what a tool turn needs. */
export const TOOL_TURN_CONTEXT = 16_384

export function contextAdvice(loadedContext: number | null): string | null {
  return loadedContext !== null && loadedContext < TOOL_TURN_CONTEXT ? t('local.ctx.advice', { loaded: loadedContext.toLocaleString('en-US'), min: TOOL_TURN_CONTEXT.toLocaleString('en-US') }) : null
}

/** A Hugging Face error from the engine starts with `HF_<CODE>: `; show the sentence, not the code. */
export function hfErrorText(message: string): string {
  return message.replace(/^.*?HF_[A-Z_]+:\s*/, '')
}

export function isHfCancelled(message: string): boolean {
  return /HF_CANCELLED|HF_DECLINED/.test(message)
}

// ---- engine presets: the editor's draft ----------------------------------------------------

/** What the preset editor holds while typing: every number as text, so an empty or half-typed field is not lost. */
export interface PresetDraft {
  name: string
  ctxSize: string
  gpuLayers: string
  parallelSlots: string
  flashAttn: EnginePreset['flashAttn']
  cacheType: EnginePreset['cacheType']
  reasoning: EnginePreset['reasoning']
  temperature: string
  topP: string
  topK: string
  minP: string
}

const text = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n))

export function draftOf(preset: EnginePreset): PresetDraft {
  return {
    name: preset.name,
    ctxSize: text(preset.ctxSize),
    gpuLayers: text(preset.gpuLayers),
    parallelSlots: text(preset.parallelSlots),
    flashAttn: preset.flashAttn,
    cacheType: preset.cacheType,
    reasoning: preset.reasoning,
    temperature: text(preset.temperature),
    topP: text(preset.topP),
    topK: text(preset.topK),
    minP: text(preset.minP)
  }
}

const INT = /^-?\d+$/
const NUM = /^\d+(\.\d+)?$/

function intIn(label: string, value: string, min: number, max: number, optional = false): string | null {
  if (!value.trim()) {
    return optional ? null : t('local.field.required', { label })
  }

  const n = Number(value.trim())

  return INT.test(value.trim()) && n >= min && n <= max ? null : t('local.field.intRange', { label, min, max })
}

function numIn(label: string, value: string, max: number): string | null {
  if (!value.trim()) {
    return null
  }

  const n = Number(value.trim())

  return NUM.test(value.trim()) && n >= 0 && n <= max ? null : t('local.field.numRange', { label, max })
}

/** Every reason the draft would be refused (same bounds as the engine), in field order. Empty list = savable. */
export function presetProblems(draft: PresetDraft): string[] {
  const name = draft.name.trim()

  return [
    !name || name.length > 60 ? t('local.preset.nameBad') : null,
    intIn(t('local.field.label.ctx'), draft.ctxSize, 512, 2_097_152),
    intIn(t('local.field.label.gpuLayers'), draft.gpuLayers, -1, 999),
    intIn(t('local.field.label.slots'), draft.parallelSlots, 1, 16, true),
    numIn(t('local.field.label.temperature'), draft.temperature, 5),
    numIn(t('local.field.label.topP'), draft.topP, 1),
    intIn(t('local.field.label.topK'), draft.topK, 0, 1000, true),
    numIn(t('local.field.label.minP'), draft.minP, 1)
  ].filter((p): p is string => p !== null)
}

const optionalNumber = (value: string): number | null => (value.trim() ? Number(value.trim()) : null)

/** The preset to send back: the stored one (model, draft model and arguments untouched: the engine refuses their change) with the draft's settings. */
export function presetFromDraft(preset: EnginePreset, draft: PresetDraft): EnginePreset {
  const next: EnginePreset = {
    ...preset,
    name: draft.name.trim(),
    ctxSize: Number(draft.ctxSize.trim()),
    gpuLayers: Number(draft.gpuLayers.trim()),
    flashAttn: draft.flashAttn,
    cacheType: draft.cacheType,
    reasoning: draft.reasoning,
    temperature: optionalNumber(draft.temperature),
    topP: optionalNumber(draft.topP),
    topK: optionalNumber(draft.topK),
    minP: optionalNumber(draft.minP)
  }

  const slots = optionalNumber(draft.parallelSlots)

  if (slots === null) {
    delete next.parallelSlots
  } else {
    next.parallelSlots = slots
  }

  return next
}
