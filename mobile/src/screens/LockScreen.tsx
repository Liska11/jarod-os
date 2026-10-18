import type { CryptoKeyPair } from '@jarod-protocol'
import { useEffect, useRef, useState } from 'react'
import type { PairedPc } from '../lib/pairing-store.ts'
import { forget, unlock } from '../lib/session.ts'

interface Props {
  pc: PairedPc
  notice?: string
  onUnlocked: (keys: CryptoKeyPair) => void
  onForgotten: () => void
}

export function LockScreen({ pc, notice, onUnlocked, onForgotten }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const asked = useRef(false)

  const open = async () => {
    setBusy(true)
    setError('')
    try {
      onUnlocked(await unlock(pc))
    } catch (e) {
      const msg = (e as Error).message
      setError(/invalidated|KeyPermanentlyInvalidated/i.test(msg) ? 'Les empreintes du téléphone ont changé : la clé ne peut plus être ouverte. Associez ce téléphone à nouveau.' : msg || 'Déverrouillage annulé.')
    } finally {
      setBusy(false)
    }
  }

  // The prompt comes up by itself once, when the app opens.
  useEffect(() => {
    if (asked.current || notice) return
    asked.current = true
    void open()
    // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  }, [])

  return (
    <main className="screen center">
      <h1 className="brand">Jarod</h1>
      <p className="muted">
        Associé à <b>{pc.name}</b> depuis le {new Date(pc.pairedAt).toLocaleDateString()}.
      </p>
      {notice && <p className="note">{notice}</p>}
      {error && <p className="note danger">{error}</p>}
      <button type="button" className="primary wide" disabled={busy} onClick={() => void open()}>
        Déverrouiller
      </button>
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(`Oublier ${pc.name} ? Il faudra l’associer à nouveau avec un code.`)) return
          await forget(null)
          onForgotten()
        }}
      >
        Oublier ce PC
      </button>
    </main>
  )
}
