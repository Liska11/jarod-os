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
| Hermes on this machine | Not repairable without changing permissions: `%LOCALAPPDATA%\hermes\tools\*` answers "Access is denied" to this account (also outside my tool sandbox), so the launcher's `python.exe` cannot run. Fixing that means taking ownership / resetting ACLs, which is a security-settings change and was not done; `hermes pm repair` and `hermes update` cannot start without that Python. The official `install.ps1` was read but not run: it prepends its `bin` folder to the user `PATH` |
| An active Hermes instead | A second, isolated Hermes 0.21.5 built from the pinned upstream snapshot (`uv venv` + `uv pip install -e .` in a scratch folder, its own `HERMES_HOME`; nothing of the user's changed) |
| `npm run bootstrap` against it | links the plugin, `plugins.enabled` gets `herald-os-bridge`, the `herald_os` toolset is enabled, `tools.tool_search.enabled: "off"`. Found and fixed: the voice probe's quotes were lost by Windows PowerShell 5.1 |
| `scripts\verify-windows.ps1` (full) | 6 of 6 steps pass: runtime, plugin, gateway status, `tools.list` over the WebSocket (`herald_os`: 13 tools, enabled), tool call through the registry, audit entry |
| `npm run dev` with that Hermes | "Hermes is ready"; backend `ready on http://127.0.0.1:<port>`; control server on loopback TCP |
| UI to bridge to audit | The app attached to a running `hermes serve` (it writes `control.json`); the bridge's `os_ui` tool, called through Hermes's registry, read the real shell's state (153 commands), opened Memory then Overview in the app, and each call left an audit line (`tool=os_ui tier=read decision=allowed ok=true`) |
| NSIS installer | `/S /D=<dedicated folder>`: installed, Start menu and desktop shortcuts and an uninstall entry created, launched against the isolated Hermes (backend ready), `Uninstall ... /S` removed the folder, the entry and both shortcuts |
| Hermes's own ripgrep | confirmed: it ships `tools\ripgrep-15.2.0-win32-x64`; the bridge and the shell now look there too |


### Third pass (Hermes repaired by its owner, then the improvements list)

| Check | Result |
| --- | --- |
| Hermes | The owner ran `hermes pm repair` and `hermes update` from an administrator prompt (v0.21.6) and reset the permissions of `%LOCALAPPDATA%\hermes\tools` with `takeown` and `icacls`. `hermes --version` then answered from a normal terminal |
| `npm run bootstrap`, `scripts\verify-windows.ps1`, `npm run dev` on that real Hermes | 6 of 6 steps pass (13 `herald_os` tools, audit entry for `system_info`); "Hermes is ready" from the managed install. The owner's gateway process was not touched |
| Window buttons, real window | Driven over the Chromium debugging protocol with trusted mouse events inside the window (nothing on the desktop): maximize set `maximized` and `IsZoomed`, the button became "Restore"; restore undid it; minimize set `IsIconic` and the window was brought back; close quit the app and its `hermes serve`. The buttons and their group are `no-drag` |
| `software.local_model` | Fixed: the registry, plugin manifests and menu extensions share one id pattern (`shared/command-id.ts`) that allows `_` |
| Sound quick panel | Lists the active outputs and inputs (default first, names from the MMDevices registry) and sets volume / mute per endpoint through Core Audio COM. Checked on this machine: three outputs and one input listed, a non-default output moved 60 to 61 and back to 60. Switching the default device stays with Windows Settings |
| Screenshots and recordings | Whole screen: a valid 3840x2160 PNG from the running app. Recording: a 3.7 s H.264 MP4 through Hermes's ffmpeg, decoded without error, stopped with `q`. Region / window: the Snipping Tool is launched (`SnippingTool.exe` on this build) and its result is read back from the clipboard; checked with a stand-in selection (file saved, previous clipboard image restored), not with a hand-drawn one |
| appx | Tile images generated from `build/icon.png` by `scripts/make-appx-assets.ps1`; the rebuilt appx carries them and the `#07080a` background. The `.exe`'s embedded icon was checked: it is the Herald OS icon, not Electron's |
| `open_settings`, `sleep_display` | `open_settings("sound")` started Windows Settings; the display was put to sleep for two seconds and woken. `lock_screen` was **not** called (it would lock the session); only the `LockWorkStation` symbol was resolved |
| `netsh wlan` in other languages | `parse_wlan` reads the fields by position when a label is unknown; German and Italian samples pass |
| `npm audit` | 12 findings (2 critical), all in build and dev tooling (`concurrently`, `electron-builder` and its dependencies). `npm audit --omit=dev` reports 0, so nothing in the packaged app. The lockfile was not changed |
| CI | A step name with an unquoted `:` made `ci.yml` invalid YAML; fixed, and every workflow now parses. `windows-installers.yml` (manual or `v*` tag) builds the installers as artifacts. **Neither has run**: `origin` is `PAVADI234/herald-os`, there is no fork of the owner's, and nothing was pushed |
| Counts | `npm run typecheck` passes; Vitest 68 files, 348 passed, 2 skipped; pytest 185 passed, 9 skipped |

### Still not validated, and why

- **appx installation** (needs a signing certificate whose subject matches `CN=HeraldOS`). Signing in
  general: no certificate was available.
- **A region drawn by hand in the Snipping Tool**, and whether Windows 10's Snip & Sketch leaves the
  clipboard the same way (the code watches for `ScreenClippingHost.exe` and `SnippingTool.exe`).
- **macOS.** `dist:mac` and the macOS code paths cannot be built or run on Windows. The macOS-specific
  tests (`darwin.test.ts`, the Darwin parsers) run and pass here. The WSL distribution on this machine
  is broken (its virtual disk is missing), so Linux could not be run either.
- **A clean Windows 11 in a VM.** Tried with VirtualBox (the only hypervisor this account can drive; Hyper-V
  answers "permission required"). The existing `jarod` VM had no OS installed and the only Windows 11 image
  available is a third-party AIO build (Arium), whose setup wizard could not be driven without a mouse
  (VirtualBox has no mouse command; the keyboard did nothing). The attempt was stopped, nothing was installed,
  and `jarod`'s settings were put back. Two synthetic clicks meant for the VM landed on a Firefox window
  instead; no page change was seen. Host-mouse automation was dropped after that.
- **Windows 10 and non-French Windows.** No such machine here. Locale-dependent output (`netsh wlan`)
  is parsed with fixtures in French, English, German and Italian; Wi-Fi and Bluetooth hardware are
  absent on this machine, so those paths ran against fixtures only.
- **Display brightness and the default audio device** from the quick panels (no laptop panel to test
  the first; the second needs an undocumented COM interface).
- **Voice extras** (`openwakeword`, `edge-tts`): not installed. Hermes installs the wake engine on first
  use, and `edge-tts` sends text to an online Microsoft service, so that is the owner's call.
- **Not exercised on purpose:** `lock_screen`, force-killing real processes, the toast's on-screen
  appearance.

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
  own regex rejected (`_`), so the commands of that group after it were never registered, on every
  platform. Fixed in the third pass (see above).
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

## Model selector in Jarod-OS: audit (2026-10-11)

Read-only audit of `jarod-cordis` (branch `spike/hermes-gateway`), of the shell, and of the installed Hermes
sources (`hermes_cli/auth_*.py`, read only; `auth.json` was **not** opened). Nothing is implemented yet.

### What exists

| Piece | Where | Facts |
| --- | --- | --- |
| Shell picker | `AgentsSection.tsx` `PreferredModelRow` | `model.options {include_unconfigured:false}`; shows only providers that have **at least one model**; a pick is `slash.exec "/model <provider>:<model>"`, which needs an open session |
| Gateway side | `packages/cli/src/gateway/config.ts` `modelOptions`, `configGet/Set`, `applyConfigPatch` | Reads `core.providers.list()` and the two settings `activeProvider` / `activeModel`. No live discovery |
| Provider catalogue | `plugins/llm/src/catalog.ts`, `providers.ts` | Local providers (`ollama`, `lmstudio`, `llamacpp`, `vllm`, `custom`) are always `configured` but ship `models: []`; the only local entry with a model is `local-whisper-cpp` (`large-v3-turbo`, **transcription only**). Cloud providers are `configured` only with a key in the profile vault |
| Discovery | `plugins/llm` `listModels()` (`GET <base>/models`), `ProviderRouter.refreshModels`, desktop handlers `discover-provider-models` / `get-model-context-window`, `LmStudioClient` (`/api/v1/models`, LM Studio 0.4+) | All exist and are tested, **none is reachable from the gateway** |
| LM Studio address | catalogue `http://localhost:1234/v1`, user override in `providerOverrides.lmstudio.baseUrl` | `localhost`, not `127.0.0.1` |
| OAuth | `desktop/src/main/handlers/account.ts` | `oauth-login` answers `success:false` ("une clé API par fournisseur"), `get-oauth-provider-statuses` is `{}`. The gateway answers `GET /api/providers/oauth` with `{providers: []}` |
| Nous | catalogue entry `nous`, `https://inference-api.nousresearch.com/v1`, **API key** (`NOUS_API_KEY`) | Jarod has no OAuth provider type at all |
| Shell sign-in | `store/hermes-auth.ts` | `/api/providers/oauth` list, `/…/{id}/start` (`session_id`, `user_code`, `verification_url`), `/…/{id}/poll/{session}`, `DELETE /…/sessions/{id}`; reads `/api/config/raw` (`yaml`) only to find `model.provider` |
| `/api/config/raw` | not served by the gateway | logged as unhandled; the shell then guesses the active provider from state |

### Assumptions of the brief that the code contradicts

1. **"OAuth provider type Nous exists in jarod-cordis"**: it does not. Nous is an API-key provider there. The
   OAuth surface in Jarod is a deliberate stub (`NO_OAUTH` in `account.ts`). Device-code sign-in would be new code.
2. **`%USERPROFILE%\.hermes\config.yaml` and `auth.json`**: Hermes on Windows keeps its data in
   `%LOCALAPPDATA%\hermes` (see the table above, already recorded for the port). More importantly, Jarod-OS
   does not use either file: the model is two settings in the encrypted profile database and keys live in the
   profile vault. Jarod-OS gives Herald its own `HERMES_HOME` (`%LOCALAPPDATA%\Jarod-OS\herald-home`), so a
   `config.yaml` written there would be a second, ignored source of truth.
3. **"Selector missing"**: reading the code, the picker is present but empty on a fresh profile. Local providers
   have no models until discovered, cloud providers are unconfigured, the Whisper entry is the only one listed
   (and it is a speech model). This is deduced from the code and has not yet been observed in the window.
4. **"Drive `hermes auth add nous --type oauth` through a pty"**: Jarod-OS has no Hermes dependency (the gateway
   replaces `hermes serve`), Windows needs ConPTY / a native module for a pty, and Hermes would write
   `auth.json` where Jarod never reads. The Nous flow in Hermes is also large (`auth_nous.py`, 1676 lines:
   invoke-JWT scope check, refresh-token rotation, a shared cross-process store, quarantine on failure).
