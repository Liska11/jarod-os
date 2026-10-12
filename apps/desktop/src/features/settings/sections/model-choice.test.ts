import { describe, expect, it } from 'vitest'
import { modelButtonLabel, shortModel } from './model-choice.ts'

describe('modelButtonLabel', () => {
  it('invites a profile that never chose to choose, instead of showing a default nobody picked', () => {
    expect(modelButtonLabel({ provider: '', model: '', needs_choice: true }, { provider: 'anthropic', model: 'claude-opus-5' })).toBe('Choose a model')
  })

  it('shows provider · model once chosen, taking the chat as a fallback when the engine says nothing', () => {
    expect(modelButtonLabel({ provider: 'lmstudio', model: 'qwen3-8b' }, null)).toBe('lmstudio · qwen3-8b')
    expect(modelButtonLabel(null, { provider: 'ollama', model: 'a/b' })).toBe('ollama · b')
    expect(modelButtonLabel({ provider: '', model: '' }, null)).toBe('Hermes · Automatic')
  })
})

describe('shortModel', () => {
  it('drops a routing prefix and names an empty model Automatic', () => {
    expect(shortModel('openrouter/x-ai/grok')).toBe('x-ai/grok')
    expect(shortModel(undefined)).toBe('Automatic')
  })
})
