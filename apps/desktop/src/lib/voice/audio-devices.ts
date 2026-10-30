/*
 * Choix du micro (lot 5, 30/10 : idée de Mark-LVI `core/audio_devices.py`, principe seulement). Sans choix, la capture prend « le micro par défaut de
 * Windows », qui est souvent un casque inactif ou la webcam. Le choix est gardé dans ce navigateur (par appareil, pas dans le profil).
 */

const KEY = 'jarod-os.voice.inputDeviceId'

export interface InputDevice {
  id: string
  label: string
}

export function preferredInputId(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setPreferredInputId(id: string): void {
  try {
    if (id) {
      localStorage.setItem(KEY, id)
    } else {
      localStorage.removeItem(KEY)
    }
  } catch {
    // Sans stockage, le choix ne dure que jusqu'au rechargement.
  }
}

/** Les micros, hors entrées virtuelles « default » / « communications » (Windows les répète). Les noms n'apparaissent qu'une fois l'accès accordé. */
export async function listInputDevices(): Promise<InputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices()

  return all
    .filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

/** Les contraintes de capture : le micro choisi s'il existe encore, sinon le défaut (jamais d'échec parce qu'un casque a été débranché). */
export function micConstraints(preferred: string, known: readonly string[] | null): MediaTrackConstraints {
  const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }

  return preferred && (known === null || known.includes(preferred)) ? { ...base, deviceId: { exact: preferred } } : base
}

/** Niveau (0 à 1) d'un bloc d'échantillons audio flottants : racine de la moyenne des carrés, étalée pour qu'une voix normale remplisse la jauge. */
export function levelOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0
  }

  let sum = 0

  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }

  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}
