import { expect, test } from '@playwright/test'
import { type Launched, launchShell } from './launch'

// Measured on this machine, through the Jarod core's /api/audio/speak (the machine's own voice, no network): synthesis time of one
// sentence and of a four-sentence reply. Measured on 2026-10-18: 264 ms and 293 ms. Synthesis is not where the time goes: the gain of
// sentence-by-sentence speech (src/lib/voice/sentence-speaker.ts) is not waiting for the MODEL to finish its reply before speaking, which
// depends on the model and is not measured here (no model in the test). The test checks that the core's speech works and prints the numbers.
let shell: Launched

test.beforeAll(async () => {
  shell = await launchShell()
  await expect(shell.page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await shell.page.evaluate(() => window.heraldOS.backend.getState())).phase, { timeout: 60_000 }).toBe('ready')
})

test.afterAll(async () => {
  await shell?.close()
})

test('the core synthesizes speech locally; one sentence and a whole reply are timed', async () => {
  test.setTimeout(180_000)
  const reply = [
    'Voici ce que j’ai trouvé sur votre disque.',
    'Le dossier Téléchargements occupe quarante-deux gigaoctets, surtout des vidéos.',
    'Le cache du navigateur en prend six de plus, et il se vide sans risque.',
    'Je peux vous montrer les fichiers les plus gros si vous le souhaitez.'
  ]
  const timings = await shell.page.evaluate(async sentences => {
    const time = async (text: string) => {
      const started = performance.now()
      const result = await window.heraldOS.backend.rest<{ data_url?: string }>({ method: 'POST', path: '/api/audio/speak', body: { text } })

      return { ms: Math.round(performance.now() - started), ok: Boolean(result?.data_url) }
    }
    // A first call warms the voice up, as the first turn of a conversation would.
    await time('Bonjour.')
    const first = await time(sentences[0])
    const whole = await time(sentences.join(' '))

    return { first, whole }
  }, reply)

  console.log(`VOICE-LATENCY first sentence ${timings.first.ms} ms, whole reply ${timings.whole.ms} ms`)
  expect(timings.first.ok && timings.whole.ok, JSON.stringify(timings)).toBe(true)
})
