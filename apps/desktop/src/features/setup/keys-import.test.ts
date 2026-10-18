import { describe, expect, it } from 'vitest'
import { destinationOf, importable, markReplaced, maskValue, parseKeysFile, parseLine } from './keys-import.ts'

const OPENAI = 'sk-abcdefghijklmnopqrstuvwxyz012345'

describe('parseLine', () => {
  it('skips blank lines and comments', () => {
    expect(parseLine('', 1).status).toBe('skipped')
    expect(parseLine('   # my keys', 2).status).toBe('skipped')
    expect(parseLine('// old', 3).status).toBe('skipped')
  })

  it('accepts export, spaces around = and quotes', () => {
    expect(parseLine(`export OPENAI_API_KEY = "${OPENAI}"`, 1)).toMatchObject({ status: 'ok', name: 'OPENAI_API_KEY', value: OPENAI, destination: 'provider' })
    expect(parseLine(`MY_SERVICE='abc123'`, 1)).toMatchObject({ status: 'ok', value: 'abc123', destination: 'vault' })
  })

  it('says why a line is invalid', () => {
    expect(parseLine('OPENAI_API_KEY', 1).problem).toBe('missing-equals')
    expect(parseLine('1BAD=x', 1).problem).toBe('bad-name')
    expect(parseLine('EMPTY=', 1).problem).toBe('empty-value')
    expect(parseLine('A=two words', 1).problem).toBe('spaces')
  })

  it('reads the forms people actually write in a notes file', () => {
    // a colon instead of =, the YAML / notes habit
    expect(parseLine(`OPENAI_API_KEY: ${OPENAI}`, 1)).toMatchObject({ status: 'ok', name: 'OPENAI_API_KEY', value: OPENAI, destination: 'provider' })
    // a colon inside the value is kept (Telegram tokens have one)
    expect(parseLine('TELEGRAM_BOT_TOKEN: 123456789:AAabcdefghijklmnopqrstuvwxyz0123456', 1)).toMatchObject({ status: 'ok', value: '123456789:AAabcdefghijklmnopqrstuvwxyz0123456' })
    // a name written in words, any case, with spaces, dashes or dots
    expect(parseLine(`OpenAI API Key = ${OPENAI}`, 1)).toMatchObject({ status: 'ok', name: 'OPENAI_API_KEY' })
    expect(parseLine(`groq-api-key=gsk_abcdefghijklmnopqrstuvwx`, 1)).toMatchObject({ status: 'ok', name: 'GROQ_API_KEY' })
    // a comment after the key
    expect(parseLine(`OPENAI_API_KEY=${OPENAI}   # personal`, 1)).toMatchObject({ status: 'ok', value: OPENAI })
    // typographic quotes and invisible characters from a copy-paste
    expect(parseLine(`OPENAI_API_KEY=“${OPENAI}”`, 1)).toMatchObject({ status: 'ok', value: OPENAI })
    expect(parseLine(`OPENAI_API_KEY=​${OPENAI}‍`, 1)).toMatchObject({ status: 'ok', value: OPENAI })
    expect(parseLine(`﻿OPENAI_API_KEY=${OPENAI}`, 1)).toMatchObject({ status: 'ok', name: 'OPENAI_API_KEY' })
  })

  it('sends a common nickname of a provider key to that provider, and says so', () => {
    expect(parseLine(`CLAUDE_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz`, 1)).toMatchObject({ status: 'ok', name: 'ANTHROPIC_API_KEY', renamedFrom: 'CLAUDE_API_KEY', destination: 'provider' })
    expect(parseLine(`OPENAI_KEY=${OPENAI}`, 1)).toMatchObject({ name: 'OPENAI_API_KEY', renamedFrom: 'OPENAI_KEY', destination: 'provider' })
    expect(parseLine('GEMINI_API_KEY=AIzaabcdefghijklmnopqrstuvwxyz0123456', 1)).toMatchObject({ status: 'ok', name: 'GOOGLE_API_KEY', destination: 'provider' })
    expect(parseLine('HUGGINGFACE_TOKEN=hf_abcdefghijklmnopqrstuvwx', 1)).toMatchObject({ status: 'ok', name: 'HF_TOKEN' })
    // an exact name is not marked renamed; an unknown name still goes to the vault unchanged
    expect(parseLine(`OPENAI_API_KEY=${OPENAI}`, 1).renamedFrom).toBeUndefined()
    expect(parseLine('GITHUB_TOKEN=ghp_abc', 1)).toMatchObject({ name: 'GITHUB_TOKEN', destination: 'vault' })
  })

  it('still refuses what is not a key line', () => {
    expect(parseLine('broken line', 1).status).toBe('invalid')
    expect(parseLine('Note: rotate these every month', 1)).toMatchObject({ status: 'invalid', problem: 'spaces' })
    expect(parseLine('OPENAI_API_KEY: abc', 1)).toMatchObject({ status: 'invalid', problem: 'format:sk-…' })
  })

  it('checks the shape of well-known services', () => {
    expect(parseLine('OPENAI_API_KEY=abc', 1)).toMatchObject({ status: 'invalid', problem: 'format:sk-…' })
    expect(parseLine('ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz', 1).status).toBe('ok')
    expect(parseLine('TELEGRAM_BOT_TOKEN=123', 1)).toMatchObject({ status: 'invalid', destination: 'messaging' })
  })
})

describe('parseKeysFile', () => {
  it('keeps the last line of a name given twice and marks the earlier one replaced', () => {
    const lines = parseKeysFile(`﻿# keys\r\nOPENAI_API_KEY=${OPENAI}\r\nGROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwx\r\nOPENAI_API_KEY=${OPENAI}9\r\nbroken line\r\n`)
    expect(lines.map(l => l.status)).toEqual(['skipped', 'replaced', 'ok', 'ok', 'invalid', 'skipped'])
    expect(lines[1].problem).toBe('4')
    expect(importable(lines).map(l => `${l.name}@${l.line}`)).toEqual(['GROQ_API_KEY@3', 'OPENAI_API_KEY@4'])
  })
})

describe('destinations and masking', () => {
  it('sends each key where the engine keeps it', () => {
    expect(destinationOf('HF_TOKEN')).toBe('provider')
    expect(destinationOf('SLACK_APP_TOKEN')).toBe('messaging')
    expect(destinationOf('GITHUB_TOKEN')).toBe('vault')
  })

  it('never shows a whole key', () => {
    expect(maskValue(OPENAI)).toBe('sk-a••••••45')
    expect(maskValue('short')).toBe('••••••')
  })
})

describe('markReplaced', () => {
  it('judges duplicates again after a line is corrected', () => {
    const lines = parseKeysFile('A=1\nA=bad value\nB=2')
    expect(lines.map(l => l.status)).toEqual(['ok', 'invalid', 'ok'])
    const fixed = markReplaced(lines.map(l => (l.line === 2 ? parseLine('A=3', 2) : l)))
    expect(fixed.map(l => l.status)).toEqual(['replaced', 'ok', 'ok'])
  })
})
