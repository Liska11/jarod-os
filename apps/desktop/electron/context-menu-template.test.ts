import { describe, expect, it, vi } from 'vitest'
import { contextMenuTemplate, isWebUrl, type MenuActions, type MenuParams } from './context-menu-template.ts'

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const params = (over: Partial<MenuParams> = {}): MenuParams => ({
  isEditable: false,
  selectionText: '',
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  misspelledWord: '',
  dictionarySuggestions: [],
  x: 10,
  y: 20,
  editFlags: flags,
  ...over
})
const actions = (): MenuActions => ({ replaceMisspelling: vi.fn(), addToDictionary: vi.fn(), copyText: vi.fn(), openLink: vi.fn(), copyImageAt: vi.fn() })
const roles = (items: { role?: string; type?: string }[]) => items.map(i => i.role ?? i.type)

describe('contextMenuTemplate', () => {
  it('in a text field: undo/redo, cut/copy/paste, select all, each enabled by what the field allows', () => {
    const t = contextMenuTemplate(params({ isEditable: true, editFlags: { ...flags, canCut: false, canPaste: true } }), actions())

    expect(roles(t)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    expect(t.find(i => i.role === 'cut')?.enabled).toBe(false)
    expect(t.find(i => i.role === 'paste')?.enabled).toBe(true)
    expect(t.find(i => i.role === 'redo')?.enabled).toBe(false)
  })

  it('on selected page text: copy and select all only', () => {
    expect(roles(contextMenuTemplate(params({ selectionText: 'bonjour' }), actions()))).toEqual(['copy', 'separator', 'selectAll'])
  })

  it('on plain page text with nothing selected: just select all; nothing at all when even that is impossible', () => {
    expect(roles(contextMenuTemplate(params(), actions()))).toEqual(['selectAll'])
    expect(contextMenuTemplate(params({ editFlags: { ...flags, canSelectAll: false } }), actions())).toEqual([])
  })

  it('a misspelled word: up to five suggestions then "add to dictionary", each wired to its action', () => {
    const a = actions()
    const t = contextMenuTemplate(params({ isEditable: true, misspelledWord: 'bonjoure', dictionarySuggestions: ['bonjour', 'bonjours', 'a', 'b', 'c', 'd'] }), a, 'fr-FR')

    expect(t.slice(0, 6).map(i => i.label)).toEqual(['bonjour', 'bonjours', 'a', 'b', 'c', 'Ajouter au dictionnaire'])
    t[0]!.click!()
    t[5]!.click!()
    expect(a.replaceMisspelling).toHaveBeenCalledWith('bonjour')
    expect(a.addToDictionary).toHaveBeenCalledWith('bonjoure')
  })

  it('a link: open (web addresses only) and copy the address, in the interface language', () => {
    const a = actions()
    const web = contextMenuTemplate(params({ linkURL: 'https://example.com/x' }), a, 'en-US')

    expect(web.map(i => i.label)).toEqual(['Open link in browser', 'Copy link address'])
    web[0]!.click!()
    web[1]!.click!()
    expect(a.openLink).toHaveBeenCalledWith('https://example.com/x')
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/x')
    expect(contextMenuTemplate(params({ linkURL: 'file:///C:/secret.txt' }), a, 'en').map(i => i.label)).toEqual(['Copy link address'])
    expect(contextMenuTemplate(params({ linkURL: 'javascript:alert(1)' }), a, 'en').map(i => i.label)).toEqual(['Copy link address'])
  })

  it('an image: copy it from where the click was', () => {
    const a = actions()
    const t = contextMenuTemplate(params({ mediaType: 'image', srcURL: 'https://example.com/a.png' }), a, 'fr')

    expect(t.map(i => i.label)).toEqual(["Copier l'image"])
    t[0]!.click!()
    expect(a.copyImageAt).toHaveBeenCalledWith(10, 20)
  })
})

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('https://a.b')).toBe(true)
    expect(isWebUrl('http://a.b')).toBe(true)
    for (const bad of ['file:///x', 'javascript:1', 'mailto:a@b', 'jarod://x', 'pas une adresse', '']) expect(isWebUrl(bad)).toBe(false)
  })
})
