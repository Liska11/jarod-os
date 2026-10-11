import { describe, expect, it } from 'vitest'
import type { RecentFile } from '../../shared/ipc.ts'
import { appNameFromCommand, mergeRecent, parseGitLog, parseGitStatus } from './snapshot.ts'

describe('parseGitStatus', () => {
  it('reads the branch and the changed paths', () => {
    const out = ['## main...origin/main [ahead 2]', ' M src/app.ts', '?? notes.md', 'R  old.ts -> new.ts', ''].join('\n')

    expect(parseGitStatus(out)).toEqual({ branch: 'main', changed: ['src/app.ts', 'notes.md', 'new.ts'] })
  })

  it('handles a fresh repository and a detached head', () => {
    expect(parseGitStatus('## No commits yet on trunk\n?? a.txt\n')).toEqual({ branch: 'trunk', changed: ['a.txt'] })
    expect(parseGitStatus('## HEAD (no branch)\n').branch).toBeUndefined()
  })

  it('unquotes paths git quotes', () => {
    expect(parseGitStatus('## main\n?? "with space.txt"\n').changed).toEqual(['with space.txt'])
  })
})

describe('parseGitLog', () => {
  it('reads commits newest first and skips blank or broken lines', () => {
    expect(parseGitLog('1791100000\tAdd the menu page\n1791000000\tFix: tabs\tin subject\n\nnot a commit\n')).toEqual([
      { subject: 'Add the menu page', at: 1791100000000 },
      { subject: 'Fix: tabs\tin subject', at: 1791000000000 }
    ])
  })
})

describe('appNameFromCommand', () => {
  it('names app bundles, including Apple apps', () => {
    expect(appNameFromCommand('/Applications/Keynote.app/Contents/MacOS/Keynote')).toBe('Keynote')
    expect(appNameFromCommand('/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams')).toBe('Microsoft Teams')
    expect(appNameFromCommand('/System/Applications/Preview.app/Contents/MacOS/Preview')).toBe('Preview')
  })

  it('skips helpers, system services, plain binaries and Jarod-OS itself', () => {
    expect(appNameFromCommand('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper')).toBeNull()
    expect(appNameFromCommand('/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock')).toBeNull()
    expect(appNameFromCommand('/usr/sbin/cfprefsd')).toBeNull()
    expect(appNameFromCommand('/Users/sam/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toBeNull()
  })
})

describe('mergeRecent', () => {
  const file = (path: string, lastUsedAt: number, modifiedAt: number): RecentFile => ({ path, name: path.split('/').pop()!, extension: '', size: 1, modifiedAt, lastUsedAt, kind: 'file' })

  it('keeps one row per path with the newest times, newest first, inside the window', () => {
    const rows = mergeRecent([file('/a', 100, 50), file('/b', 0, 300), file('/a', 0, 200), file('/old', 5, 5)], 40)

    expect(rows.map(r => r.path)).toEqual(['/b', '/a'])
    expect(rows[1]).toMatchObject({ lastUsedAt: 100, modifiedAt: 200 })
  })
})
