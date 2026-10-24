import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchShell, ROOT_PREFIX, removeRoot } from './launch'

/*
 * The real installation bench (Windows): the NSIS installer `npm run dist:win` left in release/, installed for this user, silently, into a
 * throwaway folder; the INSTALLED Jarod-OS.exe started on a throwaway profile; the installer's uninstaller run at the end.
 *
 *   npm run dist:win
 *   $env:JAROD_INSTALLER_BENCH = '1'; npx playwright test e2e/installer.spec.ts
 *
 * It installs for real (an entry in "Installed apps", a Start menu and a desktop shortcut, removed again by the uninstaller), so it only
 * runs when asked (JAROD_INSTALLER_BENCH=1), never when a desktop shortcut "Jarod-OS" is already there. Checks: what the package carries
 * (the core, the bridge, Pinokio's engine, restic, the Rust binaries and the contracts in resources/updater); that the shortcuts start
 * Jarod-OS.exe (DECISIONS: the launcher stays out of the shortcut while A/B is off); the core reaching `ready`; A/B and the control shadow
 * off without their flags (no binary run, no updater root made); no process of the install left after quit; nothing left after the
 * uninstaller, in the install folder, the shortcuts, the uninstall entry or %TEMP%.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as { version: string; build: { win: { extraResources: { to: string }[] } } }
const VERSION = PACKAGE.version
/** The bridge plugin's folder in resources, as the package names it (an upstream name). */
const BRIDGE = PACKAGE.build.win.extraResources.find(entry => entry.to.endsWith('-bridge'))?.to ?? 'bridge'
const INSTALLER = path.join(APP, 'release', `JarodOS-Setup-${VERSION}-win-x64.exe`)
const RUST_BINARIES = ['jarod-updater.exe', 'jarod-launcher.exe', 'jarod-control-shadow.exe']

function powershell(script: string, env: Record<string, string> = {}): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: { ...process.env, ...env } }).trim()
}

const shortcutTarget = (file: string): string => powershell('(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK).TargetPath', { LNK: file })
const processesUnder = (dir: string): string[] =>
  powershell('Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($env:DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.Id) $($_.Path)" }', { DIR: dir })
    .split(/\r?\n/)
    .filter(Boolean)
const uninstallEntries = (): string[] =>
  powershell("Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Jarod-OS *' } | ForEach-Object { $_.UninstallString }")
    .split(/\r?\n/)
    .filter(Boolean)
const rustProcesses = (): string[] =>
  powershell("Get-Process | Where-Object { $_.ProcessName -in 'jarod-updater','jarod-launcher','jarod-control-shadow' } | ForEach-Object { $_.Id }")
    .split(/\r?\n/)
    .filter(Boolean)

const DESKTOP = powershell("[Environment]::GetFolderPath('Desktop')")
const START_MENU = path.join(powershell("[Environment]::GetFolderPath('Programs')"))
const DESKTOP_LNK = path.join(DESKTOP, 'Jarod-OS.lnk')
const START_LNK = path.join(START_MENU, 'Jarod-OS.lnk')

test.skip(process.platform !== 'win32', 'Windows installer')
test.skip(process.env.JAROD_INSTALLER_BENCH !== '1', 'installs for real: JAROD_INSTALLER_BENCH=1 to run it')
test.skip(!existsSync(INSTALLER), `${path.basename(INSTALLER)} is not built (npm run dist:win)`)
test.skip(existsSync(DESKTOP_LNK) || uninstallEntries().length > 0, 'a Jarod-OS install or shortcut is already there: not touched')
test.setTimeout(420_000)

test('the installer installs a complete app that starts its core, keeps A/B off, and leaves nothing behind', async () => {
  const root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const install = path.join(root, 'install')
  const temp = tmpdir()
  const tempBefore = new Set(readdirSync(temp))
  const report: Record<string, unknown> = { installer: INSTALLER }
  let uninstalled = false

  try {
    // /D= must come last and unquoted (NSIS); /S keeps it per user, as the assisted installer does by default.
    const run = spawnSync(INSTALLER, ['/S', `/D=${install}`], { timeout: 300_000, windowsHide: true })
    expect(run.status).toBe(0)
    const exe = path.join(install, 'Jarod-OS.exe')
    expect(existsSync(exe)).toBe(true)

    // What the package carries.
    const resources = path.join(install, 'resources')
    const carried = {
      'app.asar': existsSync(path.join(resources, 'app.asar')),
      'jarod-core': existsSync(path.join(resources, 'jarod-core', 'node_modules')),
      bridge: existsSync(path.join(resources, BRIDGE)),
      pinokiod: existsSync(path.join(resources, 'pinokiod', 'host.cjs')),
      restic: readdirSync(path.join(resources, 'restic')).some(name => name.endsWith('.exe')),
      contracts: existsSync(path.join(resources, 'updater', 'contracts', 'v1', 'index.json')),
      ...Object.fromEntries(RUST_BINARIES.map(name => [name, existsSync(path.join(resources, 'updater', name))]))
    }
    report.carried = carried
    expect(Object.entries(carried).filter(([, present]) => !present)).toEqual([])

    // The shortcuts start the app itself, not the launcher.
    report.shortcuts = { desktop: shortcutTarget(DESKTOP_LNK), startMenu: shortcutTarget(START_LNK) }
    expect(path.resolve(shortcutTarget(DESKTOP_LNK)).toLowerCase()).toBe(exe.toLowerCase())
    expect(path.resolve(shortcutTarget(START_LNK)).toLowerCase()).toBe(exe.toLowerCase())
    expect(uninstallEntries()).toHaveLength(1)

    // The installed app, flags off, on a throwaway profile.
    const shell = await launchShell({ JAROD_HOST_UPDATER: '', JAROD_HOST_CONTROL: '' }, { root, own: false, executablePath: exe })

    try {
      await expect(shell.page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
      await expect.poll(async () => (await shell.page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 120_000 }).toBe('ready')
      const updater = await shell.page.evaluate(() => window.jarodOS.hostUpdater.state())
      report.hostUpdater = updater
      expect(updater).toMatchObject({ enabled: false, state: null })
      expect(rustProcesses()).toEqual([])
    } finally {
      await shell.app.close().catch(() => undefined)
    }

    expect(existsSync(path.join(root, 'config', 'host-updater'))).toBe(false)
    expect(existsSync(path.join(root, 'config', 'control-shadow-stats.json'))).toBe(false)
    await expect.poll(() => processesUnder(install), { timeout: 30_000 }).toEqual([])

    // The uninstaller copies itself out and returns early: wait for the folder to go.
    const uninstaller = path.join(install, 'Uninstall Jarod-OS.exe')
    expect(spawnSync(uninstaller, ['/S'], { timeout: 120_000, windowsHide: true }).status).toBe(0)
    await expect.poll(() => existsSync(exe), { timeout: 120_000 }).toBe(false)
    await expect.poll(() => uninstallEntries(), { timeout: 30_000 }).toEqual([])
    uninstalled = true
    expect(existsSync(DESKTOP_LNK)).toBe(false)
    expect(existsSync(START_LNK)).toBe(false)
    await expect.poll(() => (existsSync(install) ? readdirSync(install) : []), { timeout: 30_000 }).toEqual([])

    // Nothing of the installer, the uninstaller (NSIS's nsXXXX.tmp; the uninstaller's copy of itself goes once it exits) or the app left in
    // %TEMP% but this run's own root. Other programs write there too: what is new and not ours is only reported.
    const left = () => readdirSync(temp).filter(name => !tempBefore.has(name) && path.join(temp, name) !== root)
    await expect.poll(() => left().filter(name => /^ns.*\.tmp$|jarod|electron/i.test(name)), { timeout: 60_000 }).toEqual([])
    report.tempNewNotOurs = left()
  } finally {
    if (!uninstalled && existsSync(path.join(install, 'Uninstall Jarod-OS.exe'))) {
      spawnSync(path.join(install, 'Uninstall Jarod-OS.exe'), ['/S'], { timeout: 120_000, windowsHide: true })
    }

    console.log(`installer bench: ${JSON.stringify(report, null, 1)}`)
    await test.info().attach('installer.json', { body: JSON.stringify(report, null, 1), contentType: 'application/json' })
    await removeRoot(root)
  }
})
