/** Two minutes of speech: what the PC accepts (MAX_VOICE_BYTES), with margin. */
export const MAX_RECORDING_MS = 120_000

const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

export interface Recording {
  stop(): Promise<{ audio: string; mime: string; ms: number }>
  cancel(): void
}

/**
 * How loud a frame is, 0 to 1: the RMS of the samples (bytes centred on 128), lifted so that speech
 * at a normal distance fills most of the range.
 */
export function levelOf(samples: Uint8Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (const v of samples) {
    const x = (v - 128) / 128
    sum += x * x
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}

/**
 * Starts recording a voice message. The microphone is released as soon as it stops. `onLevel`, if
 * given, hears the voice's loudness about 15 times a second (the live conversation's animation).
 */
export async function startRecording(onAutoStop?: () => void, onLevel?: (level: number) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) ?? ''
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined)
  const chunks: Blob[] = []
  const started = Date.now()
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
  recorder.start(1000)
  let meter: (() => void) | null = null
  if (onLevel) {
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(samples)
        onLevel(levelOf(samples))
      }, 66)
      meter = () => {
        clearInterval(timer)
        void ctx.close()
      }
    } catch {
      // No Web Audio: the recording works, the animation just does not follow the voice.
    }
  }
  const release = () => {
    meter?.()
    meter = null
    stream.getTracks().forEach(t => t.stop())
  }
  const limit = setTimeout(() => onAutoStop?.(), MAX_RECORDING_MS)
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        clearTimeout(limit)
        recorder.onstop = async () => {
          release()
          const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })
          if (!blob.size) return reject(new Error('Rien n’a été enregistré.'))
          resolve({ audio: await toBase64(blob), mime: blob.type, ms: Date.now() - started })
        }
        recorder.stop()
      }),
    cancel: () => {
      clearTimeout(limit)
      recorder.onstop = release
      recorder.stop()
    }
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
