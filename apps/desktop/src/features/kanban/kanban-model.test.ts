import { describe, expect, it } from 'vitest'
import { agoText, byColumn, COLUMNS, dispatchText, emptyTask, KanbanFailure, NEEDS_TEXT, sortTasks, type Status, type Task, taskInput, taskProblems, unwrap, type Verb, verbsFor } from './kanban-model.ts'

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, body: null, assignee: null, status: 'ready', priority: 0, tenant: null, workspace_kind: 'scratch', workspace_path: null, created_by: null, created_at: 100, started_at: null, completed_at: null, result: null, skills: [], ...over })

describe('unwrap', () => {
  it('gives the data of a success; a refusal carries the engine’s sentence without its [oneai] prefix', () => {
    expect(unwrap({ success: true, data: [1] })).toEqual([1])
    expect(unwrap({ success: true })).toBeUndefined()
    expect(() => unwrap({ success: false, error: '[oneai] plugin-kanban désactivé' })).toThrow(new KanbanFailure('plugin-kanban désactivé'))
    expect(() => unwrap({ success: false })).toThrow('The board refused.')
  })
})

describe('columns', () => {
  it('puts each task in its status column, hides archived, and orders by priority then age', () => {
    const tasks = [task('a', { priority: 1, created_at: 5 }), task('b', { priority: 3, created_at: 9 }), task('c', { priority: 3, created_at: 2 }), task('d', { status: 'done' }), task('e', { status: 'archived' }), task('f', { status: 'blocked' })]
    const columns = byColumn(tasks)

    expect(columns.ready.map(t => t.id)).toEqual(['c', 'b', 'a'])
    expect(columns.done.map(t => t.id)).toEqual(['d'])
    expect(columns.blocked.map(t => t.id)).toEqual(['f'])
    expect(Object.values(columns).flat().some(t => t.id === 'e')).toBe(false)
    expect(Object.keys(columns)).toEqual([...COLUMNS])
  })

  it('a stable order for equal priority and age: by id', () => {
    expect(sortTasks([task('b'), task('a')]).map(t => t.id)).toEqual(['a', 'b'])
  })
})

describe('what can be done', () => {
  it('offers verbs that fit the status; every status has a comment; a running task can only be taken back', () => {
    const all: Status[] = [...COLUMNS, 'archived']

    for (const status of all) expect(verbsFor(status)).toContain('comment')
    expect(verbsFor('running')).toEqual(['reclaim', 'comment'])
    expect(verbsFor('triage')).toContain('specify')
    expect(verbsFor('blocked')).toContain('unblock')
    expect(verbsFor('ready')).not.toContain('specify')
  })

  it('never offers a verb the engine refuses in that status (plugin-kanban `refuseUnless`), and a set-aside task can come back', () => {
    // The statuses plugin-kanban accepts for each verb (jarod-core/packages/plugins/kanban/src/kanban.ts); assign and archive: all but running; comment: any.
    const accepted: Partial<Record<Verb, readonly Status[]>> = {
      promote: ['todo', 'blocked'],
      complete: ['ready', 'blocked', 'review'],
      block: ['todo', 'ready', 'scheduled', 'review'],
      unblock: ['blocked', 'scheduled'],
      schedule: ['todo', 'ready', 'blocked'],
      specify: ['triage'],
      reclaim: ['running']
    }

    for (const status of COLUMNS) {
      for (const verb of verbsFor(status)) {
        const allowed = accepted[verb]

        expect(allowed ? allowed.includes(status) : verb === 'comment' || status !== 'running', `${verb} on ${status}`).toBe(true)
      }
    }

    expect(verbsFor('triage')).not.toContain('promote')
    expect(verbsFor('scheduled')).toContain('unblock')
    expect(verbsFor('review')).toEqual(expect.arrayContaining(['complete', 'block']))
  })

  it('assign and comment need text; the others ask for an optional sentence or nothing', () => {
    expect(NEEDS_TEXT.assign?.optional).toBe(false)
    expect(NEEDS_TEXT.comment?.optional).toBe(false)
    expect(NEEDS_TEXT.block?.optional).toBe(true)
    expect(NEEDS_TEXT.archive).toBeUndefined()
  })
})

describe('task form', () => {
  it('needs a title and a whole-number priority; the input drops empty fields and names the workspace', () => {
    expect(taskProblems(emptyTask())).toEqual(['Title: required.'])
    expect(taskProblems({ ...emptyTask(), title: 't', priority: 'x' })).toEqual(['Priority: a whole number (higher runs first).'])
    expect(taskProblems({ ...emptyTask(), title: 't', priority: '-2' })).toEqual([])
    expect(taskInput({ ...emptyTask('san'), title: ' Write ', priority: '2' })).toEqual({ title: 'Write', assignee: 'san', priority: 2, workspace: 'scratch' })
    expect(taskInput({ ...emptyTask(), title: 't', body: ' b ', triage: true, folder: 'D:\\work' })).toEqual({ title: 't', body: 'b', priority: 0, triage: true, workspace: 'dir:D:\\work' })
  })

  it('an empty assignee goes to the served profile (else « Run next » skips the task as unassigned); a typed one wins', () => {
    expect(taskInput({ ...emptyTask(), title: 't' }, 'default')).toMatchObject({ assignee: 'default' })
    expect(taskInput({ ...emptyTask(' '), title: 't' }, 'default')).toMatchObject({ assignee: 'default' })
    expect(taskInput({ ...emptyTask('san'), title: 't' }, 'default')).toMatchObject({ assignee: 'san' })
    expect(taskInput({ ...emptyTask(), title: 't' }, null)).not.toHaveProperty('assignee')
  })
})

describe('text helpers', () => {
  it('says how long ago, from seconds', () => {
    const now = 1_000_000_000
    const s = now / 1000

    expect(agoText(s - 10, now)).toBe('just now')
    expect(agoText(s - 600, now)).toBe('10 min ago')
    expect(agoText(s - 7200, now)).toBe('2 h ago')
    expect(agoText(s - 3 * 86_400, now)).toBe('3 d ago')
    expect(agoText(null, now)).toBe('')
  })

  it('reads the dispatch answer', () => {
    expect(dispatchText({ dry_run: true, would_spawn: [{ title: 'Write' }], skipped: [{ task_id: 'x', reason: 'r' }] })).toBe('Next up: “Write”. 1 skipped.')
    expect(dispatchText({ dry_run: true, would_spawn: [] })).toBe('Nothing is ready to run.')
    expect(dispatchText({ spawned: [{ task_id: 'a' }] })).toMatch(/^Started a task/)
    expect(dispatchText({ spawned: [] })).toBe('Nothing is ready to run.')
  })
})
