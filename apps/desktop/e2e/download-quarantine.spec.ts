import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

/*
 * V-07 — a download from the shell's browser (the only site with the `downloads` permission) on the BUILT app, with the REAL Microsoft Defender:
 * an ordinary file lands in Downloads after its scan; the EICAR test file (harmless, recognised by every antivirus, assembled at run time and
 * served from memory: never in the repository) is refused and never arrives. Downloads go to a throwaway folder (JAROD_OS_DOWNLOADS_DIR), never
 * the person's own. The download is started on the browser's own session, from a server on 127.0.0.1. Windows only (Defender).
 * Run `npm run bundle:core && npm run build` first.
 */
test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'win32', 'Microsoft Defender is the scanner')

const EICAR = ['X5O!P%@AP[4', String.fromCharCode(92), 'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('')

let shell: Launched
let page: Page
let server: http.Server
let base = ''
const downloads = () => path.join(shell.root, 'downloads')
const journal = () => {
  const file = path.join(shell.root, 'hermes', 'jarod-os', 'download-quarantine.jsonl')

  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { name: string; outcome: string; verdict?: string; scanner?: string; reason?: string })
    : []
}

/** Starts a download of `url` on the browser site's own session, as a click in the page would. */
async function download(url: string): Promise<void> {
  await shell.app.evaluate(({ session }, target) => session.fromPartition('persist:jarod-site-browser').downloadURL(target), url)
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = req.url === '/eicar.txt' ? 'eicar.txt' : 'notes.txt'
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` })
    res.end(name === 'eicar.txt' ? EICAR : 'des notes ordinaires')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  shell = await launchShell({ JAROD_OS_DOWNLOADS_DIR: path.join(process.env.TEMP ?? '', 'unused') })
  // The downloads folder inside this run's root (known only once the shell is launched): relaunching is not needed, the variable is read per download.
  await shell.app.evaluate((_electron, dir) => {
    process.env.JAROD_OS_DOWNLOADS_DIR = dir
  }, path.join(shell.root, 'downloads'))
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(800)
  }

  // Opening the browser prepares its session (permissions, download handling).
  await page.getByRole('button', { name: 'Navigateur', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Navigateur' })).toHaveAttribute('aria-selected', 'true')
})

test.afterEach(async ({}, info) => {
  // On failure, what the shell logged about downloads (the run's root is removed when it closes).
  if (info.status !== info.expectedStatus && shell) {
    const logs = path.join(shell.root, 'hermes', 'logs')
    const lines = fs.existsSync(logs) ? fs.readdirSync(logs).flatMap(f => fs.readFileSync(path.join(logs, f), 'utf8').split('\n')).filter(l => /download|web/i.test(l)) : []
    await info.attach('download-log', { body: [...lines.slice(-40), JSON.stringify(journal())].join('\n') })
  }
})

test.afterAll(async () => {
  await shell?.close()
  server?.close()
})

test('an ordinary download is scanned by Defender, then lands in Downloads', async () => {
  await download(`${base}/notes.txt`)

  await expect.poll(() => fs.existsSync(path.join(downloads(), 'notes.txt')), { timeout: 60_000 }).toBe(true)
  expect(fs.readFileSync(path.join(downloads(), 'notes.txt'), 'utf8')).toBe('des notes ordinaires')
  // The journal line follows the copy (written once the staging folder is emptied).
  await expect.poll(() => journal().find(line => line.name === 'notes.txt'), { timeout: 15_000 }).toMatchObject({ outcome: 'admitted', verdict: 'clean', scanner: 'defender' })
})

test('the EICAR test file is refused and never reaches Downloads; the staging folder is emptied', async () => {
  await download(`${base}/eicar.txt`)

  await expect.poll(() => journal().find(line => line.name === 'eicar.txt')?.outcome, { timeout: 60_000 }).toBe('refused')
  expect(fs.existsSync(path.join(downloads(), 'eicar.txt'))).toBe(false)
  expect(fs.readdirSync(path.join(shell.root, 'hermes', 'jarod-os', 'quarantine', 'downloads'))).toEqual([])
})
