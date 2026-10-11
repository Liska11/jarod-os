import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extraHermesDirs } from './resolve.ts'
import { expandWindowsVars, mergePaths, parseRegPath } from './shell-env.ts'

describe('parseRegPath', () => {
  it('reads the Path value of reg query output, expandable or not', () => {
    const expandable = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\sam\\AppData\\Local\\hermes\\bin;%USERPROFILE%\\bin\r\n\r\n'
    const plain = 'HKEY_LOCAL_MACHINE\\x\r\n    Path    REG_SZ    C:\\Windows;C:\\Windows\\System32\r\n'

    expect(parseRegPath(expandable)).toBe('C:\\Users\\sam\\AppData\\Local\\hermes\\bin;%USERPROFILE%\\bin')
    expect(parseRegPath(plain)).toBe('C:\\Windows;C:\\Windows\\System32')
    expect(parseRegPath('ERROR: The system was unable to find the specified registry key or value.')).toBe('')
  })
})

describe('expandWindowsVars', () => {
  it('expands %NAME% case-insensitively and leaves unknown names alone', () => {
    const env = { USERPROFILE: 'C:\\Users\\sam', SystemRoot: 'C:\\Windows' }

    expect(expandWindowsVars('%userprofile%\\bin;%SYSTEMROOT%\\System32;%NOPE%\\x', env)).toBe('C:\\Users\\sam\\bin;C:\\Windows\\System32;%NOPE%\\x')
  })
})

describe('mergePaths', () => {
  it('keeps the first occurrence, comparing case-insensitively when asked', () => {
    const lists = [['C:\\Hermes\\bin', 'C:\\Win'], ['c:\\hermes\\BIN', '', 'D:\\tools']]

    expect(mergePaths(lists, true).split(path.delimiter)).toEqual(['C:\\Hermes\\bin', 'C:\\Win', 'D:\\tools'])
    expect(mergePaths([['/a', '/b'], ['/a', '/B']], false).split(path.delimiter)).toEqual(['/a', '/b', '/B'])
  })
})

describe('extraHermesDirs', () => {
  it("looks in the Hermes home's bin folder on Windows, honouring HERMES_HOME", () => {
    expect(extraHermesDirs('win32', 'C:\\Users\\sam', { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' })).toEqual(['C:\\Users\\sam\\AppData\\Local\\hermes\\bin'])
    expect(extraHermesDirs('win32', 'C:\\Users\\sam', { HERMES_HOME: 'D:\\agent' })).toEqual(['D:\\agent\\bin'])
  })

  it('keeps the user bin folders elsewhere', () => {
    expect(extraHermesDirs('linux', '/home/sam', {})).toContain(path.join('/home/sam', '.local', 'bin'))
  })
})
