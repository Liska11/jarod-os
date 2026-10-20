import { atom } from 'nanostores'
import type { NetworkPolicy } from '../../shared/network-policy.ts'

/** Jarod's Internet policy, as main holds it (null until read). Every window follows the same switch. */
export const $network = atom<NetworkPolicy | null>(null)

let bound = false

export function bindNetwork(): void {
  if (bound || typeof window === 'undefined' || !window.jarodOS?.network) {
    return
  }

  bound = true
  void window.jarodOS.network
    .get()
    .then(policy => $network.set(policy))
    .catch(() => undefined)
  window.jarodOS.network.onChanged(policy => $network.set(policy))
}

export async function setNetwork(change: Partial<Omit<NetworkPolicy, 'version'>>): Promise<NetworkPolicy> {
  const next = await window.jarodOS.network.set(change)
  $network.set(next)

  return next
}

/** What the top bar says: on, off, or off with the remote machines still reachable. */
export function networkLabelKey(policy: NetworkPolicy | null): 'network.switch.on' | 'network.switch.off' | 'network.switch.remote' {
  if (!policy || policy.internet) {
    return 'network.switch.on'
  }

  return policy.remoteMachines && policy.remoteHosts.length > 0 ? 'network.switch.remote' : 'network.switch.off'
}
