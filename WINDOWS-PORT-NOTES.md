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
| CI | A step name with an unquoted `:` made `ci.yml` invalid YAML; fixed, and every workflow now parses (checked again after the `kernel` job and the pnpm steps were added). `windows-installers.yml` (manual or `v*` tag) builds the installers as artifacts. **None of it has run**: `origin` is `PAVADI234/herald-os`, there is no fork of the owner's, and nothing was pushed |
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

### Outcome (2026-10-11, same day)

Option C kept (Nous stays an API-key provider, `NOUS_API_KEY`); device-code OAuth (B) is deferred to a separate phase with its own
security audit; driving `hermes auth` through a pty (A) is dropped. Done in `jarod-cordis` (`spike/hermes-gateway`), shell untouched:

| Commit | What |
| --- | --- |
| `e23769c6` | `model.options` reads local servers (`GET <base>/models`, 2 s timeout, 5 s cache, 2 s on failure; invalidated by `config.set`, `PUT /api/config`, `/model`). Embedding models and the local Whisper are not offered; no remote provider is queried |
| `945ded7b` | `GET /api/config/raw`: read-only view limited to `model.provider` / `model.default`, values quoted and masked; `PUT` answers 405. A test fails if a key-shaped value, the vault key or the server address appears |
| `31a548e9` | **Found in the window, step 3:** the picker sends `/model provider:model` but Jarod's `/model` only reads `provider/model`, so the choice left the provider unchanged and set the whole text as the model name. `slash.exec` now rewrites the unambiguous case (known provider id first). Verified in the window with a fake LM Studio and the real Ollama model (`qwen3.5:0.8b` answers) |
| `1d0766a4` | `scripts\verify-jarod-os.ps1`: gateway reachable → models discovered → provider change → setting persisted after reopening the core → `config/raw` current and secret-free. Exit code 1 when the `/model` fix is removed |

Step 3 finding recorded, not fixed (shell behaviour): the picker only changes the model while a conversation is open
("Open a session first" otherwise). The gateway is not involved.

## Rename Herald OS → Jarod-OS (2026-10-11)

Earlier sections of this file keep the old names (`Herald OS.exe`, `HeraldOS-Setup…`, `CN=HeraldOS`): they describe what was built then.

**Scope.** Text shown to the user, docs and script messages: the product name `Herald OS` became `Jarod-OS` (762 lines, 222 files); a lone `Herald`
became `Jarod` in docs and in non-comment lines of the interface (49 occurrences). Done by one script and applied in one commit.

**Identity chosen (final, distinct from upstream `dev.iamluke.heraldos`)**

| What | Value |
| --- | --- |
| `productName`, `executableName`, window titles, `app.setName` | `Jarod-OS` (so `win-unpacked\Jarod-OS.exe`, install folder `Programs\Jarod-OS`, user data `%APPDATA%\Jarod-OS`) |
| electron-builder `appId` and Windows AppUserModelId | `one.jarod.os` (the Jarod app is `one.jarod.desktop`) |
| MSIX / appx | `identityName` `Jarod.OS`, `applicationId` left to the electron-builder default (= the identity name, so `Jarod.OS`), `publisher` `CN=JarodOS`, display names `Jarod-OS` (read back from `AppxManifest.xml` of the built package) |
| Installer files | `JarodOS-Setup-<v>-win-x64.exe`, `JarodOS-<v>-win-x64.appx` (CI upload globs updated) |
| Launcher default (jarod-cordis `launch.ts`, commit `9e90e35e`) | `…\win-unpacked\Jarod-OS.exe` |

**The NSIS and MSIX identities are final.** `one.jarod.os` and `Jarod.OS` / `CN=JarodOS` are not to be changed again once an installer has been given to anyone:
Windows ties the per-user uninstall entry, the AppUserModelId (taskbar pins, notifications) and the MSIX package family to them, so a later change orphans every
existing install. Publishing to the Microsoft Store would **not** be possible with these values: the Store requires the identity name and the publisher subject that
Partner Center reserves for the account, and a package signed by Microsoft. Until then the `.appx` is an unsigned sideload artifact (it needs a certificate whose
subject is exactly `CN=JarodOS`, see `README-WINDOWS.md`), and the NSIS installer is also unsigned.

The old `%APPDATA%\Herald OS` folder is **not migrated** and not touched (see "Post-rename checks" for what it contains).
`NOTICE` and `LICENSE` are untouched and ship inside the package (`resources\NOTICE`, `resources\LICENSE`).

**`git grep -i herald`, lines before → after** (the 2 891 lines are classified the same way before and after; figures recomputed on commit `47970b9` itself, which
corrects the first version of this table: the commit holds 2 246 lines, not 2 225, because this section and the next ones are in the same commit and mention the old name)

| Category | Before | After | Why it stays / what changed |
| --- | ---: | ---: | --- |
| Attribution and upstream URLs (`NOTICE`, `LICENSE`, any line with `iamlukethedev`) | 30 | 30 | MIT notice and links to the upstream project; not ours to rewrite |
| History and provenance (`docs/DECISIONS.md`, `jarod-*.md`, this file, `linux/migrations/`, `upstream/`, `scripts/sync-upstream*`, `scripts/migrate-hermes-config.py`, lockfile) | 162 | 183 | They record what happened under the old names. +21: the sections of this file that describe the rename |
| Strings written into user files then compared on removal (Omarchy hook, menu line, key binds in `linux/bin/herald-os`, and the Linux test that asserts them) | 39 | 12 | Renaming them would make an existing install impossible to remove cleanly (`== HOOK_DISPATCHER`, `MENU_MARK`). 27 display messages of that file were renamed |
| Deliberate mentions of the old name (README provenance, legacy install folder recognised by `bridgeLinkPlan`, its test) | in the next row | 5 | See "Script fixes" below |
| **Displayed name `Herald OS` / `Herald` (renamed)** | **737** | **0** | The point of the commit |
| Prose in code comments, lone `Herald` | 46 | 49 | Not displayed; left to keep upstream merges small (3 more lines appear because lines that held both a renamed and a lone word moved here) |
| Checkout folder `Herald-OS` (`~/Herald-OS`, `cd Herald-OS`) | 27 | 27 | A path on disk and in docs, not the product name |
| Identifiers: `herald-os*`, `herald_os`, `HERALD_OS*`, `heraldOS`/`HeraldOS*`, `herald-*` | 1 850 | 1 940 | Contracts and paths, kept as agreed: `window.heraldOS` IPC, `HERALD_OS_*` environment, plugin `herald_os` / `herald-os-bridge`, data folders under `herald-os`, `SESSION_SOURCE` / `LISTED_SESSION_SOURCES`, theme ids. Why +90: see below |
| **All lines containing "herald"** | **2 891** | **2 246** | |

**Why the identifiers went from 1 850 to 1 940 (+90), measured line by line (before/after matched on file + text with Jarod↔Herald normalised):**

| | Lines | Explanation |
| --- | ---: | --- |
| Moved from the "displayed name" row | +102 | Lines that held both a displayed `Herald OS` and an identifier (for example `# Herald OS … herald-os` in `linux/niri/config.kdl`, 15; `README.md`, 10; `docs/LINUX.md`, 7; `linux/bin/herald-os`, 7; …). The classifier tests the display name first, so before the rename they counted there. After it only the identifier remains, unchanged, so they count here. **No identifier was added or changed** |
| New lines | +2 | Two lines of the provenance paragraph in `README-WINDOWS.md` that name `herald-os-bridge`, `HERALD_OS_*`, `window.heraldOS` on purpose |
| Identity strings renamed on purpose | −14 | `appId` `dev.iamluke.heraldos`, the AppUserModelId, `HeraldOS-*` artifact names (package.json ×3, CI globs ×2, README-WINDOWS ×3), `CN=HeraldOS`, `HeraldOS.HeraldOS`, `applicationId`, and the WindowsApps sample path in `bridge-staging.test.ts` |
| Net | +90 | New tests do not contribute (the only test line that mentions the old name, in `bridge-plugin.test.ts`, is in the "deliberate mentions" row), and neither does the launcher commit: it is in the jarod-cordis repository, outside this grep |

Not touched either: `TERM_PROGRAM=HeraldOS` (seen by programs run in the Terminal app), `XDG_CURRENT_DESKTOP=HeraldOS` and the PowerShell `HeraldOS`
namespaces (internal), the gateway protocol and every JSON contract.

**Script fixes the rename needed (the scripts were corrected, not the rename)**

- `bridgeLinkPlan` (`electron/backend/bridge-plugin.ts`): a Hermes plugin link that points into another copy of the app is replaced by this app's copy. The match
  on the Windows install folder now accepts `Jarod-OS` and the former `Herald OS`, with a test for each.
- `linux/bin/herald-os`: the Omarchy strings above were put back to their original text, and their test with them.

**Does anything reference `Herald OS.exe` by name?** Checked before the rename.

- In the code: nothing creates a scheduled task, a shortcut, a Run key or a protocol handler (`schtasks`, `.lnk` writers, `setLoginItemSettings`, `reg add`,
  `setAsDefaultProtocolClient`: no match; the Windows platform code only *reads* Start-menu shortcuts). `Herald OS.exe` appeared only in `README-WINDOWS.md`, in the
  history above, and in the jarod-cordis launcher (fixed).
- On this machine (read only): no scheduled task, no `.lnk` in the Start menu, Desktop or taskbar, no hit in `Run`, `RunOnce`, `App Paths`, `Uninstall` (HKCU, HKLM,
  WOW6432Node), `HKCU\Software\Classes`, `FeatureUsage\AppLaunch`; no appx package; no `Programs\Herald OS` install. `%APPDATA%\Herald OS` exists (left as is).
  *Correction, see "Post-rename checks": that folder was created by my own test runs of the old executable, not by an upstream install.*

**Verification (Windows 11, this machine)**

| Check | Before | After |
| --- | --- | --- |
| `npm run typecheck` | passes | passes |
| `npm test` (Vitest) | 69 files, 358 passed, 2 skipped | 69 files, 358 passed, 2 skipped |
| `npm run test:bridge` (pytest) | 185 passed, 9 skipped | 185 passed, 9 skipped |
| Lint | not available: the repository has no lint script or configuration | |
| `npm run dist:win` | builds | builds: `JarodOS-Setup-0.1.0-alpha.1-win-x64.exe`, `JarodOS-0.1.0-alpha.1-win-x64.appx` (unsigned), `win-unpacked\Jarod-OS.exe` |
| Packaged `Jarod-OS.exe` | | starts, process and window title `Jarod-OS`, connects to a gateway, user data goes to the folder it is given |
| jarod-cordis `scripts\verify-jarod-os.ps1` | 8/8 | 8/8 |

## Post-rename checks (2026-10-11, evening; Windows 11, this machine)

**1. Bridge end to end, after the rename.** `scripts\verify-windows.ps1`: 6 steps passed, exit code 0 (Hermes runtime found, bridge plugin linked and enabled,
gateway status, `tools.list` shows the `herald_os` toolset with 13 tools, `system_info` called through Hermes's own registry, audit entry
`tool=system_info tier=read decision=allowed ok=True`). The identifiers the script relies on (`herald_os`, `herald-os-bridge`, `herald-os\audit.jsonl`) were kept
on purpose, which is why it needed no change.

**2. Real install, launch and uninstall of `JarodOS-Setup-0.1.0-alpha.1-win-x64.exe`** (rebuilt with the identity cleanup above; run silently with `/S`, per user).

| Step | Result |
| --- | --- |
| Install | exit code 0 in 11 s, no administrator prompt. Folder `%LOCALAPPDATA%\Programs\Jarod-OS` (`Jarod-OS.exe`, `Uninstall Jarod-OS.exe`, runtime files). One new per-user uninstall entry "Jarod-OS 0.1.0-alpha.1" with `DisplayIcon` and `UninstallString` pointing into that folder |
| Shortcuts | `Start Menu\Programs\Jarod-OS.lnk` and `Desktop\Jarod-OS.lnk`, both targeting `…\Programs\Jarod-OS\Jarod-OS.exe` |
| Launch from the install folder | through the jarod-cordis launcher (`--herald` on the installed exe, throwaway `--data` folder): main process plus gpu, utility and renderer children, window title `Jarod-OS`, gateway ready and connected, Hermes untouched. Closing the window stopped the app and the gateway (0 processes left) |
| Default data folder | launched on its own (backend address given, so it does not start Hermes): it creates `%APPDATA%\Jarod-OS` |
| Uninstall | `Uninstall Jarod-OS.exe /currentuser /S`: exit code 0, install folder gone, both shortcuts gone, uninstall entry gone (registry keys identical to before the install) |
| Left behind | `%APPDATA%\Jarod-OS` (user data), as NSIS does by default (`deleteAppDataOnUninstall` is not set). It was created by this test only (it did not exist before), so I deleted it, together with the throwaway data folder |
| Neighbours | the existing Jarod-One and JAROD apps, shortcuts and uninstall entries were not touched (they have their own ids) |

Observations: the installer and the uninstaller are unsigned (`Get-AuthenticodeSignature`: NotSigned), so SmartScreen will warn — left as is by choice (there is no
certificate). The Add/Remove Programs **Publisher** read "Luke The Dev", taken from the `author` field of `apps/desktop/package.json`; since 2026-10-12 it reads
"Jarod-OS" (`author` plus an explicit `copyright`), the upstream attribution staying in LICENSE and NOTICE, where the MIT licence requires it. Read on the artifacts
built before that change (`release\JarodOS-Setup-0.1.0-alpha.1-win-x64.exe`, `release\win-unpacked\Jarod-OS.exe`): `CompanyName` "Luke The Dev",
`LegalCopyright` "Copyright © 2026 Luke The Dev", `ProductName` already "Jarod-OS" — a rebuilt installer carries the new values. **Not tested:** the interactive wizard (folder choice, "run after install"), installing the `.appx`, upgrading over an
older Jarod-OS, pinning to the taskbar.

**3. `%APPDATA%\Herald OS`** (read only, nothing changed or moved). It exists: created 2026-10-11 03:13, last written 20:28, 1 075 files in 26 folders, 140 MB. It holds
only Chromium/Electron state (`Cache`, `Code Cache`, `GPUCache`, `Local Storage`, `Session Storage`, `Network`, `blob_storage`, shader caches, `DIPS`, `Local State`,
`Preferences` with a spell-check language and a device salt, nothing else). `DevToolsActivePort` contains `9344`, the debugging port of my own test scripts. So this
folder comes from **my** earlier runs of the old `Herald OS.exe` (UI checks before the rename), not from an upstream Herald OS install; no process was using it and no
install of the old app exists on this machine. My earlier note that it "may belong to an installed upstream Herald OS" was wrong. It is safe to delete; it stays for you to decide.

## Test with a real model, in the window (2026-10-12, run by the owner, reported in chat)

Launched by the owner through `scripts\Jarod-OS.cmd` with LM Studio as the local provider. Result as reported, not observed by me:

- The model picker answered "Open a session first": the model choice is refused while no conversation is open (the shell behaviour documented above). The first message
  sent at that point did not get an answer.
- The following messages were answered by the real model.

So the selector works with a real model once a conversation is open, and the "open a session first" limit is confirmed on a real run. Not recorded, to be filled in
if wanted: the model name and size, whether it was picked through the picker or already loaded, and whether any tool was called (the driving of the PC with a capable model
is the part of the brief that remains to be judged). `gateway.log` of that run holds nothing for it (last written 2026-10-11 19:57, before the `/api/config/raw` change), so
there is no server-side trace to check the first message against.

## Shell change: choose the model without an open conversation (2026-10-12)

The owner allowed changes to the shell where needed. The first real run showed the cost of the old limit: on a fresh profile the first message goes out before any model can be
chosen, because the picker refused to act without a conversation ("Open a session first").

`apps/desktop/src/features/settings/sections/AgentsSection.tsx` (`PreferredModelRow.setModel`): with a conversation open nothing changes (`slash.exec /model provider:model`).
Without one it now sends `config.set {key: 'model', value: 'provider:model'}`, which the Jarod gateway applies as the default of new conversations. The footer hint
"Open a session to change the model." is removed. Against the original Hermes, which answers `config.set model requires a live session` (code 4001, `tui_gateway/methods_config_set.py`),
the error is caught and the former "Open a session first" notification is shown, so that backend behaves as before.

Verified in the window (dev shell + demo gateway, no conversation open, the owner's real LM Studio on port 1234): the list shows its two chat models (the embedding model is left
out); choosing `qwen3-coder-30b-a3b-instruct` shows "Model changed · lmstudio · qwen3-coder-30b-a3b-instruct" and the button reads the same. `npm run typecheck` and `npm test` pass (358, 2 skipped).
Not verified: a conversation started afterwards answering with that model (no message was sent to the real models in this check), and the fallback path against a real Hermes
(read from its source, not run). The shell has no component test setup, so there is no automated test for this change.

## Independence from jarod-cordis (2026-10-12)

The owner's requirement: Jarod-OS is a new application, independent of `jarod-cordis`. Before this change it was not: the kernel, the tools, the gateway and the launcher lived in
`D:\store\projet\jarod-cordis`, and the shell only worked when that checkout started it. Choices made with the owner: copy the kernel into Jarod-OS (not just ship it),
in this repository, and keep Hermes as an option.

**What exists now**

| Piece | Where | Commit |
| --- | --- | --- |
| The kernel (agent, tools, providers, memory, scheduler, messaging, gateway), copied from `jarod-cordis` commit `2d5bf46d` with `git archive` (the owner's uncommitted work there is not in it). `PROVENANCE.md` records what was left out and adapted | `jarod-core/` | `30d3eb4` |
| A registry of already-loaded plugins in the kernel, and `scripts/bundle-gateway.mjs`: the gateway and its 19 plugins compiled to one 6 MB file, plus the two plain-JS worker files and the SQLite module (prebuilt binary of the build platform only); test that builds it and starts it from a folder holding only the output | `jarod-core/` | `76a89e2` |
| The shell starts that core as its backend (`HERALD_OS_BACKEND=jarod|hermes`; the core when the build has one), stops it by closing its input, and keeps its Hermes-style files in a home of its own; `npm run bundle:core` and the `dist:*` scripts build and ship it with the Node runtime that built it | `apps/desktop/electron/backend/jarod-core.ts`, `manager.ts`, `main.ts` | `b178666`, `b3342d4` |
| The `jarod-cordis` launcher removed from the copy; the context-overflow message no longer points to a screen Jarod-OS does not have | `jarod-core/` | `ec3a4ca` |

**Verified on this machine** (Windows 11): `pnpm -r typecheck` and `pnpm -r test` in `jarod-core` pass with the origin's totals per package (cli 350 + 1 expected failure; root 226,
the difference with the origin being the removed desktop-only and launcher tests); `npm test` and `npm run typecheck` in the shell pass (370 tests). The NSIS installer built by
`electron-builder` (146 MB, was 121) was **installed**, and the installed app started on its own, with no launcher and no variable pointing at `jarod-cordis`:
its process tree is `resources\jarod-core\node.exe gateway.mjs` plus the plugin sandbox process; no process anywhere mentions `jarod-cordis`. In it, a conversation with the
owner's real LM Studio model (`qwen3-coder-30b-a3b-instruct`, 16 384 context) answered, found a system tool through `tool_search` and used it. Closing the window left no
process and no `-wal` file. It was then uninstalled cleanly. `HERALD_OS_BACKEND=hermes` still starts the real `hermes serve` (and stops it on close).

**Behaviour that changed**

- No more `scripts\Jarod-OS.cmd` and no `--real-profile`: Jarod-OS has its own profile. It is still `%LOCALAPPDATA%\Jarod-OS\profile` (the folder the launcher used), so the profile
  already created by earlier runs is picked up. `JAROD_OS_DATA` moves it.
- The working folder is `JAROD_WORKSPACE`, else `Documents\Jarod-OS` (created on demand). The old launcher default `D:\JAROD-OS` was the owner's choice, not a product default: to keep it,
  set `JAROD_WORKSPACE=D:\JAROD-OS` as a user environment variable.
- With the Jarod core, the shell's own `HERMES_HOME` is `<data>\herald-home`: it never writes into a Hermes install. (Unless `HERMES_HOME` or `HERALD_OS_BACKEND_URL` is set.)

**Not in the package** (so not available in the installed app): the embeddings and reranker workers (they run TypeScript through `tsx` and need OpenVINO), `onnxruntime-node`,
`openvino`, `node-pty`. The local embedding model, the reranker and NPU acceleration are therefore off; conversation, tools, memory, schedules and messaging are on.

**Debts and limits**

- `jarod-core` and `jarod-cordis` now diverge. A fix made in one must be carried to the other by hand.
- The runtime shipped is the Node of the build machine (90 MB). Its license notice (`NODE-LICENSE.txt`) is a short MIT text pointing to the full upstream list; the full text was not bundled.
- Building needs `pnpm` (the core is its own workspace with its own lockfile). Every workflow that runs
  `dist:win`, `dist:mac` or `dist:linux` (`bundle:core` is the first step) now installs pnpm first, and
  `ci.yml` has a `kernel` job that installs the core's workspace and runs `npm run typecheck:core` and
  `npm run test:core` on Ubuntu and Windows — before it, `npm test` at the root never reached the core's
  226 tests. Neither the workflows nor the new job have run on GitHub (nothing was pushed).
- `bundle:core`, `dist:linux` and `dist:mac` were not run on Linux or macOS (the bundling script picks the build platform's SQLite binary and Node; the data folders for those systems are in the code and unit-tested, never run).
- Still not ported from the kernel's own app, as before: `os_ui`, `client.capabilities`, `usage.bars`, `billing.state`, MCP catalogue/OAuth, Studio, streaming voice, `clarify`.

**Findings from the real-model runs (not fixed)**

- With a local model Jarod offers only 17 core tools plus `tool_search` (the other tools, among them the 14 system tools, are found by searching). Asked for "the free space of my disks", the model
  reached for `run_shell` (`wmic`, which recent Windows 11 no longer has), and only used the system tool when told to search for it. Putting some system tools in the core set would cost about 380 tokens each.
- `system_disk_usage` measures folder sizes in the home folder; it answers "what uses my disk" better than "how much is free on each drive".
- LM Studio loads a model on demand with an 8 192-token context, too small for the tool list (5 700 tokens): the first agent turn that uses a tool fails with a context error. The owner's model was reloaded with
  16 384 (`lms load qwen3-coder-30b-a3b-instruct --context-length 16384`, which also removes its idle time-to-live).

## Verification debt: Linux and macOS (not verified)

The renamed text and the new identity were applied to the Linux and macOS files too, but **none of it was run**. This machine is Windows only: the WSL
distribution is broken, macOS cannot be built here, and the Linux suite does not even import on Windows (`linux/tests/test_cli.py` fails at collection on
`os.getuid`, before and after the rename). To do before any release, in CI or on a Linux and a macOS machine:

1. `npm run dist:linux` and `npm run dist:mac` (the `executableName` and `artifactName` now apply there too: `Jarod-OS.app`, `JarodOS-<v>-mac-arm64.dmg`;
   `.github/workflows/release.yml` looks for `Jarod-OS.app`). Linux keeps its own `executableName` `herald-os`.
2. `pytest linux/tests` on Linux, and the `image`, `installer-test` and `release` workflows (their log greps and titles were renamed).
3. On a real Omarchy install: `herald-os omarchy install` then `remove`, to confirm the strings kept for compatibility still match what was written before.
4. The `windows-latest` job with the new `JarodOS-*` artifact globs, and the unsigned appx install (needs a certificate whose subject is `CN=JarodOS`).
5. `README.md` still links to the upstream releases and CI badges (lines with `iamlukethedev` are protected); it says so. Change them once this derivative is published.
6. `dist:win` leaves the earlier `HeraldOS-*` files in `apps/desktop/release` (git-ignored build output); delete them by hand if wanted.

## Parity with jarod-cordis

The owner's goal is that Jarod-OS does everything the jarod-cordis application does, under the Herald shell. The list, with the state of each function, is `jarod-core/PARITY.md`.

**How it was done.** The control channels of the cordis desktop app (the handlers behind its screens: providers, local models, Hugging Face, skills, profiles, messaging, Kanban, RAG,
backup, SSH, API server, phone, vault, plugins, automation…) were copied with their tests into `jarod-core/packages/bridge` (`@jarod/bridge`, 270+ channels; the integrated terminal is left
out: node-pty was ruled out). The gateway serves them (`jarod.invoke` over the WebSocket, `POST /api/jarod/invoke`), pushes their events (`jarod.event`) and turns the native gestures they need
(file pickers, confirmations) into `jarod.shell` requests that the window has the Electron main process perform (`apps/desktop/electron/ipc/jarod-shell*.ts`). No window means refusal, never consent. Each
screen of the shell is then a thin React page on those channels (Settings sections, plus a Kanban page). Every change that gives the agent more power still passes through the engine's own native
confirmation.

**Things the engine does that cordis's app did in its Electron host, now done here:** the agent's browser (an isolated Electron window in the shell's main process, driven by the core through the
`browser` gesture); the voice (`/api/audio/transcribe`, `/api/audio/speak`: the machine's voice rendered to WAV by the new `SpeechService.synthesize`); the work folder chosen in Settings (wins over
`JAROD_WORKSPACE`); profile switching (the shell restarts the engine on the new profile).

**Verified in a real window** (isolated profile, real LM Studio and Hugging Face): every Settings section and the Kanban page open and read real data; keys, settings, vault entries, rules, tasks, a persona,
a messaging token and skill switches were written and read back; a real conversation with Qwen3 Coder through the packaged app; the agent's browser opened a real page, followed a link and refused
the machine's own addresses; the machine's voice was rendered to WAV. **Not tried in a window** (each is covered by tests): anything that opens a native dialog (folder and file pickers, backups,
imports, SSH keys, confirmations), installing the llama.cpp engine, downloading a model, switching profile, a real transcription provider, opening the API or the phone bridge to the network.

**Not done:** wake word and continuous capture (OpenVINO models are not embedded), streaming voice sentence by sentence (the window speaks the whole reply instead), GPT-Live, updates of the core
(no release channel for Jarod-OS yet), embeddings/reranker workers, node-pty terminal.

**Duplicates removed:** the Connections page and Settings both used to set up messaging channels and MCP servers; Connections now switches channels through the same engine handler (a channel without tokens does
not switch on) and sends setup to Settings. Local models shows the llama.cpp engine once.
