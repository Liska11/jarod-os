/** Two minutes of speech: what the PC accepts (MAX_VOICE_BYTES), with margin. */
export const MAX_RECORDING_MS = 120_000

const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

export interface Recording {
  stop(): Promise<{ audio: string; mime: string; ms: number }>
  cancel(): void
}

/** Starts recording a voice message. The microphone is released as soon as it stops. */
export async function startRecording(onAutoStop?: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) ?? ''
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined)
  const chunks: Blob[] = []
  const started = Date.now()
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
  recorder.start(1000)
  const release = () => stream.getTracks().forEach(t => t.stop())
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
