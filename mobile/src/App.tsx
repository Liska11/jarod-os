import type { CryptoKeyPair } from '@jarod-protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DeniedError, type JarodChannel, type PushedEvent } from './lib/channel.ts'
import { isNative } from './lib/native.ts'
import { loadPc, type PairedPc } from './lib/pairing-store.ts'
import { connect, forget } from './lib/session.ts'
import { ChatScreen } from './screens/ChatScreen.tsx'
import { LockScreen } from './screens/LockScreen.tsx'
import { PairScreen } from './screens/PairScreen.tsx'

/** Away longer than this, the app locks itself: the device key leaves memory. */
const AUTO_LOCK_MS = 5 * 60_000

export type Link = 'connecting' | 'online' | 'offline'

type State =
  | { screen: 'pair'; notice?: string }
  | { screen: 'locked'; pc: PairedPc; notice?: string }
  | { screen: 'ready'; pc: PairedPc; keys: CryptoKeyPair }

export function App() {
  const [state, setState] = useState<State>(() => {
    const pc = loadPc()
    return pc ? { screen: 'locked', pc } : { screen: 'pair' }
  })
  const [channel, setChannel] = useState<JarodChannel | null>(null)
  const [link, setLink] = useState<Link>('offline')
  const listeners = useRef(new Set<(e: PushedEvent) => void>())
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempt = useRef(0)
  const live = useRef<JarodChannel | null>(null)

  const onEvent = useCallback((e: PushedEvent) => {
    for (const l of listeners.current) l(e)
  }, [])

  const subscribe = useCallback((fn: (e: PushedEvent) => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])

  const lock = useCallback((notice?: string) => {
    if (retry.current) clearTimeout(retry.current)
    live.current?.close()
    live.current = null
    setChannel(null)
    setLink('offline')
    setState(s => (s.screen === 'pair' ? s : { screen: 'locked', pc: loadPc() ?? s.pc, notice }))
  }, [])

  const dial = useCallback(
    async (pc: PairedPc, keys: CryptoKeyPair) => {
      setLink('connecting')
      try {
        const ch = await connect(pc, keys, {
          onEvent,
          onClose: () => {
            if (live.current !== ch) return
            live.current = null
            setChannel(null)
            setLink('offline')
            schedule(pc, keys)
          }
        })
        attempt.current = 0
        live.current = ch
        setChannel(ch)
        setLink('online')
      } catch (e) {
        if (e instanceof DeniedError) {
          // Revoked on the PC: nothing left to unlock.
          await forget(null)
          setState({ screen: 'pair', notice: `Ce téléphone n’est plus associé : ${e.message}` })
          return
        }
        setLink('offline')
        schedule(pc, keys)
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: schedule is stable through refs
    [onEvent]
  )

  const schedule = (pc: PairedPc, keys: CryptoKeyPair) => {
    if (retry.current) clearTimeout(retry.current)
    if (document.hidden) return
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt.current++, 5))
    retry.current = setTimeout(() => void dial(pc, keys), delay)
  }

  // Locks after a while in the background; reconnects when back.
  useEffect(() => {
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) return lock('Verrouillé après 5 minutes d’absence.')
      if (state.screen === 'ready' && !live.current) {
        attempt.current = 0
        void dial(state.pc, state.keys)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [state, dial, lock])

  useEffect(() => () => live.current?.close(), [])

  if (state.screen === 'pair') {
    return (
      <PairScreen
        notice={state.notice}
        onPaired={(pc, keys, ch) => {
          // The pairing channel has done its job; the normal one (with reconnection) takes over.
          ch.close()
          setState({ screen: 'ready', pc, keys })
          void dial(pc, keys)
        }}
      />
    )
  }
  if (state.screen === 'locked') {
    return (
      <LockScreen
        pc={state.pc}
        notice={state.notice ?? (isNative ? undefined : 'Mode développement : la clé n’est pas protégée par le Keystore.')}
        onUnlocked={keys => {
          setState({ screen: 'ready', pc: state.pc, keys })
          void dial(state.pc, keys)
        }}
        onForgotten={() => setState({ screen: 'pair' })}
      />
    )
  }
  return (
    <ChatScreen
      pc={state.pc}
      channel={channel}
      link={link}
      subscribe={subscribe}
      onLock={() => lock()}
      onPcChanged={pc => setState({ ...state, pc })}
      onForgotten={() => {
        live.current = null
        setChannel(null)
        setState({ screen: 'pair' })
      }}
    />
  )
}
