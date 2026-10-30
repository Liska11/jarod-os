import { IconMicrophone, IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { useT } from '../../../lib/i18n.ts'
import { type InputDevice, levelOf, listInputDevices, micConstraints, preferredInputId, setPreferredInputId } from '../../../lib/voice/audio-devices.ts'
import { ChoiceRow } from './jarod-controls.tsx'
import { SettingsRow } from './shared.tsx'

/*
 * Choix du micro et test avec jauge en direct (lot 5 : Mark-LVI « Audio Device Picker » et « Prove It Hears You »). Le test est la seule vérification
 * qu'une sonde sur du silence ne peut pas faire : on parle, la jauge bouge.
 */

export function MicrophoneRows() {
  const { t } = useT()
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [selected, setSelected] = useState(preferredInputId())
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const stopRef = useRef<(() => void) | null>(null)

  const refresh = useCallback(async () => {
    try {
      setDevices(await listInputDevices())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const media = navigator.mediaDevices
    media?.addEventListener?.('devicechange', refresh)

    return () => {
      media?.removeEventListener?.('devicechange', refresh)
      stopRef.current?.()
    }
  }, [refresh])

  const stop = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
    setTesting(false)
    setLevel(0)
  }, [])

  const start = useCallback(async () => {
    stop()
    setError('')

    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(selected, devices.map(d => d.id)), video: false })
      await refresh() // Les noms des micros ne sont donnés qu'après l'accord.
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(media).connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)
      let raf = 0
      const tick = () => {
        analyser.getFloatTimeDomainData(buffer)
        setLevel(levelOf(buffer))
        raf = requestAnimationFrame(tick)
      }
      tick()
      stopRef.current = () => {
        cancelAnimationFrame(raf)
        media.getTracks().forEach(track => track.stop())
        void ctx.close()
      }
      setTesting(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [devices, refresh, selected, stop])

  return (
    <>
      <ChoiceRow
        icon={<IconMicrophone />}
        label={t('speech.mic')}
        description={error || (devices.length ? t('speech.micHint') : t('speech.micNone'))}
        keywords={t('speech.micKw')}
        value={devices.some(d => d.id === selected) ? selected : ''}
        options={[{ id: '', label: t('speech.micDefault') }, ...devices.map(d => ({ id: d.id, label: d.label }))]}
        onChange={value => {
          stop()
          setSelected(value)
          setPreferredInputId(value)
        }}
      />
      <SettingsRow icon={<IconPlayerPlay />} label={t('speech.micTest')} description={testing ? t('speech.micTesting') : t('speech.micTestHint')} keywords={t('speech.micKw')}>
        <div className="h-2 w-32 overflow-hidden rounded-full bg-white/10" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label={t('speech.micTest')}>
          <div className="h-full rounded-full bg-ok transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        <GlassButton size="sm" variant="secondary" onClick={() => (testing ? stop() : void start())}>
          {testing ? <IconPlayerStop size={14} /> : <IconPlayerPlay size={14} />}
          {testing ? t('speech.micStop') : t('speech.micStart')}
        </GlassButton>
      </SettingsRow>
    </>
  )
}
