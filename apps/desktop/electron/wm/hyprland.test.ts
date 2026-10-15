import { describe, expect, it } from 'vitest'
import { detectCompositor } from './compositor.ts'
import { addressToId, dispatchArgs, dispatchLua, idToAddress, luaString, parseEvent, toState } from './hyprland.ts'

describe('detectCompositor', () => {
  it('reads the socket each compositor advertises', () => {
    expect(detectCompositor({ NIRI_SOCKET: '/run/user/1000/niri.sock' })).toBe('niri')
    expect(detectCompositor({ HYPRLAND_INSTANCE_SIGNATURE: 'abc_123' })).toBe('hyprland')
    expect(detectCompositor({})).toBeNull()
  })
})

describe('addresses', () => {
  it('round-trips a Hyprland address through a numeric id', () => {
    const id = addressToId('0x55d3a1b2c3d0')
    expect(id).toBe(0x55d3a1b2c3d0)
    expect(idToAddress(id as number)).toBe('address:0x55d3a1b2c3d0')
    expect(addressToId('')).toBeNull()
    expect(addressToId('nope')).toBeNull()
  })
})

describe('parseEvent', () => {
  it('splits the event socket lines', () => {
    expect(parseEvent('openwindow>>55d3a1b2c3d0,1,firefox,Mozilla Firefox')).toEqual({ name: 'openwindow', data: '55d3a1b2c3d0,1,firefox,Mozilla Firefox' })
    expect(parseEvent('garbage')).toBeNull()
  })
})

describe('toState', () => {
  const clients = [
    { address: '0x10', mapped: true, hidden: false, title: 'Jarod-OS', class: 'herald-os', pid: 4242, floating: false, workspace: { id: 1, name: '1' } },
    { address: '0x20', mapped: true, hidden: false, title: 'Inbox', class: 'firefox', pid: 99, floating: true, workspace: { id: 2, name: 'work' } },
    { address: '0x30', mapped: true, hidden: false, title: 'scratch', class: 'kitty', pid: 98, workspace: { id: -98, name: 'special:term' } },
    { address: '0x40', mapped: false, title: 'unmapped', class: 'x', pid: 97, workspace: { id: 1, name: '1' } }
  ]
  const workspaces = [
    { id: 2, name: 'work', monitor: 'DP-1', lastwindow: '0x20' },
    { id: 1, name: '1', monitor: 'eDP-1', lastwindow: '0x10' },
    { id: -98, name: 'special:term', monitor: 'eDP-1' }
  ]
  const monitors = [
    { name: 'eDP-1', focused: true, activeWorkspace: { id: 1 } },
    { name: 'DP-1', focused: false, activeWorkspace: { id: 2 } }
  ]

  it('mirrors mapped windows on normal workspaces, ours by pid', () => {
    const state = toState(clients, workspaces, monitors, { address: '0x10' }, 4242)
    expect(state.windows.map(w => [w.id, w.appId, w.ours, w.focused, w.floating])).toEqual([
      [0x10, 'herald-os', true, true, false],
      [0x20, 'firefox', false, false, true]
    ])
    expect(state.focusedWindowId).toBe(0x10)
  })

  it('marks active and focused workspaces from the monitors', () => {
    const state = toState(clients, workspaces, monitors, null, 4242)
    expect(state.workspaces).toEqual([
      { id: 1, idx: 1, name: null, output: 'eDP-1', active: true, focused: true, activeWindowId: 0x10 },
      { id: 2, idx: 2, name: 'work', output: 'DP-1', active: true, focused: false, activeWindowId: 0x20 }
    ])
    expect(state.focusedWindowId).toBeNull()
  })

  it('tolerates hyprctl failing', () => {
    expect(toState(null, null, null, null, 1)).toEqual({ available: true, windows: [], workspaces: [], focusedWindowId: null })
  })
})

describe('dispatchArgs', () => {
  it('maps shell actions to dispatchers', () => {
    expect(dispatchArgs({ type: 'focus-window', id: 0x20 })).toEqual([['focuswindow', 'address:0x20']])
    expect(dispatchArgs({ type: 'focus-workspace', ref: 'work' })).toEqual([['workspace', 'name:work']])
    expect(dispatchArgs({ type: 'focus-workspace', ref: 3 })).toEqual([['workspace', '3']])
    expect(dispatchArgs({ type: 'move-window-to-workspace', id: 0x20, ref: 'ideas' })).toEqual([['movetoworkspacesilent', 'name:ideas,address:0x20']])
    expect(dispatchArgs({ type: 'fullscreen', id: 0x20 })).toEqual([['focuswindow', 'address:0x20'], ['fullscreen', '0']])
  })

  it('has a Lua form of each for a Lua config', () => {
    expect(dispatchLua({ type: 'focus-workspace', ref: 'work' })).toEqual(['hl.dsp.focus({ workspace = "name:work" })'])
    expect(dispatchLua({ type: 'move-window-to-workspace', id: 0x20, ref: 3 })).toEqual([
      'hl.dsp.window.move({ workspace = "3", window = "address:0x20", follow = false })'
    ])
    expect(dispatchLua({ type: 'fullscreen', id: 0x20 })).toEqual(['hl.dsp.focus({ window = "address:0x20" })', 'hl.dsp.window.fullscreen({ mode = "fullscreen" })'])
    expect(dispatchLua({ type: 'toggle-floating', id: 0x20 })).toEqual(['hl.dsp.window.float({ action = "toggle", window = "address:0x20" })'])
  })

  it('keeps a Space name a single Lua string', () => {
    expect(luaString('Ideas "2"\\\n')).toBe('"Ideas \\"2\\"\\\\\\n"')
    expect(dispatchLua({ type: 'focus-workspace', ref: 'a") os.exit() --' })).toEqual(['hl.dsp.focus({ workspace = "name:a\\") os.exit() --" })'])
  })
})

describe('named workspaces', () => {
  it('keeps them, after the numbered ones, and leaves scratchpads out', () => {
    const clients = [{ address: '0x50', mapped: true, title: 'Notes', class: 'obsidian', pid: 5, workspace: { id: -1337, name: 'Ideas' } }]
    const workspaces = [
      { id: -1337, name: 'Ideas', monitor: 'eDP-1', lastwindow: '0x50' },
      { id: 1, name: '1', monitor: 'eDP-1' },
      { id: -98, name: 'special:scratchpad', monitor: 'eDP-1' }
    ]
    const state = toState(clients, workspaces, [{ name: 'eDP-1', focused: true, activeWorkspace: { id: -1337 } }], { address: '0x50' }, 1)
    expect(state.workspaces.map(space => [space.id, space.name, space.focused])).toEqual([
      [1, null, false],
      [-1337, 'Ideas', true]
    ])
    expect(state.windows.map(w => [w.id, w.workspaceId])).toEqual([[0x50, -1337]])
  })
})
