import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ROOT_PREFIX } from './launch'

const roots = () => new Set(readdirSync(tmpdir()).filter(name => name.startsWith(ROOT_PREFIX) && /^[A-Za-z0-9]{6}$/.test(name.slice(ROOT_PREFIX.length))))

/**
 * A run must leave none of its throwaway roots in %TEMP%: the teardown names every root that appeared during the run and is still there,
 * and fails the run. Roots that were there before (older runs, other projects) are not this run's and are left alone.
 */
export default function globalSetup() {
  const before = roots()

  return () => {
    const left = [...roots()].filter(name => !before.has(name))

    if (left.length > 0) {
      throw new Error(`e2e run left ${left.length} throwaway root(s) in ${tmpdir()}: ${left.join(', ')}`)
    }
  }
}
