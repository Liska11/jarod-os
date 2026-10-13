import { describe, expect, it } from 'vitest'
import { invalidNameCharacter, isAbsolutePath, joinPath, normalizeDir, parentOf, parsePath, segmentsBelow } from './host-path.ts'

describe('parsePath', () => {
  it('reads drives with either separator, shares and POSIX paths', () => {
    expect(parsePath('C:\\Users\\San')).toEqual({ root: 'C:\\', segments: ['Users', 'San'], windows: true })
    expect(parsePath('c:/Users/San/')).toEqual({ root: 'C:\\', segments: ['Users', 'San'], windows: true })
    expect(parsePath('\\\\nas\\photos\\2026')).toEqual({ root: '\\\\nas\\photos\\', segments: ['2026'], windows: true })
    expect(parsePath('/home/san')).toEqual({ root: '/', segments: ['home', 'san'], windows: false })
    expect(parsePath('notes/a.md')).toEqual({ root: '', segments: ['notes', 'a.md'], windows: false })
  })
})

describe('parentOf', () => {
  it('goes up on Windows as on POSIX, and stops at a root', () => {
    expect(parentOf('C:\\Users\\San\\Documents')).toBe('C:\\Users\\San')
    expect(parentOf('C:\\Users')).toBe('C:\\')
    expect(parentOf('C:\\')).toBeNull()
    expect(parentOf('\\\\nas\\photos\\2026')).toBe('\\\\nas\\photos\\')
    expect(parentOf('/home/san/')).toBe('/home')
    expect(parentOf('/home')).toBe('/')
    expect(parentOf('/')).toBeNull()
    expect(parentOf('')).toBeNull()
  })
})

describe('joinPath and normalizeDir', () => {
  it('joins with the folder’s own separator', () => {
    expect(joinPath('C:\\Users\\San', 'New folder')).toBe('C:\\Users\\San\\New folder')
    expect(joinPath('C:\\', 'Temp')).toBe('C:\\Temp')
    expect(joinPath('/', 'tmp')).toBe('/tmp')
    expect(joinPath('/home/san', 'a.txt')).toBe('/home/san/a.txt')
  })

  it('drops trailing separators but keeps a root whole', () => {
    expect(normalizeDir('C:\\Users\\San\\')).toBe('C:\\Users\\San')
    expect(normalizeDir('C:/Users/San')).toBe('C:\\Users\\San')
    expect(normalizeDir('C:\\')).toBe('C:\\')
    expect(normalizeDir('/home/san//')).toBe('/home/san')
    expect(normalizeDir('/')).toBe('/')
  })
})

describe('segmentsBelow', () => {
  it('lists what lies under a base, without case on Windows', () => {
    expect(segmentsBelow('C:\\Users\\San\\Documents\\x', 'c:\\users\\san')).toEqual(['Documents', 'x'])
    expect(segmentsBelow('C:\\Users\\San', 'C:\\Users\\San\\')).toEqual([])
    expect(segmentsBelow('/home/san/a', '/home/san')).toEqual(['a'])
  })

  it('refuses a sibling that only shares a prefix, another drive or another family', () => {
    expect(segmentsBelow('C:\\Users\\Sandra', 'C:\\Users\\San')).toBeNull()
    expect(segmentsBelow('D:\\Users\\San', 'C:\\Users\\San')).toBeNull()
    expect(segmentsBelow('/home/San', '/home/san')).toBeNull()
    expect(segmentsBelow('/home/san', 'C:\\home\\san')).toBeNull()
  })
})

describe('names and absolute paths', () => {
  it('refuses Windows’ reserved characters only on a Windows path', () => {
    expect(invalidNameCharacter('a\\b', true)).toBe('\\')
    expect(invalidNameCharacter('what?', true)).toBe('?')
    expect(invalidNameCharacter('a\\b', false)).toBeNull()
    expect(invalidNameCharacter('a/b', false)).toBe('/')
    expect(invalidNameCharacter('Report 2026.pdf', true)).toBeNull()
  })

  it('knows an absolute path of either family', () => {
    expect(isAbsolutePath('C:\\x')).toBe(true)
    expect(isAbsolutePath('\\\\nas\\share')).toBe(true)
    expect(isAbsolutePath('/x')).toBe(true)
    expect(isAbsolutePath('x/y')).toBe(false)
  })
})
