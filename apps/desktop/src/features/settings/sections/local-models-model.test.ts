import { describe, expect, it } from 'vitest'
import { contextAdvice, contextProblem, draftOf, fitSummary, formatBytes, formatCount, formatDuration, hfErrorText, isHfCancelled, percent, presetFromDraft, presetProblems } from './local-models-model.ts'

describe('formatting', () => {
  it('bytes in binary units, one decimal under 100, none above; unknown is a dash', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(4.2 * 1024 ** 3)).toBe('4.2 GB')
    expect(formatBytes(120 * 1024 ** 2)).toBe('120 MB')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })

  it('percent is clamped and safe on an unknown total', () => {
    expect(percent(50, 200)).toBe(25)
    expect(percent(300, 200)).toBe(100)
    expect(percent(5, 0)).toBe(0)
    expect(percent(-5, 10)).toBe(0)
  })

  it('durations and counts read short', () => {
    expect(formatDuration(450)).toBe('450 ms')
    expect(formatDuration(2500)).toBe('2.5 s')
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(undefined)).toBe('')
    expect(formatCount(950)).toBe('950')
    expect(formatCount(12_300)).toBe('12.3k')
    expect(formatCount(2_500_000)).toBe('2.5M')
  })
})

describe('fitSummary', () => {
  const breakdown = { weightsBytes: 4 * 1024 ** 3, kvBytes: 1024 ** 3, stateBytes: 0, headroomBytes: 512 * 1024 ** 2 }

  it('says the verdict, the total memory and the budget when known', () => {
    expect(fitSummary({ fit: { status: 'fits', breakdown }, budgetBytes: 12 * 1024 ** 3 })).toBe('Fits in memory — about 5.5 GB of 12.0 GB (weights 4.0 GB, context 1.0 GB)')
    expect(fitSummary({ fit: { status: 'does-not-fit', breakdown }, budgetBytes: 4 * 1024 ** 3 })).toMatch(/^Does not fit — about 5\.5 GB of 4\.0 GB/)
    expect(fitSummary({ fit: { status: 'estimated', breakdown } })).toMatch(/^Estimated \(memory budget unknown\) — about 5\.5 GB \(/)
  })

  it('without a breakdown, the reason; nothing for nothing', () => {
    expect(fitSummary({ fit: { status: 'not-estimated', reason: 'header unreadable' } })).toBe('Not estimated — header unreadable')
    expect(fitSummary({ fit: { status: 'weird' } })).toBe('weird')
    expect(fitSummary(null)).toBe('')
  })
})

describe('contextProblem', () => {
  it('accepts whole token counts in range, and empty only where allowed', () => {
    expect(contextProblem('16384')).toBeNull()
    expect(contextProblem(' 8192 ')).toBeNull()
    expect(contextProblem('', { allowEmpty: true })).toBeNull()
    expect(contextProblem('')).toMatch(/Enter/)
  })

  it('refuses decimals, text, too small, too large and above the model maximum', () => {
    expect(contextProblem('16k')).toMatch(/Whole number/)
    expect(contextProblem('1.5')).toMatch(/Whole number/)
    expect(contextProblem('-3')).toMatch(/Whole number/)
    expect(contextProblem('511')).toMatch(/At least 512/)
    expect(contextProblem('99999999999')).toMatch(/At most 16,777,216/)
    expect(contextProblem('40000', { max: 32768 })).toMatch(/At most 32,768/)
    expect(contextProblem('32768', { max: 32768 })).toBeNull()
  })
})

describe('contextAdvice', () => {
  it('warns when a loaded context is below what a tool turn needs, not otherwise', () => {
    expect(contextAdvice(8192)).toMatch(/8,192 tokens: too small.*16,384/)
    expect(contextAdvice(16_384)).toBeNull()
    expect(contextAdvice(null)).toBeNull()
  })
})

describe('Hugging Face errors', () => {
  it('drops the code prefix (also behind a transport prefix) and spots a user cancellation', () => {
    expect(hfErrorText('HF_GATED: ce dépôt exige une autorisation')).toBe('ce dépôt exige une autorisation')
    expect(hfErrorText('jarod.invoke -> 400: HF_RATE_LIMITED: réessayez dans 5 s.')).toBe('réessayez dans 5 s.')
    expect(hfErrorText('plain')).toBe('plain')
    expect(isHfCancelled('HF_CANCELLED: téléchargement annulé')).toBe(true)
    expect(isHfCancelled('HF_DECLINED: refusé par l’utilisateur')).toBe(true)
    expect(isHfCancelled('HF_BUSY: un téléchargement est déjà en cours')).toBe(false)
  })
})

describe('preset draft', () => {
  const preset = { id: 'p1', name: 'Qwen', model: 'D:\m\q.gguf', draftModel: '', extraArgs: ['--x'], ctxSize: 16384, gpuLayers: 99, flashAttn: 'auto', cacheType: 'f16', temperature: 0.7, topP: null, topK: 40, minP: null, reasoning: 'auto', parallelSlots: 2, modelName: 'q.gguf', modelPresent: true, draftModelName: '' } as const

  it('round-trips a preset through the draft without touching model, draft model or arguments', () => {
    const draft = draftOf({ ...preset, extraArgs: [...preset.extraArgs] })

    expect(draft).toMatchObject({ name: 'Qwen', ctxSize: '16384', gpuLayers: '99', parallelSlots: '2', temperature: '0.7', topP: '', topK: '40', minP: '' })
    expect(presetProblems(draft)).toEqual([])
    expect(presetFromDraft({ ...preset, extraArgs: ['--x'] }, draft)).toEqual({ ...preset, extraArgs: ['--x'] })
  })

  it('applies edits: trimmed name, numbers, empty optionals become null, empty slots are dropped', () => {
    const draft = { ...draftOf({ ...preset, extraArgs: [] }), name: '  Fast  ', ctxSize: '32768', temperature: '', topK: '', parallelSlots: '', cacheType: 'q8_0' as const }
    const next = presetFromDraft({ ...preset, extraArgs: [] }, draft)

    expect(next).toMatchObject({ name: 'Fast', ctxSize: 32768, temperature: null, topK: null, cacheType: 'q8_0', model: preset.model })
    expect('parallelSlots' in next).toBe(false)
  })

  it('names each refused field, with the same bounds as the engine', () => {
    const draft = { ...draftOf({ ...preset, extraArgs: [] }), name: '', ctxSize: '100', gpuLayers: '1000', parallelSlots: '17', temperature: '6', topP: '1.5', topK: '1001', minP: 'x' }

    expect(presetProblems(draft)).toEqual([
      'Name: 1 to 60 characters.',
      'Context size: a whole number from 512 to 2097152.',
      'GPU layers: a whole number from -1 to 999.',
      'Parallel slots: a whole number from 1 to 16.',
      'Temperature: a number from 0 to 5, or empty.',
      'Top P: a number from 0 to 1, or empty.',
      'Top K: a whole number from 0 to 1000.',
      'Min P: a number from 0 to 1, or empty.'
    ])
    expect(presetProblems({ ...draftOf({ ...preset, extraArgs: [] }), ctxSize: '', gpuLayers: '-1' })).toEqual(['Context size: required.'])
    expect(presetProblems({ ...draftOf({ ...preset, extraArgs: [] }), name: 'x'.repeat(61) })).toEqual(['Name: 1 to 60 characters.'])
  })
})
