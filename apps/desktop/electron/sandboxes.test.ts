import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applySandbox, compareSandbox, createSandbox, listSandboxes, sandboxName } from './sandboxes.ts'

let base: string
let project: string
let sandboxes: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-sandbox-test-'))
  project = path.join(base, 'Mon Site')
  sandboxes = path.join(base, 'disk', 'sandboxes')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(project, 'node_modules', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src', 'app.js'), 'v1')
  fs.writeFileSync(path.join(project, 'README.md'), 'readme')
  fs.writeFileSync(path.join(project, 'old.txt'), 'to go')
  fs.writeFileSync(path.join(project, 'node_modules', 'lib', 'index.js'), 'lib')
  fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main')
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('sandboxName', () => {
  it('makes a folder-safe, unused name', async () => {
    expect(sandboxName('Mon Site Été!', new Set())).toBe('mon-site-ete')
    expect(sandboxName('Mon Site', new Set(['mon-site', 'mon-site-2']))).toBe('mon-site-3')
    expect(sandboxName('***', new Set())).toBe('sandbox')
  })
})

describe('sandboxes', () => {
  it('copies a project without what tools rebuild, keeps its git, and lists it', async () => {
    const info = await createSandbox(sandboxes, project, '', false, new Date('2026-10-18T10:00:00Z'))
    const folder = path.join(sandboxes, info.name)

    expect(info).toMatchObject({ name: 'mon-site', source: project, full: false })
    expect(fs.readFileSync(path.join(folder, 'src', 'app.js'), 'utf8')).toBe('v1')
    expect(fs.existsSync(path.join(folder, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(folder, '.git', 'HEAD'))).toBe(true)
    expect(listSandboxes(sandboxes).map(s => s.name)).toEqual(['mon-site'])
    expect(await compareSandbox(sandboxes, 'mon-site')).toEqual([])
  })

  it('refuses a sandbox inside the project, or a project inside the sandboxes', async () => {
    await expect(createSandbox(path.join(project, 'boxes'), project, 'x')).rejects.toThrow('overlaps')
    await expect(createSandbox(sandboxes, path.join(base, 'missing'), 'x')).rejects.toThrow('not-a-folder')
  })

  it('compares, then applies changes, sending removed files to the trash', async () => {
    await createSandbox(sandboxes, project, 'essai')
    const folder = path.join(sandboxes, 'essai')
    fs.writeFileSync(path.join(folder, 'src', 'app.js'), 'v2')
    fs.writeFileSync(path.join(folder, 'src', 'new.js'), 'new')
    fs.rmSync(path.join(folder, 'old.txt'))

    expect(await compareSandbox(sandboxes, 'essai')).toEqual([
      { path: 'old.txt', kind: 'removed' },
      { path: path.join('src', 'app.js'), kind: 'modified' },
      { path: path.join('src', 'new.js'), kind: 'added' }
    ])

    const trashed: string[] = []
    const applied = await applySandbox(sandboxes, 'essai', async file => {
      trashed.push(file)
      fs.rmSync(file)
    })

    expect(applied).toHaveLength(3)
    expect(fs.readFileSync(path.join(project, 'src', 'app.js'), 'utf8')).toBe('v2')
    expect(fs.readFileSync(path.join(project, 'src', 'new.js'), 'utf8')).toBe('new')
    expect(trashed).toEqual([path.join(project, 'old.txt')])
    expect(fs.existsSync(path.join(project, 'node_modules', 'lib', 'index.js'))).toBe(true)
    expect(await compareSandbox(sandboxes, 'essai')).toEqual([])
  })

  it('applies only the changes asked for', async () => {
    await createSandbox(sandboxes, project, 'essai')
    fs.writeFileSync(path.join(sandboxes, 'essai', 'README.md'), 'changed')
    fs.writeFileSync(path.join(sandboxes, 'essai', 'src', 'app.js'), 'v2')

    await applySandbox(sandboxes, 'essai', async () => undefined, ['README.md'])

    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('changed')
    expect(fs.readFileSync(path.join(project, 'src', 'app.js'), 'utf8')).toBe('v1')
  })

  it('knows only its own sandboxes', async () => {
    await expect(compareSandbox(sandboxes, '..')).rejects.toThrow('not-a-sandbox')
    await expect(compareSandbox(sandboxes, 'nope')).rejects.toThrow('not-a-sandbox')
  })
})
