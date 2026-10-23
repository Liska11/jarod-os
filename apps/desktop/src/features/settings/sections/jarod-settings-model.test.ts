import { describe, expect, it } from 'vitest'
import { domainProblem, EMPTY_RULE_FORM, formOf, grantAction, intProblem, kindOf, readRootProblem, isUserRefusal, moneyProblem, moveItem, programProblem, rootProblem, type RuleForm, ruleFormProblem, ruleListProblem, ruleRef, ruleSpentText, ruleToolProblem, settingErrorText, updateAction } from './jarod-settings-model.ts'

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

describe('domainProblem', () => {
  it('accepts a full lowercase domain', () => {
    for (const ok of ['example.org', 'docs.example.org', 'a-b.example.co.uk', ' Example.ORG ']) expect(domainProblem(ok), ok).toBeNull()
  })

  it('refuses wildcards, single labels, ports, paths, schemes and empty', () => {
    for (const bad of ['', '*', '*.example.org', 'com', 'localhost', 'example.org:8080', 'example.org/path', 'https://example.org', 'exa mple.org', '-a.example.org']) expect(domainProblem(bad), JSON.stringify(bad)).toMatch(/full domain/)
  })

  it('refuses an IP address, which is not a domain', () => {
    for (const bad of ['127.0.0.1', '192.168.1.10', '10.0.0.1']) expect(domainProblem(bad), bad).toMatch(/IP address/)
  })
})

describe('readRootProblem', () => {
  it('accepts absolute folders (drive, UNC, POSIX)', () => {
    for (const ok of ['C:\\Users\\me\\scoop\\shims', 'D:/tools/bin', '\\\\server\\share\\tools', '/home/me/.local/bin']) expect(readRootProblem(ok), ok).toBeNull()
  })

  it('refuses empty, relative, parent-walking, wildcard and control-character paths', () => {
    expect(readRootProblem('')).toMatch(/full path/i)
    for (const bad of ['tools', './tools', 'bin\\node']) expect(readRootProblem(bad), bad).toMatch(/absolute/i)
    for (const bad of ['C:\\a\\..\\b', '/a/../b', 'C:\\tools\\*', 'C:\\a<b', '/a\u0001b']) expect(readRootProblem(bad), bad).toMatch(/wildcard|forbidden/i)
  })
})

describe('permission rule form (same actions as jarod permissions)', () => {
  const rule = { tool: 'system_files', decision: 'allow' as const, autonomous: true as const, target: 'D:/demo/*', uses: 3, expiresAt: Date.now() + 3_600_000, id: 'p-demo01' }

  it('a new rule: allow without approval with its bounds; empty fields are left out', () => {
    const form: RuleForm = { ...EMPTY_RULE_FORM, tool: ' system_files ', kind: 'auto', target: 'D:/demo/*', uses: '3', hours: 8 }

    expect(grantAction(form)).toEqual({ op: 'grant', input: { tool: 'system_files', decision: 'allow', autonomous: true, target: 'D:/demo/*', durationMs: 8 * 3_600_000, uses: 3 } })
    expect(grantAction({ ...EMPTY_RULE_FORM, tool: 'run_shell', kind: 'deny' })).toEqual({ op: 'grant', input: { tool: 'run_shell', decision: 'deny', autonomous: false } })
  })

  it('an edit sends only what changed; an emptied field removes the bound; the end is kept unless another duration is chosen', () => {
    const form = formOf(rule)

    expect(form).toMatchObject({ kind: 'auto', target: 'D:/demo/*', uses: '3', hours: -1 })
    expect(updateAction('p-demo01', rule, form)).toEqual({ op: 'update', ref: 'p-demo01', change: {} })
    expect(updateAction('p-demo01', rule, { ...form, uses: '5' }).change).toEqual({ uses: 5 })
    expect(updateAction('p-demo01', rule, { ...form, uses: '', hours: 0 }).change).toEqual({ uses: null, durationMs: null })
    expect(updateAction('p-demo01', rule, { ...form, kind: 'deny', uses: '' }).change).toEqual({ decision: 'deny', autonomous: false, uses: null })
    expect(updateAction('p-demo01', rule, { ...form, target: '' }).change).toEqual({ target: null })
  })

  it('checks what the engine checks: a number of uses only on an allow rule, operation and conversation characters', () => {
    expect(ruleFormProblem({ ...EMPTY_RULE_FORM, tool: 'x', kind: 'deny', uses: '2' })).not.toBeNull()
    expect(ruleFormProblem({ ...EMPTY_RULE_FORM, tool: 'x', kind: 'auto', uses: '2' })).toBeNull()
    expect(ruleFormProblem({ ...EMPTY_RULE_FORM, tool: 'x', uses: 'deux' })).not.toBeNull()
    expect(ruleFormProblem({ ...EMPTY_RULE_FORM, tool: 'x', operation: 'a b' })).not.toBeNull()
    expect(ruleFormProblem({ ...EMPTY_RULE_FORM, tool: 'x', session: 'a/b' })).not.toBeNull()
  })

  it('names a rule by id, or by position for an old rule written without one; says when it no longer applies', () => {
    expect(ruleRef(rule, 4)).toBe('p-demo01')
    expect(ruleRef({ tool: 'x', decision: 'deny' }, 4)).toBe('5')
    expect(kindOf(rule)).toBe('auto')
    expect(ruleSpentText({ ...rule, uses: 0 })).not.toBeNull()
    expect(ruleSpentText({ ...rule, expiresAt: Date.now() - 1 })).not.toBeNull()
    expect(ruleSpentText(rule)).toBeNull()
  })
})
