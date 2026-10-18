import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/*
 * Sandboxes on the Jarod disk (docs/JAROD-DISK.md): <root>\sandboxes\<name>\{files…, plus .jarod-sandbox.json}.
 *
 * A sandbox is a copy of a project folder where the person, or Jarod, tries things without touching the original. Its
 * changes can then be compared with the original and applied to it: added and modified files are copied over, and
 * files the sandbox removed go to the Recycle Bin in the original (the caller's `trash`), never deleted outright.
 * Folders that tools rebuild (node_modules, .venv…) are left out of the copy by default, and out of every comparison.
 */

export const SANDBOX_FILE = '.jarod-sandbox.json'
/** Never compared nor applied: version control and what tools rebuild. */
export const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', '.next', '.turbo'])

export interface SandboxInfo {
  name: string
  source: string
  created: string
  /** Whether the rebuildable folders were copied too. */
  full: boolean
}

export interface SandboxChange {
  path: string
  kind: 'added' | 'modified' | 'removed'
}

/** A folder-safe sandbox name from a label (or the source's name). */
export function sandboxName(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'sandbox'
  let name = base

  for (let n = 2; taken.has(name); n++) {
    name = `${base}-${n}`
  }

  return name
}

export function listSandboxes(dir: string): SandboxInfo[] {
  if (!fs.existsSync(dir)) {
    return []
  }

  const list: SandboxInfo[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, entry.name, SANDBOX_FILE), 'utf8')) as SandboxInfo

      if (info.name === entry.name) list.push(info)
    } catch {
      // Not a sandbox (or one being created).
    }
  }

  return list.sort((a, b) => b.created.localeCompare(a.created))
}

const fsp = fs.promises

/** Copy `source` into a new sandbox; the info file is written last, so an interrupted copy is not listed. */
export async function createSandbox(dir: string, source: string, label: string, full = false, now = new Date()): Promise<SandboxInfo> {
  const stat = await fsp.stat(source).catch(() => null)

  if (!stat?.isDirectory()) {
    throw new Error('not-a-folder')
  }

  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child)

    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  if (inside(source, dir) || inside(dir, source)) {
    throw new Error('overlaps')
  }

  const name = sandboxName(label || path.basename(source), new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []))
  const target = path.join(dir, name)
  await fsp.mkdir(target, { recursive: true })
  await fsp.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: file => full || !IGNORED.has(path.basename(file)) || path.basename(file) === '.git'
  })
  const info: SandboxInfo = { name, source, created: now.toISOString(), full }
  fs.writeFileSync(path.join(target, SANDBOX_FILE), `${JSON.stringify(info, null, 2)}\n`, 'utf8')

  return info
}

async function files(root: string): Promise<Map<string, fs.Stats>> {
  const found = new Map<string, fs.Stats>()
  const walk = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name === SANDBOX_FILE) continue

      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) found.set(path.relative(root, full), await fsp.stat(full))
    }
  }

  await walk(root)

  return found
}

const hash = async (file: string) => crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex')

/** What the sandbox changed compared with its source, sorted by path. */
export async function compareSandbox(dir: string, name: string): Promise<SandboxChange[]> {
  const info = readInfo(dir, name)
  const sandbox = path.join(dir, name)
  const mine = await files(sandbox)
  const theirs = await files(info.source)
  const changes: SandboxChange[] = []

  for (const [rel, stat] of mine) {
    const original = theirs.get(rel)

    if (!original) {
      changes.push({ path: rel, kind: 'added' })
    } else if (original.size !== stat.size || (await hash(path.join(sandbox, rel))) !== (await hash(path.join(info.source, rel)))) {
      changes.push({ path: rel, kind: 'modified' })
    }
  }

  for (const rel of theirs.keys()) {
    if (!mine.has(rel)) changes.push({ path: rel, kind: 'removed' })
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

function readInfo(dir: string, name: string): SandboxInfo {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('not-a-sandbox')

  const info = listSandboxes(dir).find(item => item.name === name)

  if (!info) throw new Error('not-a-sandbox')

  return info
}

/**
 * Bring the sandbox's changes into its source: `only` limits them to some paths (all by default). Removed files go
 * through `trash` (the Recycle Bin). Returns what was applied.
 */
export async function applySandbox(dir: string, name: string, trash: (file: string) => Promise<void>, only?: readonly string[]): Promise<SandboxChange[]> {
  const info = readInfo(dir, name)
  const wanted = only ? new Set(only) : null
  const changes = (await compareSandbox(dir, name)).filter(change => !wanted || wanted.has(change.path))

  for (const change of changes) {
    const target = path.join(info.source, change.path)

    if (change.kind === 'removed') {
      await trash(target)
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(path.join(dir, name, change.path), target)
    }
  }

  return changes
}

export function sandboxPath(dir: string, name: string): string {
  readInfo(dir, name)

  return path.join(dir, name)
}
