import type { CryptoKeyPair } from '@jarod-protocol'
import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'
import { DeniedError, type JarodChannel } from '../lib/channel.ts'
import { launch } from '../lib/native.ts'
import { parsePairingLink } from '../lib/pairing-link.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { pair } from '../lib/session.ts'

interface Props {
  notice?: string
  onPaired: (pc: PairedPc, keys: CryptoKeyPair, channel: JarodChannel) => void
}

export function PairScreen({ notice, onPaired }: Props) {
  const [text, setText] = useState('')
  const [name, setName] = useState('Mon téléphone')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const link = parsePairingLink(text)

  // Opened by the phone's camera on the PC's QR code: the link is already here.
  useEffect(() => {
    void launch.take().then(({ link: l }) => l && setText(l))
    const sub = launch.addListener('link', ({ link: l }) => setText(l))
    return () => void sub.then(s => s.remove())
  }, [])

  // The QR code is decoded here, in the app: no scanning service, no Google library.
  useEffect(() => {
    if (!scanning) return
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const tick = () => {
      const v = video.current
      if (stopped || !v || v.readyState < 2) {
        timer = window.setTimeout(tick, 200)
        return
      }
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(v, 0, 0)
      const found = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
      if (found?.data && parsePairingLink(found.data)) {
        setText(found.data)
        setScanning(false)
        return
      }
      timer = window.setTimeout(tick, 250)
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => {
        stream = s
        if (stopped) return s.getTracks().forEach(t => t.stop())
        if (video.current) {
          video.current.srcObject = s
          void video.current.play()
        }
        tick()
      })
      .catch(() => {
        setError('Caméra indisponible : collez le lien affiché par le PC.')
        setScanning(false)
      })
    return () => {
      stopped = true
      clearTimeout(timer)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [scanning])

  const submit = async () => {
    if (!link) return
    setBusy(true)
    setError('')
    try {
      const { pc, keys, channel } = await pair(link, name.trim().slice(0, 60) || 'Téléphone', {})
      onPaired(pc, keys, channel)
    } catch (e) {
      setError(e instanceof DeniedError ? `Le PC a refusé : ${e.message} Affichez un nouveau code.` : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen center">
      <h1 className="brand">Jarod</h1>
      <p className="muted">Sur le PC : Réglages › Appareils › Pont téléphone › Afficher un code (onglet « Appli Jarod »).</p>
      {notice && <p className="note warn">{notice}</p>}
      {scanning ? (
        <div className="scanner">
          <video ref={video} playsInline muted />
          <button type="button" className="ghost" onClick={() => setScanning(false)}>
            Annuler
          </button>
        </div>
      ) : (
        <button type="button" className="primary wide" onClick={() => setScanning(true)} disabled={busy}>
          Scanner le QR code
        </button>
      )}
      <label className="field">
        <span>Ou collez le lien</span>
        <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="jarod://pair#…" spellCheck={false} autoCapitalize="off" />
      </label>
      {text && !link && <p className="note warn">Ce n’est pas un lien d’association Jarod valable.</p>}
      {link && (
        <p className="note">
          PC : <b>{link.name}</b> · {link.urls.length} adresse{link.urls.length > 1 ? 's' : ''} ({link.urls.map(u => new URL(u).hostname).join(', ') || 'aucune'})
        </p>
      )}
      <label className="field">
        <span>Nom de ce téléphone (affiché sur le PC)</span>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={60} />
      </label>
      {error && <p className="note danger">{error}</p>}
      <button type="button" className="primary wide" disabled={!link || busy} onClick={() => void submit()}>
        {busy ? 'Association…' : 'Associer'}
      </button>
      <p className="fine">
        La clé de ce téléphone est créée ici et protégée par votre empreinte, votre visage ou votre code. Le canal est chiffré de bout en bout ; rien ne passe par un service tiers.
      </p>
    </main>
  )
}
