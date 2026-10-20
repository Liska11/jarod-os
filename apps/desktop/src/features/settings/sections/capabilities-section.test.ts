import { describe, expect, it } from 'vitest'
import { type CapabilityRow, splitRows } from './CapabilitiesSection.tsx'

const row = (id: string, state: CapabilityRow['state']): CapabilityRow => ({ id, name: id, description: '', owner: 'x', integration: 'detection-only', state, detail: '', locality: 'local', limits: [] })

describe('Capabilities screen', () => {
  it('lists integrations one by one and folds the agent tools into a count', () => {
    const { own, tools } = splitRows([row('ghidra.static-analysis', 'available'), row('tool.read_file', 'available'), row('tool.run_shell', 'blocked-permission')])

    expect(own.map(r => r.id)).toEqual(['ghidra.static-analysis'])
    expect(tools).toEqual({ total: 2, available: 1, blocked: 1 })
  })
})
