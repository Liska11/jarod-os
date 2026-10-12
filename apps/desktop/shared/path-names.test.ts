import { describe, expect, it } from 'vitest'
import { baseName, folderPart, lastSeparator, segmentsOf } from './path-names.ts'

describe('baseName', () => {
  it('takes the last segment of a Windows, POSIX or mixed path', () => {
    expect(baseName('C:\\Users\\San\\notes.txt')).toBe('notes.txt')
    expect(baseName('/home/san/notes.txt')).toBe('notes.txt')
    expect(baseName('C:\\Users/San\\Documents/notes.txt')).toBe('notes.txt')
  })

  it('ignores trailing separators and keeps a drive or a root readable', () => {
    expect(baseName('C:\\Users\\San\\Documents\\')).toBe('Documents')
    expect(baseName('/home/san/')).toBe('san')
    expect(baseName('C:\\')).toBe('C:')
    expect(baseName('/')).toBe('/')
    expect(baseName('')).toBe('')
    expect(baseName('plain')).toBe('plain')
  })
})

describe('segmentsOf / folderPart / lastSeparator', () => {
  it('splits on both separators and drops the empty parts', () => {
    expect(segmentsOf('C:\\a\\b/c')).toEqual(['C:', 'a', 'b', 'c'])
    expect(segmentsOf('//a//b/')).toEqual(['a', 'b'])
  })

  it('finds the folder of a path with either separator', () => {
    expect(folderPart('C:\\Users\\San\\a.txt')).toBe('C:\\Users\\San')
    expect(folderPart('/home/san/a.txt')).toBe('/home/san')
    expect(folderPart('a.txt')).toBe('')
    expect(lastSeparator('C:\\x/y')).toBe(4)
    expect(lastSeparator('none')).toBe(-1)
  })
})
