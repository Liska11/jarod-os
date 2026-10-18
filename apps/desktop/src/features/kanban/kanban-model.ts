/*
 * Kanban: the data side of the page (no React). Mirrors `kanban-*`: every channel answers `{ success, data?, error? }`; times are in seconds.
 */

export const COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const

export type Status = (typeof COLUMNS)[number] | 'archived'

export interface Task {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: Status
  priority: number
  tenant: string | null
  workspace_kind: string
  workspace_path: string | null
  created_by: string | null
  created_at: number | null
  started_at: number | null
  completed_at: number | null
  result: string | null
  skills: string[]
}

export interface Board {
  slug: string
  name: string
  description: string | null
  is_current: boolean
  archived: boolean
  total: number
  counts: Record<string, number>
}

export interface TaskDetail {
  task: Task
  comments: { id: number; author: string | null; body: string; created_at: number | null }[]
  events: { id: number; kind: string; payload: Record<string, unknown> | null; created_at: number | null }[]
  parents: string[]
  children: string[]
  runs: { id: number; profile: string | null; status: string; outcome: string | null; summary: string | null; error: string | null; started_at: number | null; ended_at: number | null }[]
  latest_summary: string | null
}

export interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

export class KanbanFailure extends Error {}

/** The data of a successful answer; a refusal becomes an error carrying the engine's sentence. */
export function unwrap<T>(answer: Envelope<T>): T {
  if (!answer.success) {
    throw new KanbanFailure((answer.error ?? 'The board refused.').replace(/^\[oneai\]\s*/, ''))
  }

  return answer.data as T
}

export const STATUS_LABEL: Record<Status, string> = {
  triage: 'To specify',
  todo: 'Waiting',
  scheduled: 'Scheduled',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'To review',
  done: 'Done',
  archived: 'Archived'
}

export const STATUS_HINT: Record<Status, string> = {
  triage: 'A rough idea: ask the agent to turn it into a clear task.',
  todo: 'Waiting for the tasks it depends on.',
  scheduled: 'Set aside for later.',
  ready: 'The agent can pick it up.',
  running: 'The agent is working on it.',
  blocked: 'Stuck: see the reason.',
  review: 'Done by the agent: read it, then accept or send it back.',
  done: 'Finished.',
  archived: 'Hidden from the board.'
}

/** Highest priority first, then oldest first (a stable order for a column). */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => b.priority - a.priority || (a.created_at ?? 0) - (b.created_at ?? 0) || a.id.localeCompare(b.id))
}

export function byColumn(tasks: readonly Task[]): Record<(typeof COLUMNS)[number], Task[]> {
  const out = Object.fromEntries(COLUMNS.map(column => [column, [] as Task[]])) as Record<(typeof COLUMNS)[number], Task[]>

  for (const task of tasks) {
    if (task.status !== 'archived' && task.status in out) {
      out[task.status as (typeof COLUMNS)[number]].push(task)
    }
  }

  for (const column of COLUMNS) {
    out[column] = sortTasks(out[column])
  }

  return out
}

/**
 * What can be done to a task in its status: only what the engine accepts there (plugin-kanban's `refuseUnless`), so a button never leads to a
 * certain refusal. A rough idea (`triage`) leaves its column through « specify » (the agent) or is archived; a task set aside (`scheduled`) comes
 * back with « unblock »; a task to review is accepted (« complete ») or sent back by blocking it with a reason.
 */
export type Verb = 'promote' | 'specify' | 'assign' | 'schedule' | 'block' | 'unblock' | 'complete' | 'reclaim' | 'archive' | 'comment'

export function verbsFor(status: Status): Verb[] {
  switch (status) {
    case 'triage':
      return ['specify', 'assign', 'archive', 'comment']
    case 'todo':
      return ['assign', 'schedule', 'block', 'archive', 'comment']
    case 'scheduled':
      return ['unblock', 'assign', 'block', 'archive', 'comment']
    case 'ready':
      return ['assign', 'schedule', 'block', 'complete', 'archive', 'comment']
    case 'running':
      return ['reclaim', 'comment']
    case 'blocked':
      return ['unblock', 'archive', 'comment']
    case 'review':
      return ['complete', 'block', 'assign', 'archive', 'comment']
    case 'done':
      return ['archive', 'comment']
    default:
      return ['comment']
  }
}

export const VERB_LABEL: Record<Verb, string> = {
  promote: 'Mark ready',
  specify: 'Ask the agent to specify',
  assign: 'Assign',
  schedule: 'Schedule for later',
  block: 'Block',
  unblock: 'Unblock',
  complete: 'Complete',
  reclaim: 'Take back',
  archive: 'Archive',
  comment: 'Comment'
}

/** Verbs that take a sentence from the user (a reason, a result, a comment, an assignee). */
export const NEEDS_TEXT: Partial<Record<Verb, { label: string; optional: boolean }>> = {
  assign: { label: 'Profile to assign to', optional: false },
  schedule: { label: 'Why later? (optional)', optional: true },
  block: { label: 'Why is it blocked? (optional)', optional: true },
  complete: { label: 'Result (optional)', optional: true },
  reclaim: { label: 'Why? (optional)', optional: true },
  comment: { label: 'Comment', optional: false }
}

export function agoText(seconds: number | null | undefined, now = Date.now()): string {
  if (!seconds) {
    return ''
  }

  const delta = Math.max(0, Math.round(now / 1000 - seconds))

  if (delta < 60) {
    return 'just now'
  }

  if (delta < 3600) {
    return `${Math.floor(delta / 60)} min ago`
  }

  if (delta < 86_400) {
    return `${Math.floor(delta / 3600)} h ago`
  }

  return `${Math.floor(delta / 86_400)} d ago`
}

export interface TaskDraft {
  title: string
  body: string
  assignee: string
  priority: string
  triage: boolean
  folder: string
}

export const emptyTask = (assignee = ''): TaskDraft => ({ title: '', body: '', assignee, priority: '0', triage: false, folder: '' })

export function taskProblems(draft: TaskDraft): string[] {
  const out: string[] = []

  if (!draft.title.trim()) {
    out.push('Title: required.')
  }

  if (!/^-?\d{1,3}$/.test(draft.priority.trim())) {
    out.push('Priority: a whole number (higher runs first).')
  }

  return out
}

/**
 * What `kanban-create-task` gets. An empty assignee means the profile Jarod serves (as the form says): left out, the task stayed unassigned and
 * « Run next » skipped it for good (« non assignée »).
 */
export function taskInput(draft: TaskDraft, servedProfile?: string | null): Record<string, unknown> {
  const assignee = draft.assignee.trim() || servedProfile?.trim() || ''

  return {
    title: draft.title.trim(),
    ...(draft.body.trim() ? { body: draft.body.trim() } : {}),
    ...(assignee ? { assignee } : {}),
    priority: Number(draft.priority.trim()),
    ...(draft.triage ? { triage: true } : {}),
    workspace: draft.folder ? `dir:${draft.folder}` : 'scratch'
  }
}

/** The "dispatch" answer, in a sentence. */
export function dispatchText(data: { dry_run?: boolean; would_spawn?: { title: string }[]; spawned?: { task_id: string }[]; skipped?: { task_id: string; reason: string }[] }): string {
  const skipped = data.skipped?.length ? ` ${data.skipped.length} skipped.` : ''

  if (data.dry_run) {
    return data.would_spawn?.length ? `Next up: “${data.would_spawn[0]!.title}”.${skipped}` : `Nothing is ready to run.${skipped}`
  }

  return data.spawned?.length ? `Started a task: the agent works on it in its own conversation.${skipped}` : `Nothing is ready to run.${skipped}`
}
