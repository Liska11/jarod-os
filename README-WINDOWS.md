# Jarod-OS on Windows (alpha)

Jarod-OS is derived from Herald OS by Luke The Dev (MIT; see [NOTICE](NOTICE)). Only the name shown to the
user, the executable and the installer identity changed; internal identifiers (`herald-os-bridge`, `HERALD_OS_*`,
`window.heraldOS`, data folders under `herald-os`) keep their upstream names.

Jarod-OS runs on Windows 10 and 11 as an **application**: the same window as on macOS, fullscreen
by default (no WSL). It does not replace the Windows desktop the way Jarod-OS Linux replaces the
session.

### Which agent runs

- **The Jarod core, by default.** The installer ships it (`resources\jarod-core`), and
  `Jarod-OS.exe` runs it in Node mode, so it shows up as a second `Jarod-OS.exe` in Task Manager:
  nothing else to install. Its data lives in `%LOCALAPPDATA%\Jarod-OS`
  (`JAROD_OS_DATA` moves it) and conversations work in `Documents\Jarod-OS` (`JAROD_WORKSPACE`).
  From source, `npm run bundle:core` builds it into `jarod-core\dist\gateway`, where `npm run dev`
  finds it.
- **Hermes Agent, if you prefer it** or when no core was built: set `HERALD_OS_BACKEND=hermes`, and
  install Hermes as in step 1. The system bridge described below is the Hermes side; the Jarod
  core has its own system tools.

Settings > About shows which one is running ("Agent runtime").

What you get is the shell (Overview, Missions, Memory, Hermes, Files, Terminal, System, Settings...),
the agent, and the system bridge: Hermes can list processes, search your files, open apps and
addresses, read the event log, move files to the Recycle Bin and so on, every call permission-tiered
and written to `audit.jsonl`. What it does not do yet is in [Limitations](#limitations).

## Requirements

| | |
| --- | --- |
| Windows | 10 (1809 or later) or 11, x64. ARM64 is untested. |
| Hermes Agent | **Optional**: only for the Hermes backend (see above). Native install, see below. Hermes runs its shell tool through Git Bash, so Git for Windows must be on the machine (Hermes's installer fetches a portable one if not). |
| Node.js | 22.12 or later, for running from source or building. |
| ripgrep | Optional. File search uses `rg` from `PATH`, from Hermes's own copy in `%LOCALAPPDATA%\hermes\tools\ripgrep-*`, or from `%LOCALAPPDATA%\hermes\bin`, and a slower built-in walk otherwise. |
| Python | Not needed: the bridge plugin runs inside Hermes's own Python. |

## 1. Install Hermes Agent natively (optional)

Skip this step if the Jarod core is enough for you.

In PowerShell (no administrator rights needed):

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Open a **new** terminal afterwards (the installer changes your user `PATH`), then:

```powershell
hermes --version
hermes setup      # pick a model provider, if you have not yet
```

Hermes keeps its data in `%LOCALAPPDATA%\hermes` (that is `HERMES_HOME`), its code in
`%LOCALAPPDATA%\hermes\hermes-agent` and the `hermes` launcher in `%LOCALAPPDATA%\hermes\bin`. Jarod
OS follows the same place, so the plugin link, the settings and the audit log
(`%LOCALAPPDATA%\hermes\herald-os\audit.jsonl`) all sit next to Hermes's own files. If you set the
`HERMES_HOME` environment variable, both use that instead.

## 2. Run Jarod-OS from source

```powershell
git clone https://github.com/PAVADI234/herald-os
cd herald-os
npm run bootstrap
npm run dev
```

`npm run bootstrap` downloads the pinned upstream snapshot, installs the Node packages, fetches
Electron, links `plugins\herald-os-bridge` into `%HERMES_HOME%\plugins` with a **junction** (it needs
neither Developer Mode nor an administrator), then enables the plugin and the `herald_os` toolset and
turns Hermes's tool search off so the system tools stay directly callable. It is safe to run again
after every pull. It uses `scripts\bootstrap.ps1`; `npm run` picks it over the bash version
automatically.

`npm run dev` starts the Vite server and Electron. Closing the window quits. Useful while developing:

| Setting | Effect |
| --- | --- |
| `$env:HERALD_OS_WINDOWED = '1'` | Start in a window instead of fullscreen. |
| `F11` | Toggle fullscreen at any time. `Alt+F4` closes the window. |
| `$env:HERALD_OS_SHELL = 'pwsh.exe'` | The shell the Terminal app starts (PowerShell 5.1 by default). |
| `$env:HERALD_OS_HERMES_ROOT = 'C:\path\to\hermes-agent'` | Use another Hermes checkout. |

## 3. Check that it all works

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1
```

It checks, in order: Hermes answers, the bridge plugin is linked and enabled, `hermes serve` starts
and the gateway's `tools.list` shows the `herald_os` tools, a bridge tool (`system_info` by default,
`-Tool` picks another read-only one) is called through Hermes's own tool registry, and that call left
a correctly shaped line in `audit.jsonl`. The exit code is 0 only when every step passed;
`-SkipGateway` leaves out the `hermes serve` step.

The tests: `npm run typecheck`, `npm test` (Vitest, including a few read-only checks against the real
PowerShell scripts) and `npm run test:bridge` (the plugin's pytest suite).

## 4. Build the installers

```powershell
npm run dist:win
```

This builds the app and runs electron-builder for x64. In `apps\desktop\release`:

| File | What it is |
| --- | --- |
| `JarodOS-Setup-<version>-win-x64.exe` | NSIS installer. Per user (no administrator rights), lets you choose the folder, adds Start menu and desktop shortcuts and an uninstaller. |
| `JarodOS-<version>-win-x64.appx` | The same app as a Windows app package (the format MSIX packages use; electron-builder calls the target `appx`). **Unsigned.** |
| `win-unpacked\` | The unpacked app, runnable as is: `win-unpacked\Jarod-OS.exe`. |

Things to know:

- **Both packages are unsigned.** Windows SmartScreen warns about the installer ("More info", then
  "Run anyway"). An appx can only be installed once it is signed with a certificate whose subject
  matches `build.appx.publisher` in `apps\desktop\package.json` (it is `CN=JarodOS` now): set
  `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder, change `publisher` to your certificate's
  subject, and for the Store use the identity values the Partner Center gives you.
- electron-builder prints "Cannot create symbolic link" while unpacking `winCodeSign`. Those are macOS
  libraries it does not need on Windows; the build goes on (the messages should go away with
  Windows Developer Mode or an elevated terminal; that was not tried).
- The first build downloads Electron and the NSIS and appx tooling; later ones reuse the cache.
- The appx installs under `C:\Program Files\WindowsApps`, which other processes (Hermes's Python)
  cannot read, so the app copies the bridge plugin to `%HERMES_HOME%\herald-os\bridge-plugin` and
  links that. The NSIS install links the plugin from its own `resources` folder.
- A packaged Jarod-OS links and enables the bridge plugin itself at first start, the way
  `npm run bootstrap` does for a checkout.

## Limitations

What is different from macOS and Jarod-OS Linux, honestly:

- **Application mode only.** No Windows session replacement, no tiling, no panels mode.
- **Fullscreen by default.** Like on macOS the window is frameless and starts fullscreen. The menu
  bar carries minimize, maximize / restore and close buttons at its right end (Windows only); `F11`
  toggles fullscreen and "Launch fullscreen" in Settings -> General turns the default off. Drag the
  menu bar to move the window when it is not fullscreen.
- **Global hotkeys.** The voice hotkey is configurable and defaults to `Alt+Space`. Windows reserves
  most `Win+` combinations, so Jarod-OS does not register any; inside the app `Ctrl` does what `Cmd`
  does on macOS (`Ctrl+K` opens the command bar).
- **Screenshots and recordings.** A whole-screen screenshot is taken by the app (primary display, saved
  in `Pictures\Screenshots`); a region or a window opens Windows's Snipping Tool, and what you select is
  saved the same way (your clipboard is put back as it was). Recordings are of the whole primary
  screen, without sound, saved in `Videos\Recordings` as MP4 through the `ffmpeg` that Hermes installs
  (or one on `PATH`). The colour picker, QR codes and text-from-screen are not there yet.
- **Not implemented yet:** dictation
  anywhere (macOS-only), the emoji panel, calendar events, and changing Wi-Fi, Bluetooth, the default
  audio device or displays from the menu bar's quick panels (they show state; Windows Settings does
  the changing). The Sound panel lists every active output and input and sets each one's volume and
  mute. The agent can also read and set the volume and dark mode, and read network and Bluetooth
  state, through the bridge.
- **Bridge tools that differ.** Bluetooth shows paired devices but not which one is connected right
  now. Wi-Fi power cannot be switched without administrator rights. Process owners are blank for
  processes Windows does not let you inspect. File search looks in Desktop, Documents, Downloads,
  Pictures, Videos and Music (and their OneDrive copies) unless you give it a folder; "created"
  dates use the file's creation time. Crash reports come from Windows Error Reporting events (no
  stack, but the faulting module and exception code).
- **Safety rails.** The bridge refuses SSH and GnuPG keys, the Credential Manager / DPAPI / Vault
  stores, the Windows folders, Program Files and ProgramData, Hermes's `.env` and `auth.json`, and
  never opens a program or script with its default action (that would run it). Deleting goes to the
  Recycle Bin after the usual approval card.
- **Alpha.** Expect rough edges; [WINDOWS-PORT-NOTES.md](WINDOWS-PORT-NOTES.md) lists what was assumed,
  what was verified and what was not.

## Troubleshooting

- **"hermes is not recognized."** Open a new terminal after installing, or check that
  `%LOCALAPPDATA%\hermes\bin` is on your user `PATH`. Jarod-OS also looks there by itself.
- **Hermes starts but `hermes serve` fails with `No module named 'pydantic_core...'`** (or another
  missing module), or `hermes` exits silently with code 1. A Hermes update was interrupted and left
  the environment half-done. Run `hermes pm repair`, then `hermes update`, and start Jarod-OS again.
  If those cannot run either because `%LOCALAPPDATA%\hermes\tools\...` answers "Access is denied" (an
  update run as administrator can leave folders whose permissions exclude your account), reset that
  folder's permissions from an **administrator PowerShell** and start Jarod-OS again:

  ```powershell
  takeown /f "$env:LOCALAPPDATA\hermes\tools" /r /d o
  icacls "$env:LOCALAPPDATA\hermes\tools" /reset /t
  ```

  (In `cmd.exe` write `%LOCALAPPDATA%` instead of `$env:LOCALAPPDATA`; PowerShell does not expand it.)
  Re-running the Hermes installer works too.
- **`WinError 5` / "Access is denied" from Hermes's Python.** An executable under `WindowsApps` was
  started from another process. Use the NSIS install or the checkout, not an appx, for the bridge, or
  let Jarod-OS stage the plugin as described above.
- **`npm run bootstrap` stops with `EALLOWSCRIPTS`.** Your user `.npmrc` has an `allow-scripts` line
  that `npm run` passes down. The Windows bootstrap clears it for its own `npm install`; if you run
  `npm install` by hand inside `npm run`, unset `npm_config_allow_scripts` first.
- **Scripts will not run: "running scripts is disabled".** The npm scripts call PowerShell with
  `-ExecutionPolicy Bypass`; run `scripts\*.ps1` the same way.
- **The Terminal app is blank.** It needs ConPTY (Windows 10 1809 or later). `npm install` ships
  node-pty's Windows binaries; if it was installed with scripts disabled, run `npm rebuild node-pty`.
- **See what the agent did.** `%LOCALAPPDATA%\hermes\herald-os\audit.jsonl`, one JSON line per call:
  `{ts, tool, tier, action, decision, ok, summary, error, args}`. The app's own log is
  `%LOCALAPPDATA%\hermes\logs\herald-os.log`.
