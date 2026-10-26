import type { CryptoKeyPair } from '@jarod-protocol'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/icons.tsx'
import { Button, Dialog } from '../components/ui.tsx'
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

  const [forgetting, setForgetting] = useState(false)

  return (
    <main className="screen center">
      <span className="auth-mark">
        <Icon name="lock" size={32} />
      </span>
      <h1 className="brand">Jarod</h1>
      <p className="muted">
        Associé à <b>{pc.name}</b> depuis le {new Date(pc.pairedAt).toLocaleDateString()}.
      </p>
      {notice && <p className="note">{notice}</p>}
      {error && <p className="note danger">{error}</p>}
      <Button tone="filled" icon="lock" wide disabled={busy} feel="tap" onClick={() => void open()}>
        Déverrouiller
      </Button>
      <Button tone="text" disabled={busy} onClick={() => setForgetting(true)}>
        Oublier ce PC
      </Button>
      <Dialog
        open={forgetting}
        onClose={() => setForgetting(false)}
        title={`Oublier ${pc.name} ?`}
        actions={
          <>
            <Button tone="text" onClick={() => setForgetting(false)}>
              Annuler
            </Button>
            <Button
              tone="danger"
              feel="warn"
              onClick={async () => {
                await forget(null)
                onForgotten()
              }}
            >
              Oublier ce PC
            </Button>
          </>
        }
      >
        <p>Il faudra l’associer à nouveau avec un code.</p>
      </Dialog>
    </main>
  )
}