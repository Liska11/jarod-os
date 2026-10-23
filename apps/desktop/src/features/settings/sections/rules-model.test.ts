import { describe, expect, it } from 'vitest'
import { actionText, approvalAction, cronProblem, draftProblems, emptyAction, emptyRule, inputOf, type Plugin, pluginSummary, type Rule, ruleSummary, triggerText, untrustedTools } from './rules-model.ts'

describe('cronProblem', () => {
  it('accepts five-field expressions with lists, ranges and steps', () => {
    for (const ok of ['0 9 * * *', '*/15 * * * *', '0 9 * * 1-5', '0,30 8-18 * * 1,3,5', '0 0 1 1 *', '5 4 * * 7']) expect(cronProblem(ok), ok).toBeNull()
  })

  it('names the field that is wrong, or the count', () => {
    expect(cronProblem('0 9 * *')).toMatch(/Five fields/)
    expect(cronProblem('0 9 * * * *')).toMatch(/Five fields/)
    expect(cronProblem('60 9 * * *')).toMatch(/Field 1/)
    expect(cronProblem('0 24 * * *')).toMatch(/Field 2/)
    expect(cronProblem('0 9 32 * *')).toMatch(/Field 3/)
    expect(cronProblem('0 9 * 13 *')).toMatch(/Field 4/)
    expect(cronProblem('0 9 * * x')).toMatch(/Field 5 \(“x”\)/)
  })
})

describe('draftProblems / inputOf', () => {
  it('a default draft needs only a name and a prompt', () => {
    const d = emptyRule()

    expect(draftProblems(d)).toEqual(['Name: required.', 'Action: say what the agent should do.'])
    d.name = 'Morning'
    d.actions = [{ type: 'agent', prompt: ' summarise my inbox ', mode: 'plan' }]
    expect(draftProblems(d)).toEqual([])
    expect(inputOf(d)).toEqual({ name: 'Morning', enabled: true, trigger: { kind: 'schedule', cron: '0 9 * * *' }, actions: [{ type: 'agent', prompt: 'summarise my inbox', mode: 'plan' }] })
  })

  it('checks the trigger, the notification and the webhook action', () => {
    const base = { ...emptyRule(), name: 'x' }

    expect(draftProblems({ ...base, cron: 'nope', actions: [emptyAction('notify')] })).toEqual(['Schedule: Five fields: minute hour day-of-month month weekday, like 0 9 * * 1-5.', 'Action: the notification needs a title.'])
    expect(draftProblems({ ...base, trigger: 'webhook', hookId: 'a b', actions: [{ type: 'notify', title: 't', body: '' }] })).toEqual(['Webhook name: letters, digits, _ and - (64 at most).'])
    expect(draftProblems({ ...base, trigger: 'manual', actions: [{ type: 'webhook', url: 'ftp://x', payload: '{bad' }] })).toEqual(['Action: the address must start with http:// or https://.', 'Action: the payload is not valid JSON.'])
    expect(draftProblems({ ...base, actions: [] })).toEqual(['Add at least one action.'])
  })

  it('numbers the actions when there are several; a webhook payload is sent as parsed JSON', () => {
    const d = { ...emptyRule(), name: 'x', trigger: 'manual' as const, actions: [emptyAction('agent'), { type: 'webhook' as const, url: 'https://hooks.example/x', payload: '{"a":1}' }] }

    expect(draftProblems(d)).toEqual(['Action 1: say what the agent should do.'])
    d.actions[0] = { type: 'agent', prompt: 'go', mode: 'build' }
    expect(inputOf(d).actions[1]).toEqual({ type: 'webhook', url: 'https://hooks.example/x', payload: { a: 1 } })
    expect(inputOf(d).trigger).toEqual({ kind: 'manual' })
  })
})

describe('summaries', () => {
  it('reads a rule as trigger → actions, with the agent’s power and long prompts cut', () => {
    expect(triggerText({ kind: 'manual' })).toBe('by hand only')
    expect(triggerText({ kind: 'webhook', hookId: 'ci' })).toBe('when webhook “ci” is called')
    const rule: Rule = { id: '1', name: 'r', enabled: true, createdAt: 0, updatedAt: 0, trigger: { kind: 'schedule', cron: '0 9 * * *' }, actions: [{ type: 'agent', prompt: 'x'.repeat(80), mode: 'build' }, { type: 'notify', title: 'Done', body: '' }, { type: 'webhook', url: 'https://h.example', payload: {} }] }

    expect(ruleSummary(rule)).toBe(`on schedule 0 9 * * * → ask the agent (can change things): ${'x'.repeat(59)}…; notify “Done”; call https://h.example`)
    expect(actionText({ type: 'agent', prompt: 'hi' })).toBe('ask the agent (read-only): hi')
  })

  it('a plugin says its version, errors, tools and permissions; untrusted tools are the ones not classed', () => {
    const p: Plugin = { id: 'p', name: 'P', version: '1.2', description: '', author: 'Ann', enabled: true, state: 'active', error: '', tools: ['a', 'b'], trusted: ['a'], permissions: ['network'], digest: 'abc' }

    expect(pluginSummary(p)).toBe('v1.2 · Ann · 2 tools · asks for network')
    expect(pluginSummary({ ...p, state: 'error', error: 'boom', tools: [], permissions: [], author: '' })).toBe('v1.2 · error: boom · asks for no permission')
    expect(untrustedTools(p)).toEqual(['b'])
    // V-06 : un plugin bloqué dit pourquoi, sans le préfixe d'erreur.
    expect(pluginSummary({ ...p, state: 'blocked', error: 'non approuvé', tools: [] })).toBe('v1.2 · Ann · non approuvé · asks for network')
  })

  it('V-06 : le geste d’approbation proposé — approuver un nouveau, approuver une modification, rien sinon', () => {
    const p: Plugin = { id: 'p', name: 'P', version: '1.0.0', description: '', author: '', enabled: true, state: 'blocked', error: '', tools: [], trusted: [], permissions: [], digest: 'abc' }

    expect(approvalAction({ ...p, approval: { status: 'unapproved' } })).toBe('approve')
    expect(approvalAction({ ...p, approval: { status: 'modified', version: '1.0.0' } })).toBe('update')
    expect(approvalAction({ ...p, approval: { status: 'quarantined', version: '1.0.0' } })).toBe('update')
    expect(approvalAction({ ...p, state: 'active', approval: { status: 'approved', version: '1.0.0' } })).toBeNull()
    expect(approvalAction({ ...p, state: 'error', approval: { status: 'unapproved' } })).toBeNull()
    // Moteur sans plateforme, ou plus ancien : aucun geste proposé.
    expect(approvalAction({ ...p, approval: null })).toBeNull()
    expect(approvalAction(p)).toBeNull()
  })
})
