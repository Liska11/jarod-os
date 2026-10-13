import { describe, expect, it } from 'vitest'
import { buildCrumbs } from './crumbs.ts'

const dir = (path: string) => ({ kind: 'dir' as const, path })
const labels = (crumbs: ReturnType<typeof buildCrumbs>) => crumbs.map(crumb => crumb.label)
const paths = (crumbs: ReturnType<typeof buildCrumbs>) => crumbs.map(crumb => (crumb.location.kind === 'dir' ? crumb.location.path : crumb.location.kind))

describe('buildCrumbs on Windows', () => {
  const home = 'C:\\Users\\San'

  it('walks down from Home with Windows paths', () => {
    const crumbs = buildCrumbs(dir('C:\\Users\\San\\Documents\\Taxes'), 'C:\\Users\\San\\Documents\\Jarod-OS', 'Personal', home, 'win32')

    expect(labels(crumbs)).toEqual(['Home', 'Documents', 'Taxes'])
    expect(paths(crumbs)).toEqual(['C:\\Users\\San', 'C:\\Users\\San\\Documents', 'C:\\Users\\San\\Documents\\Taxes'])
  })

  it('starts from the space root when inside it, whatever the case', () => {
    const crumbs = buildCrumbs(dir('c:\\users\\san\\projects\\app\\src'), 'C:\\Users\\San\\Projects', 'Work', home, 'win32')

    expect(labels(crumbs)).toEqual(['Work', 'app', 'src'])
    expect(paths(crumbs).at(-1)).toBe('C:\\Users\\San\\Projects\\app\\src')
  })

  it('names the drive outside Home, and a network share by its path', () => {
    expect(labels(buildCrumbs(dir('D:\\Photos\\2026'), home, 'Personal', home, 'win32'))).toEqual(['Local Disk (D:)', 'Photos', '2026'])
    expect(paths(buildCrumbs(dir('D:\\Photos'), home, 'Personal', home, 'win32'))).toEqual(['D:\\', 'D:\\Photos'])
    expect(labels(buildCrumbs(dir('\\\\nas\\share\\docs'), home, 'Personal', home, 'win32'))).toEqual(['\\\\nas\\share', 'docs'])
  })

  it('does not take a sibling folder for Home', () => {
    expect(labels(buildCrumbs(dir('C:\\Users\\Sandra\\x'), home, 'Personal', home, 'win32'))).toEqual(['Local Disk (C:)', 'Users', 'Sandra', 'x'])
  })
})

describe('buildCrumbs on macOS and Linux', () => {
  it('keeps the POSIX behaviour', () => {
    expect(labels(buildCrumbs(dir('/Users/san/Documents'), '/Users/san/Projects', 'Work', '/Users/san', 'darwin'))).toEqual(['Home', 'Documents'])
    expect(labels(buildCrumbs(dir('/Volumes/USB'), '/Users/san', 'Personal', '/Users/san', 'darwin'))).toEqual(['Macintosh HD', 'Volumes', 'USB'])
    expect(paths(buildCrumbs(dir('/etc/nginx'), '/home/san', 'Personal', '/home/san', 'linux'))).toEqual(['/', '/etc', '/etc/nginx'])
    expect(labels(buildCrumbs(dir('/home/san/.Trash'), '/home/san', 'Personal', '/home/san', 'linux'))).toEqual(['Personal', 'Trash'])
  })

  it('shows Recent and Favorites under the space', () => {
    expect(labels(buildCrumbs({ kind: 'recent' }, '/home/san', 'Personal', '/home/san', 'linux'))).toEqual(['Personal', 'Recent'])
  })
})
