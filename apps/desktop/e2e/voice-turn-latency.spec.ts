import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX, removeRoot } from './launch'

/*
 * End-to-end latency of one spoken turn with a REAL model: end of the person's speech → transcript → first model text → first sound of the
 * answer, as the free engine (src/lib/voice/chained-engine.ts) measures it in the running app (store/voice-metrics.ts, read from the orb's
 * `data-voice-turn`).
 *
 * Opt-in: it runs only when JAROD_E2E_VOICE_MODEL names a model the Jarod core can reach, as `<provider>:<model>` (a local server needs no key,
 * e.g. `lmstudio:qwen2.5-7b-instruct`). Otherwise it is skipped. The throwaway root is configured with that model; nothing is written to the
 * real profile and no key is read or stored by the test.
 *
 * - Microphone: Chromium's fake capture device plays a WAV of the question (the machine's own voice, System.Speech), then silence, through the
 *   real mic graph, the real endpointer and the real engine.
 * - Transcription: the throwaway root has no speech-to-text provider. When the core cannot transcribe the question, the test answers
 *   `/api/audio/transcribe` itself in main with the known text, and the transcript stage is reported as stubbed (not a measure). With a provider
 *   that works in the root, the real transcription is used and measured.
 * - Model and speech: real (the chosen model, the core's /api/audio/speak sentence by sentence).
 */
const MODEL = (process.env.JAROD_E2E_VOICE_MODEL ?? '').trim()
const QUESTION = 'What is the capital of France? Answer in one short sentence.'
const SILENCE_SECONDS = 45

let shell: Launched | undefined
let wavRoot: string | undefined

test.skip(!MODEL, 'Set JAROD_E2E_VOICE_MODEL=<provider>:<model> (for example lmstudio:<a model loaded in LM Studio>) to measure a real voice turn.')
test.skip(process.platform !== 'win32', 'The question is synthesized with Windows System.Speech.')

test.afterAll(async () => {
  await shell?.close()
  if (wavRoot) await removeRoot(wavRoot)
})

/** The question as 16 kHz mono 16-bit speech, followed by silence so the endpointer sees the end of speech before the fake device loops. */
function questionWav(dir: string): string {
  const spoken = path.join(dir, 'question-raw.wav')
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToWaveFile($env:E2E_WAV, $f)',
    '$s.Speak($env:E2E_TEXT)',
    '$s.Dispose()'
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60_000, windowsHide: true, env: { ...process.env, E2E_WAV: spoken, E2E_TEXT: QUESTION } })

  const raw = readFileSync(spoken)
  let offset = 12
  let pcm: Buffer | null = null

  while (offset + 8 <= raw.length) {
    const id = raw.toString('ascii', offset, offset + 4)
    const size = raw.readUInt32LE(offset + 4)

    if (id === 'data') {
      pcm = raw.subarray(offset + 8, offset + 8 + size)
      break
    }

    offset += 8 + size + (size % 2)
  }

  if (!pcm) throw new Error('System.Speech produced no PCM data')

  const silence = Buffer.alloc(16_000 * 2 * SILENCE_SECONDS)
  const data = Buffer.concat([Buffer.alloc(16_000 * 2 / 2), pcm, silence])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)

  const file = path.join(dir, 'question.wav')
  writeFileSync(file, Buffer.concat([header, data]))

  return file
}

test('one spoken turn with a real model: end of speech → transcript → first token → first sound', async () => {
  test.setTimeout(300_000)
  const separator = MODEL.indexOf(':')
  expect(separator, 'JAROD_E2E_VOICE_MODEL must be <provider>:<model>').toBeGreaterThan(0)
  const provider = MODEL.slice(0, separator)
  const model = MODEL.slice(separator + 1)

  wavRoot = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const wav = questionWav(wavRoot)

  shell = await launchShell({}, { args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] })
  const { app, page } = shell
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 60_000 }).toBe('ready')

  // The model of the throwaway root: the one named in the environment, nothing else.
  await page.evaluate(([p, m]) => window.jarodOS.backend.rest({ method: 'PUT', path: '/api/config', body: { config: { model: { provider: p, default: m } } } }), [provider, model])

  // Can the core transcribe here? If not, main answers the transcription with the known text (and the stage is reported as stubbed).
  const sttWorks = await page.evaluate(async file => {
    try {
      const result = await window.jarodOS.backend.rest<{ ok?: boolean; transcript?: string }>({ method: 'POST', path: '/api/audio/transcribe', body: { data_url: file, mime_type: 'audio/wav' } })

      return Boolean(result?.ok && result.transcript?.trim())
    } catch {
      return false
    }
  }, `data:audio/wav;base64,${readFileSync(wav).subarray(0, 44 + 16_000 * 2 * 6).toString('base64')}`)

  if (!sttWorks) {
    await app.evaluate(({ ipcMain }, text) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, request: { path?: string }) => unknown> })._invokeHandlers
      const original = handlers?.get('jarod-os:backend:rest')

      if (!handlers || !original) throw new Error('cannot wrap the backend REST handler (Electron internals changed)')

      handlers.set('jarod-os:backend:rest', (event, request) => (request?.path === '/api/audio/transcribe' ? { ok: true, transcript: text, provider: 'e2e-stub' } : original(event, request)))
    }, QUESTION)
  }

  // Start a conversation the way the global hotkey does.
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('jarod-os:voice:hotkey')
  })

  type Turn = { transcriptMs: number | null; firstTokenMs: number | null; firstAudioMs: number | null }
  let turn: Turn | null = null
  await expect
    .poll(
      async () => {
        const raw = await page.locator('[data-voice-turn]').first().getAttribute('data-voice-turn', { timeout: 1_000 }).catch(() => null)
        turn = raw ? (JSON.parse(raw) as Turn) : null

        return turn?.firstAudioMs ?? null
      },
      { timeout: 240_000, intervals: [500] }
    )
    .not.toBeNull()

  const measured = turn as unknown as Turn
  console.log(
    `VOICE-TURN model ${MODEL} · end of speech → transcript ${measured.transcriptMs} ms${sttWorks ? '' : ' (stubbed, not a measure)'} → first token ${measured.firstTokenMs} ms → first sound ${measured.firstAudioMs} ms`
  )
  expect(measured.firstTokenMs).not.toBeNull()
  expect(measured.firstAudioMs as number).toBeGreaterThanOrEqual(measured.firstTokenMs as number)
})
