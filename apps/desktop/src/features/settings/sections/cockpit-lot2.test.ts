import { describe, expect, it } from 'vitest'
import { ruleExpiryText, ruleKey, ruleListProblem, ruleTargetProblem } from './jarod-settings-model.ts'
import { isLive, type TaskRow, taskDetail } from './TasksSection.tsx'

describe('permission rules with a target and a deadline', () => {
  it('a rule is named by its tool and target; the same tool may appear once per target', () => {
    expect(ruleKey({ tool: 'system_open', decision: 'deny', target: '*steam*' })).toBe('system_open → *steam*')
    expect(ruleListProblem([{ tool: 'a', decision: 'deny', target: 'x' }, { tool: 'a', decision: 'deny', target: 'y' }, { tool: 'a', decision: 'ask' }])).toBeNull()
    expect(ruleListProblem([{ tool: 'a', decision: 'deny', target: 'x' }, { tool: 'a', decision: 'allow', target: 'x' }])).toMatch(/a → x/)
  })

  it('a target is optional, bounded and free of control characters', () => {
    expect(ruleTargetProblem('')).toBeNull()
    expect(ruleTargetProblem('C:\\Users\\*')).toBeNull()
    expect(ruleTargetProblem('a'.repeat(261))).not.toBeNull()
    expect(ruleTargetProblem('a\u0007b')).not.toBeNull()
  })

  it('a temporary rule says until when, then that it has expired; a permanent one says nothing', () => {
    expect(ruleExpiryText({ tool: 'a', decision: 'allow' })).toBeNull()
    expect(ruleExpiryText({ tool: 'a', decision: 'allow', expiresAt: 2_000 }, 1_000)).toMatch(/until/)
    expect(ruleExpiryText({ tool: 'a', decision: 'allow', expiresAt: 2_000 }, 2_000)).toBe('expired')
  })
})

describe('Tasks screen', () => {
  const task = (over: Partial<TaskRow>): TaskRow => ({ id: 'i', sessionId: 's', tool: 'write_file', summary: 'Écrire', status: 'done', steps: [], createdAt: 0, ...over })

  it('only a task still waiting, running or checking can be cancelled', () => {
    expect(['awaiting-approval', 'running', 'verifying'].every(status => isLive(task({ status: status as TaskRow['status'] })))).toBe(true)
    expect(['done', 'failed', 'refused', 'cancelled'].some(status => isLive(task({ status: status as TaskRow['status'] })))).toBe(false)
  })

  it('the detail line names the tool, the target and what the proof observed', () => {
    expect(taskDetail(task({ target: 'a.txt', proof: { status: 'verified', evidence: 'a.txt relu : 7 octets' } }))).toBe('write_file · a.txt — checked: a.txt relu : 7 octets')
    expect(taskDetail(task({ status: 'failed', error: 'boom' }))).toBe('write_file — boom')
  })
})
