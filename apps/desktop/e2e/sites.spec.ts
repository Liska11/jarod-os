import { expect, test, type Page } from '@playwright/test'
import { type Launched, launchShell } from './launch'

// Apps in the right pane, beside the chat (sidebar Apps and Messaging sections): each site in its own view, partition and
// Chrome user agent. Desktop apps (Signal, MovieBox, VLC) are not opened here: they would take the person's real windows.
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page

interface GuestInfo {
  url: string
  partition: string
}

/** The guest views main holds now (the shell's own page excluded). */
async function guests(): Promise<GuestInfo[]> {
  return shell.app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter(contents => contents.getType() !== 'window' || !contents.getURL().includes('index.html'))
      .map(contents => ({ url: contents.getURL(), partition: (contents.session as unknown as { storagePath: string | null }).storagePath ?? '' }))
  )
}

async function userAgentOf(host: string): Promise<string> {
  return shell.app.evaluate(async ({ webContents }, wanted) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().includes(wanted))

    return contents ? String(await contents.executeJavaScript('navigator.userAgent')) : ''
  }, host)
}

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })

  // Through the first-run wizard, as shell.spec.ts does.
  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(800)
  }
})

test.afterAll(async () => {
  await shell.close()
})

test('the browser opens in the right pane, Brave Search in its own partition', async () => {
  await page.getByRole('button', { name: 'Navigateur', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Navigateur' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Aperçu' })).toBeVisible()
  await expect.poll(async () => (await guests()).some(guest => guest.url.includes('search.brave.com')), { timeout: 45_000 }).toBe(true)
  const guest = (await guests()).find(item => item.url.includes('search.brave.com'))
  expect(guest?.partition).toContain('jarod-site-browser')
  await expect(page.getByRole('textbox', { name: 'Rechercher avec Brave ou saisir une adresse' })).toHaveValue(/search\.brave\.com/)
})

test('the address bar searches what is not an address', async () => {
  const bar = page.getByRole('textbox', { name: 'Rechercher avec Brave ou saisir une adresse' })
  await bar.fill('jarod os')
  await bar.press('Enter')
  await expect.poll(async () => (await guests()).some(guest => guest.url.includes('search.brave.com/search?q=jarod')), { timeout: 30_000 }).toBe(true)
})

test('TikTok and Instagram open as pane tabs, each in its own session', async () => {
  await page.getByRole('button', { name: 'TikTok', exact: true }).click()
  await expect.poll(async () => (await guests()).some(guest => guest.url.includes('tiktok.com')), { timeout: 45_000 }).toBe(true)
  await page.getByRole('button', { name: 'Instagram', exact: true }).click()
  await expect.poll(async () => (await guests()).some(guest => guest.url.includes('instagram.com')), { timeout: 45_000 }).toBe(true)
  const all = await guests()
  expect(all.find(item => item.url.includes('tiktok.com'))?.partition).toContain('jarod-site-tiktok')
  expect(all.find(item => item.url.includes('instagram.com'))?.partition).toContain('jarod-site-instagram')
})

test('a site cannot raise a passkey prompt without a click (Windows would put its dialog over everything)', async () => {
  const result = await shell.app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().includes('instagram.com'))

    return contents
      ? String(
          await contents.executeJavaScript(`(async () => {
            const conditional = await PublicKeyCredential.isConditionalMediationAvailable()
            try {
              await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16), timeout: 1000 } })
              return 'prompted ' + conditional
            } catch (error) {
              return error.message + ' ' + conditional
            }
          })()`)
        )
      : 'no view'
  })

  expect(result).toBe('A passkey needs a click. false')
})

test('the Messaging section opens Telegram and WhatsApp, which see Chrome, not Electron', async () => {
  await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
  await expect.poll(async () => (await guests()).some(guest => guest.url.includes('web.whatsapp.com')), { timeout: 45_000 }).toBe(true)
  const agent = await userAgentOf('web.whatsapp.com')
  expect(agent).toContain('Chrome/')
  expect(agent).not.toMatch(/Electron|jarod/i)

  await page.getByRole('button', { name: 'Telegram', exact: true }).click()
  await expect.poll(async () => (await guests()).some(guest => guest.url.includes('web.telegram.org')), { timeout: 45_000 }).toBe(true)
})

test('a pane tab closes, and the pane goes back to the preview', async () => {
  await page.getByRole('button', { name: 'Fermer Telegram' }).click()
  await expect(page.getByRole('tab', { name: 'Telegram' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Aperçu' })).toHaveAttribute('aria-selected', 'true')
})

test('the player waits for files in its tab', async () => {
  await page.getByRole('button', { name: 'Lecteur', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Lecteur' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Rien à lire pour l’instant')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Ajouter des fichiers' })).toBeVisible()
})

test('the Player streams a picked file through jarod-media, by byte ranges', async () => {
  const file = shell.app.evaluate(() => process.execPath)
  const result = await page.evaluate(async target => {
    const [granted] = await window.jarodOS.media.allow([target])
    const whole = await fetch(granted.url, { headers: { Range: 'bytes=0-9' } })
    const refused = await fetch(granted.url.replace(/local\/[^/]+$/, `local/${btoa('C:\Windows\win.ini').replace(/=+$/, '')}`))

    return { url: granted.url, status: whole.status, length: (await whole.arrayBuffer()).byteLength, range: whole.headers.get('content-range'), refused: refused.status }
  }, await file)

  expect(result.url).toMatch(/^jarod-media:\/\/local\//)
  expect(result.status).toBe(206)
  expect(result.length).toBe(10)
  expect(result.range).toMatch(/^bytes 0-9\/\d+$/)
  // A file nobody picked looks missing.
  expect(result.refused).toBe(404)
})

test('WhatsApp Web does not turn the browser away', async () => {
  const text = await shell.app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().includes('web.whatsapp.com'))

    return contents ? String(await contents.executeJavaScript('document.body.innerText')) : ''
  })

  expect(text).not.toMatch(/update (google )?chrome|browser.*(not supported|isn.t supported)|navigateur.*(pas pris en charge)/i)
})
