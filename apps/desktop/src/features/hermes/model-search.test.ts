import { describe, expect, it } from 'vitest'
import { firstMatch, searchModels } from './model-search.ts'

const providers = [
  { slug: 'google', name: 'Google Gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.8-pro', 'text-embedding-004'] },
  { slug: 'groq', name: 'Groq', models: ['llama-3.3-70b', 'whisper-large-v3-turbo'] },
  { slug: 'qwen-flash-wsl', name: 'Qwen3.8-Flash-Next (lean-qwenflash, WSL2)', models: ['qwen3.8-flash-next'] }
]

describe('searchModels', () => {
  it('an empty search keeps everything', () => {
    const r = searchModels(providers, '  ')

    expect(r.count).toBe(6)
    expect(r.providers).toHaveLength(3)
  })

  it('every word must match, in any order, over provider name and model', () => {
    expect(searchModels(providers, 'google flash').providers.map(p => p.models)).toEqual([['gemini-3.5-flash-lite']])
    expect(searchModels(providers, 'flash google').count).toBe(1)
    expect(searchModels(providers, 'flash').count).toBe(2)
  })

  it('ignores case and accents, and matches the provider slug too', () => {
    expect(searchModels(providers, 'GÉMINI').count).toBe(3) // « Google Gemini » est le nom du fournisseur : tous ses modèles correspondent
    expect(searchModels(providers, 'LITÉ').providers.map(p => p.models)).toEqual([['gemini-3.5-flash-lite']])
    expect(searchModels(providers, 'groq').providers.map(p => p.slug)).toEqual(['groq'])
  })

  it('no match: no providers, zero count', () => {
    expect(searchModels(providers, 'zzz')).toEqual({ providers: [], count: 0 })
  })
})

describe('firstMatch', () => {
  it('is the first model of the first provider that has one', () => {
    expect(firstMatch(searchModels(providers, 'flash').providers)).toEqual({ slug: 'google', model: 'gemini-3.5-flash-lite' })
    expect(firstMatch([])).toBeNull()
  })
})
