import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { $connectionEpoch } from '../store/gateway.ts'

export interface AsyncState<T> {
  data: T | null
  error: string | null
  /** True while a load runs, and also before the first connection: "not connected yet" is not "nothing to show". */
  loading: boolean
  /** The engine has not answered `gateway.ready` yet: nothing was asked, so an empty list means nothing. */
  connecting: boolean
  reload: () => void
}

/** Backend-owned data cannot be loaded before the first `gateway.ready` (epoch 0); until then pages must say they are waiting, not that they are empty. */
export function isConnecting(epoch: number, enabled: boolean): boolean {
  return enabled && epoch === 0
}

/**
 * Load backend-owned data; refetch on every (re)connect. Stale responses never overwrite newer
 * ones (generation guard), and `deps` re-run the loader.
 */
export function useBackendData<T>(loader: () => Promise<T>, deps: readonly unknown[] = [], options: { enabled?: boolean } = {}): AsyncState<T> {
  const epoch = useStore($connectionEpoch)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const enabled = options.enabled ?? true
  // Starts true when a load is due, so the first paint after a connection is "loading", not an empty page.
  const [loading, setLoading] = useState(enabled)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  const connecting = isConnecting(epoch, enabled)

  useEffect(() => {
    if (!enabled || epoch === 0) {
      return
    }

    const mine = ++generation.current
    setLoading(true)
    loader()
      .then(value => {
        if (mine === generation.current) {
          setData(value)
          setError(null)
        }
      })
      .catch(err => {
        if (mine === generation.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (mine === generation.current) {
          setLoading(false)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, tick, enabled, ...deps])

  const reload = useCallback(() => setTick(t => t + 1), [])

  return { data, error, loading: loading || connecting, connecting, reload }
}

/** Same shape for machine-owned data that does not depend on the backend. */
export function useLocalData<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const mine = ++generation.current
    setLoading(true)
    loader()
      .then(value => {
        if (mine === generation.current) {
          setData(value)
          setError(null)
        }
      })
      .catch(err => {
        if (mine === generation.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (mine === generation.current) {
          setLoading(false)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])

  const reload = useCallback(() => setTick(t => t + 1), [])

  return { data, error, loading, connecting: false, reload }
}
