import { describe, expect, it } from 'vitest'
import { type CapabilityRow, splitRows } from './CapabilitiesSection.tsx'

const row = (id: string, state: CapabilityRow['state']): CapabilityRow => ({ id, name: id, description: '', owner: 'x', integration: 'detection-only', state, detail: '', locality: 'local', limits: [] })

describe('Capabilities screen', () => {
  it('lists integrations one by one and folds the agent tools into a count', () => {
    const { own, tools } = splitRows([row('ghidra.static-analysis', 'available'), row('tool.read_file', 'available'), row('tool.run_shell', 'blocked-permission')])

    expect(own.map(r => r.id)).toEqual(['ghidra.static-analysis'])
    expect(tools).toEqual({ total: 2, available: 1, blocked: 1 })
  })

  it('V-12: the shell surface, its window and the Rust host get their own groups, out of the integration list', () => {
    const groups = splitRows([row('ghidra.static-analysis', 'available'), row('shell.state', 'available'), row('shell.page', 'available'), row('ui.page.open', 'available'), row('rust.host-sandbox', 'not-installed')])

    expect(groups.own.map(r => r.id)).toEqual(['ghidra.static-analysis'])
    expect(groups.shell.map(r => r.id)).toEqual(['shell.state', 'shell.page'])
    expect(groups.window.map(r => r.id)).toEqual(['ui.page.open'])
    expect(groups.rust.map(r => r.id)).toEqual(['rust.host-sandbox'])
  })
})
