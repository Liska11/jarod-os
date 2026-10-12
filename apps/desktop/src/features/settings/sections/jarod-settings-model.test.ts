import { describe, expect, it } from 'vitest'
import { intProblem, isUserRefusal, moneyProblem, moveItem, programProblem, rootProblem, ruleListProblem, ruleToolProblem, settingErrorText } from './jarod-settings-model.ts'

describe('intProblem', () => {
  it('accepts whole numbers in range; 0 only where it means off', () => {
    expect(intProblem('50', 1, 500)).toBeNull()
    expect(intProblem(' 500 ', 1, 500)).toBeNull()
    expect(intProblem('0', 10_000, 5_000_000, true)).toBeNull()
    expect(intProblem('0', 1, 500)).toMatch(/Between 1 and 500/)
    expect(intProblem('501', 1, 500)).toMatch(/Between 1 and 500/)
    expect(intProblem('9999', 10_000, 5_000_000, true)).toMatch(/0 \(off\) or 10,000 and 5,000,000/)
  })

  it('refuses text, decimals and empty', () => {
    for (const bad of ['', 'ten', '1.5', '1e3', '--2']) expect(intProblem(bad, 1, 500), JSON.stringify(bad)).toBe('Whole number only.')
  })
})

describe('moneyProblem', () => {
  it('amounts with up to four decimals, up to a million', () => {
    for (const ok of ['0', '2', '2.5', '0.0001', '1000000']) expect(moneyProblem(ok), ok).toBeNull()
    for (const bad of ['', '-1', '1,5', '2.12345', '$3', 'x']) expect(moneyProblem(bad), bad).toMatch(/dollars/)
    expect(moneyProblem('1000001')).toMatch(/At most/)
  })
})

describe('shell guard and rule names', () => {
  it('tools: names, family segments and *; programs: no shell characters; roots: relative and contained', () => {
    for (const ok of ['read_file', 'web/*', '*', 'mcp.server-1']) expect(ruleToolProblem(ok), ok).toBeNull()
    for (const bad of ['', 'a b', 'x'.repeat(65), 'rm;ls']) expect(ruleToolProblem(bad), bad).toBeTruthy()

    for (const ok of ['git', 'node.exe', 'C:\\Tools\\fd.exe']) expect(programProblem(ok), ok).toBeNull()
    for (const bad of ['', 'a b', 'a;b', 'a|b', '"x"', '$HOME', 'a&b']) expect(programProblem(bad), bad).toBeTruthy()

    for (const ok of ['build', 'out/dist', 'src\\gen']) expect(rootProblem(ok), ok).toBeNull()
    for (const bad of ['', '..', '../x', 'a/../b', 'C:\\x', '/etc', '\\\\srv\\share']) expect(rootProblem(bad), bad).toBeTruthy()
  })

  it('a rule list names a duplicate tool and a list that is too long', () => {
    expect(ruleListProblem([{ tool: 'a', decision: 'allow' }, { tool: 'b', decision: 'deny' }])).toBeNull()
    expect(ruleListProblem([{ tool: 'a', decision: 'allow' }, { tool: ' a ', decision: 'deny' }])).toBe('“a” appears twice.')
    expect(ruleListProblem(Array.from({ length: 201 }, (_, i) => ({ tool: `t${i}`, decision: 'ask' as const })))).toBe('At most 200 rules.')
  })
})

describe('moveItem', () => {
  it('moves an item without mutating the list; out-of-range moves change nothing', () => {
    const list = ['a', 'b', 'c']

    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(list, 1, 1)).toEqual(list)
    expect(moveItem(list, -1, 1)).toEqual(list)
    expect(moveItem(list, 1, 3)).toEqual(list)
    expect(list).toEqual(['a', 'b', 'c'])
  })
})

describe('engine messages', () => {
  it('drops the transport and [oneai] prefixes', () => {
    expect(settingErrorText('jarod.invoke -> 400: [oneai] réglage « maxAgentSteps » : entre 1 et 500')).toBe('réglage « maxAgentSteps » : entre 1 et 500')
    expect(settingErrorText('[oneai] set-jarod-settings : réglage(s) non géré(s) : x')).toBe('réglage(s) non géré(s) : x')
    expect(settingErrorText('plain')).toBe('plain')
  })

  it('tells a Cancel on the native confirmation from a real failure', () => {
    expect(isUserRefusal('[oneai] réglage « shellGuard » : refusé par l’utilisateur')).toBe(true)
    expect(isUserRefusal("[oneai] réglage « shellGuard » : refusé par l'utilisateur")).toBe(true)
    expect(isUserRefusal('[oneai] réglage « x » : entier attendu')).toBe(false)
  })
})
