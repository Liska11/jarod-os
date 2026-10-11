# Windows port: notes, assumptions and validation

Branch `feature/windows-port`, based on `main` at `00138ed`. Nothing was pushed or published.
User-facing instructions are in [README-WINDOWS.md](README-WINDOWS.md); this file is for reviewers.

## Where the real code differed from the brief

| The brief assumed | What the repository has | What was done |
| --- | --- | --- |
| The bridge is JavaScript tools to "recode" | `plugins/herald-os-bridge` is a **Python** Hermes plugin with a `HostAdapter` per OS and a typed Windows stub | `host/windows.py` implements the existing adapter on Windows PowerShell; the tool layer and every JSON shape are unchanged |
| Windows data in `%USERPROFILE%\.hermes` | Hermes's native installer uses `%LOCALAPPDATA%\hermes` (documented, and `paths.ts` already used it); this machine has `HERMES_HOME=%LOCALAPPDATA%\hermes` | Kept Hermes's own location and the `HERMES_HOME` override, so the plugin link, the app settings and `herald-os\audit.jsonl` sit beside Hermes's files (same relative path and format). Python's fallback is now `%LOCALAPPDATA%\hermes` on Windows |
| An `msix` target | electron-builder 26.15.3 has no `msix` target; its Store package target is `appx` (`.appx`, same package format) | `dist:win` builds `nsis` and `appx` (unsigned) |
| `spawn("hermes")` with `shell: true` | The backend is started from `hermes.exe` or the venv's `python.exe` (an `.exe`, resolved from the managed install, `PATH` and `%HERMES_HOME%\bin`) | No shell: quoting, signals and the process tree stay under control. `taskkill /T /F` ends the tree. Only `.exe` is resolved (spawn cannot start a `.cmd` without a shell) |
| Cmd/Super becomes the Windows key via `globalShortcut` | Windows reserves most `Win+` combinations; the renderer already treats `Ctrl` as `Cmd`; fullscreen is already `F11` off macOS | No `Win+` shortcut is registered. Nothing to change for `F11`; the voice hotkey stays configurable (`Alt+Space`) |
| "Credential Manager" as a protected path | It is not a path; its blobs and keys live in `%APPDATA%\Microsoft\{Credentials,Protect}` and `%LOCALAPPDATA%\Microsoft\{Credentials,Vault}` | Those folders (plus SSH/GnuPG keys, Windows, Program Files, ProgramData, Hermes `.env`/`auth.json`) are protected |
| A Unix socket between shell and bridge | Node serves only named pipes on Windows and Python's `socket` has no `AF_UNIX` there | Loopback TCP, `tcp://127.0.0.1:<port>` in `HERALD_OS_CONTROL_SOCKET`, token-authenticated; the bridge accepts nothing but that exact loopback form |
| Only the bridge and packaging | The shell's `GenericPlatform` returns empty lists on win32 (System, Processes, Applications, Files pages) | Added `WindowsPlatform` |
| `ripgrep "déjà fourni par l'install Hermes"` | Not confirmed by Hermes's documentation | `rg` is used when found (`PATH`, `%HERMES_HOME%\bin`); a bounded walker is the fallback |

## What was changed (by commit)

1. **Script entry and dev loop.** `scripts/run.mjs` runs the `.sh` or `.ps1` twin; `bootstrap.ps1`,
   `sync-upstream.ps1`, `test-bridge.ps1`; `dev:electron` no longer uses an inline env assignment;
   `.gitattributes` keeps shell scripts LF.
2. **Backend and environment.** `%HERMES_HOME%\bin` lookup, registry-based user/machine `PATH`
   (replaces the login-shell query), junction instead of symlink, `taskkill /T`, PowerShell parent-pid
   lookup, `windowsHide` on child processes, `.ps1/.cmd/.bat/.exe` hooks.
3. **Control channel** over loopback TCP; the backend starts after the server is listening.
4. **Terminal and files.** PowerShell by default (`$SHELL` from Git Bash is ignored), AppUserModelId,
   and the direct-edit guard moved to `ipc/path-guard.ts` (case-insensitive on Windows, `%TEMP%`,
   credential stores protected, image size without `sips`).
5. **Bridge `WindowsHost`** (`host/windows.py`, `host/winps.py`, `host/search.py`), Windows protected
   paths, critical-process refusal, `util.run` without console windows and with an explicit decoding.
6. **`WindowsPlatform`** for the shell (`platform/windows.ts`, `windows-parse.ts`).
7. **Packaging and verification.** `dist:win`, NSIS and appx configuration, `verify-windows.ps1`.
8. **Window buttons, ripgrep lookup, bootstrap fix.** Minimize / maximize / close in the menu bar on
   Windows; Hermes's own `tools/ripgrep-*` is searched; the voice probe of `bootstrap.ps1` no longer
   loses its quotes.
9. **CI, docs, appx staging.** `windows-latest` in the CI matrices and a PowerShell parse job, the
   bridge plugin staged out of `WindowsApps`, docs, `README-WINDOWS.md`, this file.

Shared refactors that touch macOS/Linux paths, and why they are safe: the file-search predicates moved
from `linux.py` to `search.py` (re-exported, same tests); the Linux adapter imports `pwd` lazily;
`crash.signal_name` uses a fixed Linux signal table (same names on Linux); `ProcessRow.name` splits on
backslashes only for a Windows path; `OsControlServer` keeps the Unix socket off Windows only;
`parse_policy` and `builtin_protected` take a `platform` argument defaulting to `sys.platform`.

## Validation, as run on this machine (Windows 11 Pro, build 26300, French, Node 24, Python 3.11 from Hermes)

| Check | Result |
| --- | --- |
| `npm run typecheck` | passes |
| `npm test` (Vitest) | 66 files, 339 passed, 2 skipped (the skipped ones need Linux/macOS fixtures). Before the port: 4 failed on Windows (symlink `EPERM`, executable bit) |
| `npm run test:bridge` (pytest, plugin) | 184 passed, 9 skipped (`AF_UNIX` variants). Before the port: 20 failed and 9 errored on Windows (`pwd`, `AF_UNIX`, signal numbers) |
| Real PowerShell scripts | each read-only script ran against this machine; the Vitest and pytest suites keep one real-PowerShell check each, skipped off Windows |
| Bridge tools through Hermes's own registry (`discover_plugins()` + `registry.dispatch`, isolated `HERMES_HOME`) | `system_info`, `system_processes` (top/find), `system_disk_usage`, `system_find_files`, `system_apps` (installed/running), `system_network` (status/bluetooth), `system_control` (appearance/audio), `system_logs` (log/crashes) all returned real data |
| Audit entry for a tool call | `scripts\verify-windows.ps1 -SkipGateway`: Hermes runtime, plugin linked and enabled, tool called, line written with the documented keys: passed |
| Reversible actions on the real machine | Recycle Bin (a dummy file, now in the bin), toast, volume and dark mode set to their current values, kill of a missing pid: behaved as designed |
| `npm run dist:win` | produces `HeraldOS-Setup-0.1.0-alpha.1-win-x64.exe` (NSIS) and `HeraldOS-0.1.0-alpha.1-win-x64.appx` (valid manifest, unsigned) |
| Packaged `win-unpacked\Herald OS.exe` | starts, opens the control server, links the plugin (junction) |
| `npm run dev` | the shell and renderer start and the control server listens; the backend part is blocked, see below |
| Linux | `linux.test.ts`, the Linux adapter tests and the `electron-builder --linux` packaging config (`-c.npmRebuild=false`) ran from Windows and pass. `npm run dist:linux` itself recompiles node-pty for Linux and cannot run on Windows |

### Second pass (after the first report)

| Check | Result |
| --- | --- |
| Window buttons | `WindowControls` in the menu bar (Windows only): minimize, maximize / restore, close, in the status cluster's style; IPC `windowMinimize` / `windowToggleMaximize` / `windowClose`; `WindowState.maximized`. One real click on "restore" left fullscreen as designed. The other two buttons were not clicked on the real desktop (a media player was in front of the app and a stray click could have hit it); the toggle's decision logic is unit-tested (`window-controls.test.ts`) |
| Hermes on this machine | Not repairable without changing permissions: `%LOCALAPPDATA%\hermes	ools\*` answers "Access is denied" to this account (also outside my tool sandbox), so the launcher's `python.exe` cannot run. Fixing that means taking ownership / resetting ACLs, which is a security-settings change and was not done; `hermes pm repair` and `hermes update` cannot start without that Python. The official `install.ps1` was read but not run: it prepends its `bin` folder to the user `PATH` |
| An active Hermes instead | A second, isolated Hermes 0.21.5 built from the pinned upstream snapshot (`uv venv` + `uv pip install -e .` in a scratch folder, its own `HERMES_HOME`; nothing of the user's changed) |
| `npm run bootstrap` against it | links the plugin, `plugins.enabled` gets `herald-os-bridge`, the `herald_os` toolset is enabled, `tools.tool_search.enabled: "off"`. Found and fixed: the voice probe's quotes were lost by Windows PowerShell 5.1 |
| `scriptserify-windows.ps1` (full) | 6 of 6 steps pass: runtime, plugin, gateway status, `tools.list` over the WebSocket (`herald_os`: 13 tools, enabled), tool call through the registry, audit entry |
| `npm run dev` with that Hermes | "Hermes is ready"; backend `ready on http://127.0.0.1:<port>`; control server on loopback TCP |
| UI to bridge to audit | The app attached to a running `hermes serve` (it writes `control.json`); the bridge's `os_ui` tool, called through Hermes's registry, read the real shell's state (153 commands), opened Memory then Overview in the app, and each call left an audit line (`tool=os_ui tier=read decision=allowed ok=true`) |
| NSIS installer | `/S /D=<dedicated folder>`: installed, Start menu and desktop shortcuts and an uninstall entry created, launched against the isolated Hermes (backend ready), `Uninstall ... /S` removed the folder, the entry and both shortcuts |
| Hermes's own ripgrep | confirmed: it ships `tools
ipgrep-15.2.0-win32-x64`; the bridge and the shell now look there too |

### Still not validated, and why

- **appx installation** (needs a signing certificate whose subject matches `CN=HeraldOS`), the tile
  images (electron-builder's defaults are used; real ones belong in `apps/desktop/build/appx/`), and
  the executable's embedded icon.
- **The maximize and close buttons on the real desktop** (see above) and the window's behaviour on
  Windows 10.
- **macOS.** `dist:mac` and the macOS code paths cannot be built or run on Windows. The macOS-specific
  tests (`darwin.test.ts`, the Darwin parsers) run and pass here. The WSL distribution on this machine
  is broken (its virtual disk is missing), so Linux could not be run either.
- **Windows 10 and non-French Windows.** Locale-dependent output (`netsh wlan`) is parsed with fixtures
  in French and English; Wi-Fi and Bluetooth hardware are absent on this machine, so those paths ran
  against fixtures only.
- **Not exercised on purpose:** `lock_screen`, `sleep_display`, `open_settings`, force-killing real
  processes, the toast's on-screen appearance.

## Assumptions to confirm

1. `hermes serve` runs natively on Windows (Hermes's Windows guide lists the dashboard as working; the
   `serve` subcommand and its `HERMES_BACKEND_READY port=` line exist in the installed 0.21.6).
2. Hermes's terminal tool needs Git Bash (documented); the Herald Terminal app uses PowerShell instead.
3. `Get-StartApps` is the list of installed apps (Start menu), including Store apps. Programs without a
   Start entry are not listed.
4. The Recent folder (`%APPDATA%\Microsoft\Windows\Recent`) approximates "recently used files".
5. `UIOption.AllDialogs` is used for the Recycle Bin so that a file too large for the bin raises
   Windows's own confirmation instead of being deleted silently.
6. The per-core-summed CPU percentage is divided by the logical CPU count.
7. Event 1000 of "Application Error" is the crash record to read; there is no stack in it.

## Found on the way (not caused by the port)

- `src/commands/software.ts` defines the command id `software.local_model`, which `defineCommands`'
  own regex rejects (`_`), so command registration logs an error at startup on every platform. Not
  changed here.
- `npm run` re-exports a user-level `allow-scripts` npmrc setting as an environment variable that a
  nested `npm install` rejects; `bootstrap.ps1` clears it for its own call. `bootstrap.sh` has the same
  exposure.
- On this machine `hermes.exe` (the launcher shim) exits 1 with no output when its output is piped; it
  is the damaged install, not the port, but it is why the resolution ladder prefers the managed
  install's `python.exe -m hermes_cli.main` over the shim.

## Housekeeping

- The repository had no git identity here; `user.name` / `user.email` were set **locally** in this
  clone only.
- `package-lock.json` was touched by `npm install` and left out of the commits.
- Build output (`apps/desktop/release`) is git-ignored.
- While stopping the dev servers I ran one `taskkill` that was broader than intended (it named every
  `node.exe`). The other `node` processes on the machine (MCP servers and similar) were still running
  afterwards, so it appears to have killed nothing outside this work, but it could not be proven.
  Later cleanups were filtered by executable path.
- A scratch Hermes (venv, home, logs) lives under this session's scratchpad folder, outside the
  repository; nothing of the user's Hermes was modified.
