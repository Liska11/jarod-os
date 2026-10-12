import { describe, expect, it } from 'vitest'
import type { ProjectActivity, RecentFile } from '../../shared/ipc.ts'
import { buildCatchUp, type CatchUpEvidence, durationLabel, findThread, folderOf, parseThreads, readTranscript, threadId, tilde, whenLabel } from './continuity.ts'

const HOME = '/Users/sam'
const NOW = new Date(2026, 9, 5, 14, 30).getTime()
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

const file = (path: string, lastUsedAt: number, modifiedAt: number): RecentFile => ({ path, name: path.split('/').pop()!, extension: '.mp4', size: 10, modifiedAt, lastUsedAt, kind: 'file' })

const evidence = (overrides: Partial<CatchUpEvidence> = {}): CatchUpEvidence => ({
  now: NOW,
  home: HOME,
  files: [file(`${HOME}/Desktop/demo.mp4`, 0, at(5, 11, 49))],
  projects: [
    {
      path: `${HOME}/Apps/herald`,
      name: 'herald',
      branch: 'main',
      changed: 3,
      changedFiles: ['src/catch-up.ts', 'README.md'],
      commits: [
        { subject: 'feat: catch up', at: at(4, 18, 2) },
        { subject: 'fix: dock', at: at(3, 10, 0) }
      ],
      touchedAt: at(5, 13)
    } satisfies ProjectActivity,
    { path: `${HOME}/Projects/site`, name: 'site', changed: 0, changedFiles: [], commits: [], touchedAt: at(3, 9, 15) }
  ],
  chats: [
    { id: 'stored-1', title: 'Build the coffee site', preview: 'Build this: a website for a coffee shop', at: at(5, 11, 21), messages: 14, step: 'Add the menu page', last: 'The site is ready in ~/Projects/site.', stopped: true },
    { id: 'stored-2', title: 'Write the launch post', at: at(5, 12, 40), messages: 1 }
  ],
  events: [
    { title: 'Design review', start: at(5, 15), end: at(5, 15, 30), allDay: false },
    { title: 'Tomorrow thing', start: at(6, 9), end: at(6, 10), allDay: false }
  ],
  apps: ['Keynote'],
  ...overrides
})

describe('whenLabel', () => {
  it('names today, yesterday and the past week, then falls back to a date', () => {
    expect(whenLabel(at(5, 9, 5), NOW)).toBe('today 09:05')
    expect(whenLabel(at(4, 23, 59), NOW)).toBe('yesterday 23:59')
    expect(whenLabel(at(3, 8, 0), NOW)).toBe('Saturday 08:00')
    expect(whenLabel(at(1, 8, 0), NOW)).toBe('Thursday 08:00')
    expect(whenLabel(new Date(2026, 7, 3).getTime(), NOW)).toBe('3 Aug')
  })
})

describe('durationLabel', () => {
  it('reads like speech', () => {
    expect(durationLabel(25 * 60_000)).toBe('25 minutes')
    expect(durationLabel(3 * 3_600_000)).toBe('3 hours')
    expect(durationLabel(3 * 86_400_000)).toBe('3 days')
  })
})

describe('buildCatchUp', () => {
  it('numbers every entry, writes paths from ~ and maps ids back to items', () => {
    const request = buildCatchUp(evidence({ awayMs: 2 * 3_600_000 }))!

    expect(request.input).toContain('Now: Monday 5 October 2026, 14:30. The user just came back after 2 hours away.')
    expect(request.input).toContain('f1 demo.mp4 (~/Desktop), changed today 11:49')
    expect(request.input).toContain(
      'p1 herald (~/Apps/herald): git branch main; 3 uncommitted changes, including src/catch-up.ts, README.md; recent commits: "feat: catch up" (yesterday 18:02), "fix: dock" (Saturday 10:00)'
    )
    expect(request.input).toContain('p2 site (~/Projects/site): files changed Saturday 09:15')
    expect(request.input).toContain(
      'c1 "Build the coffee site", today 11:21, 14 messages; stopped before Hermes finished; unfinished step: "Add the menu page"; it began: "Build this: a website for a coffee shop"; Hermes\'s last reply: "The site is ready in ~/Projects/site."'
    )
    expect(request.input).toContain('c2 "Write the launch post", today 12:40, asked but never answered')
    expect(request.input).toContain('e1 15:00-15:30 Design review')
    expect(request.input).not.toContain('Tomorrow thing')
    expect(request.input).toContain('Apps open: Keynote')
    expect(request.refs).toEqual({
      f1: { kind: 'file', ref: `${HOME}/Desktop/demo.mp4`, label: 'demo.mp4' },
      p1: { kind: 'project', ref: `${HOME}/Apps/herald`, label: 'herald' },
      p2: { kind: 'project', ref: `${HOME}/Projects/site`, label: 'site' },
      c1: { kind: 'chat', ref: 'stored-1', label: 'Build the coffee site' },
      c2: { kind: 'chat', ref: 'stored-2', label: 'Write the launch post' }
    })
  })

  it('has nothing to ask when there is no work to look at', () => {
    expect(buildCatchUp(evidence({ files: [], projects: [], chats: [] }))).toBeNull()
  })
})

describe('readTranscript', () => {
  const plan = (step3: string) =>
    JSON.stringify({ todos: [{ id: '1', content: 'Write the Order section', status: 'completed' }, { id: '2', content: 'Add the cart logic', status: step3 }, { id: '3', content: 'Check the links', status: 'pending' }] })

  it('reads a stopped turn: the unfinished step, the last real reply and when', () => {
    expect(
      readTranscript([
        { role: 'user', content: 'Add online ordering', timestamp: 1791168000 },
        { role: 'tool', content: plan('in_progress'), timestamp: 1791168100 },
        { role: 'assistant', content: 'Now add the cart logic to script.js:', timestamp: 1791168200 },
        { role: 'assistant', content: 'Operation interrupted: waiting for model response (0.6s elapsed).', timestamp: 1791168300.5 }
      ])
    ).toEqual({ at: 1791168300500, last: 'Now add the cart logic to script.js:', step: 'Add the cart logic', stopped: true })
  })

  it('reads a finished turn, and a request that never got an answer', () => {
    expect(readTranscript([{ role: 'tool', content: plan('completed') }, { role: 'assistant', content: 'Done.' }])).toEqual({ at: undefined, last: 'Done.', step: 'Check the links', stopped: false })
    expect(readTranscript([{ role: 'user', content: 'Write the launch post', timestamp: 1791168000 }])).toEqual({ at: 1791168000000, last: undefined, step: undefined, stopped: true })
    expect(readTranscript([])).toEqual({ at: undefined, last: undefined, step: undefined, stopped: false })
  })
})

describe('parseThreads', () => {
  const refs = buildCatchUp(evidence())!.refs

  it('reads fenced JSON, keeps only cited evidence and caps the count', () => {
    const answer = [
      'Here you go:',
      '```json',
      JSON.stringify({
        threads: [
          { title: 'Herald launch', summary: 'You were finishing the demo.', stopped: 'Video exported, 3 changes uncommitted.', next: 'Draft the launch post', prompt: 'Write a launch post for ~/Desktop/demo.mp4.', items: ['f1', 'p1', 'x9', 'f1'] },
          { title: 'Coffee site', summary: 'You were building the site.', stopped: 'Menu page next.', next: '', prompt: '', items: ['c1', 'p2'] },
          { title: 'Third', summary: 'You were busy.', items: [] },
          { title: 'Fourth', summary: 'Too many.', items: [] }
        ]
      }),
      '```'
    ].join('\n')
    const threads = parseThreads(answer, refs)!

    expect(threads.map(t => t.title)).toEqual(['Herald launch', 'Coffee site', 'Third'])
    expect(threads[0]).toEqual({
      id: 't-herald-launch',
      title: 'Herald launch',
      summary: 'You were finishing the demo.',
      stopped: 'Video exported, 3 changes uncommitted.',
      next: { label: 'Draft the launch post', prompt: 'Write a launch post for ~/Desktop/demo.mp4.' },
      items: [refs.f1, refs.p1]
    })
    expect(threads[1].next).toBeUndefined()
    expect(threads[1].items).toEqual([refs.c1, refs.p2])
  })

  it('accepts an empty list and rejects answers that are not the JSON asked for', () => {
    expect(parseThreads('{"threads": []}', refs)).toEqual([])
    expect(parseThreads('I could not find anything.', refs)).toBeNull()
    expect(parseThreads('{"threads": "none"}', refs)).toBeNull()
  })

  it('drops untitled and duplicate threads', () => {
    const threads = parseThreads(JSON.stringify([{ title: '', summary: 'x' }, { title: 'Same', summary: 'a' }, { title: 'same', summary: 'b' }]), refs)!

    expect(threads.map(t => t.summary)).toEqual(['a'])
  })
})

describe('findThread', () => {
  const threads = ['Jarod-OS launch', 'Ember & Oak website', 'Tax return'].map(title => ({ id: threadId(title), title, summary: 'x', stopped: '', items: [] }))

  it('finds by title words or position, and defaults to the first', () => {
    expect(findThread(threads, 'ember')?.title).toBe('Ember & Oak website')
    expect(findThread(threads, 'the coffee website')?.title).toBe('Ember & Oak website')
    expect(findThread(threads, 'second one')?.title).toBe('Ember & Oak website')
    expect(findThread(threads, 'last')?.title).toBe('Tax return')
    expect(findThread(threads, '')?.title).toBe('Jarod-OS launch')
    expect(findThread(threads, 'garden')).toBeNull()
  })
})

describe('threadId', () => {
  it('is stable for the same title', () => {
    expect(threadId('Ember & Oak website!')).toBe('t-ember-oak-website')
  })
})

describe('tilde / folderOf', () => {
  it('shortens the home folder with either separator and finds the folder of a file', () => {
    expect(tilde('/home/san/work', '/home/san')).toBe('~/work')
    expect(tilde('C:\\Users\\San\\work', 'C:\\Users\\San')).toBe('~\\work')
    expect(tilde('C:\\Users\\Sandra\\work', 'C:\\Users\\San')).toBe('C:\\Users\\Sandra\\work')
    expect(tilde('C:\\Users\\San', 'C:\\Users\\San')).toBe('~')
    expect(folderOf('/home/san/work/a.txt', '/home/san')).toBe('~/work')
    expect(folderOf('C:\\Users\\San\\work\\a.txt', 'C:\\Users\\San')).toBe('~\\work')
    expect(folderOf('a.txt', '/home/san')).toBe('/')
  })
})
