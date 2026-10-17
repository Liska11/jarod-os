# Backlog (trajectoire Jarod-OS)

Items identified and deliberately not done. Each survives the session here.

## From the master prompt

- 12 npm vulnerabilities in `apps/desktop` (2 critical, 2 high): detailed audit, then `npm audit fix` after validation.
- 543 lint warnings (accepted debt).
- 18 shell protocol tests skipped on Windows (no fake named pipe): restore coverage.
- Rotation of `control-audit.jsonl` (unbounded growth).
- The Python client is more tolerant than the shell on pipe endpoints (the Rust host emits the strict form).
- R2/R3 end-to-end in the real application to re-prove (disposable profile).

## From phase 3.1 / 3.2 (sandbox)

- **`readRoots` in the shell policy** so `node`, `git`, etc. are reachable inside the sandbox. Today the confinement is
  real but the command only sees the system folders on its PATH, which makes it of limited daily use. The Rust side
  already supports `Policy::read_roots` (granted read+execute and appended to PATH); what is missing is the field in
  `ShellPolicy` (`@jarod/contracts`), the settings UI and the plumbing in `shell-guard.ts`.
- **cmd.exe `dir` / `del` / `attrib` fail inside the sandbox** (they resolve every parent folder, which the
  AppContainer cannot list). Granting list on the ancestors was tried and rejected (it rewrites the DACL of the whole
  subtree of `%TEMP%`). Lead to evaluate later: a dedicated sandbox root (own `%TEMP%`-like parent, so the ancestors
  are folders we own and may adjust cheaply) instead of list access on the user's folders.
- **Packaging of `herald-sandbox`**: found on PATH or through `HERALD_SANDBOX_BIN`, documented but not distributed. The
  real end-to-end test (`shell-guard.test.ts`) skips on a machine without a build.
- Tested on one Windows build (10.0.26300); a second version is still to try.
- Network confinement is configured (no capability by default) but has no test.
- Per-attempt audit of refused writes is not possible from the kernel; the host reports what changed in the workspace
  instead (to wire into the audit journal).

## From phase 4 (plugin platform)

- Connect `PluginPlatform` to the kernel's real loader through a `PluginHost`, and sign the shipped plugins.
- Real memory / VRAM / disk measurement feeding `reportUsage`.
- Two frontends on one profile at once: locking and concurrent-write behaviour of settings, memory and skills
  (shared data directory today, untested under concurrency).

## Phase 7 - UI parity (status 2026-10-17)

No new UI code was written in this pass: `jarod-core/PARITY.md` already tracks 23 rows, 19 done and checked in a real
window (chat, settings, permissions/approval rules, applications, kanban, skills, etc.), 1 partial (voice: wake word,
continuous capture, per-sentence streaming), 3 deliberately out (core updates, embeddings/NPU, Nous device-code login).
Open items:
- Superseded: `apps/desktop/e2e` now holds 7 Playwright tests (onboarding, settings, permissions, chat); see the validation below.
- No UI yet for the new plugin platform, quarantine, sandbox or Hyper-V plugins (phases 3.3 / 4).
- `linux/tests/test_cli.py` cannot be collected on Windows (`os.getuid`); run it on Linux.

### Phase 7 validation (2026-10-17)

- **Mutation testing (manual, e2e rerun after each build, then reverted with `git checkout`)**:
  | Mutation | Result |
  |---|---|
  | onboarding button label `setup.later` « Plus tard » -> « Ignorer » (`locales/fr.ts`) | red: the onboarding test fails (6 later tests not run) |
  | settings filter `matches()` always true (`sections/shared.tsx`) | red: the filter test fails on the « Étapes par tour » count |
  | permission rule not appended on submit (`sections/JarodAgentSection.tsx`) | red: the deny-rule test fails on « Aucune règle. » |
  Limits: three mutations on three flows, not a systematic mutation run; the chat test and the wizard-does-not-return
  test were not mutated.
- **« Aucun réglage ne correspond »**: the message was in the DOM but never shown. The page shows it only when no
  `.settings-item` survives the filter, and `VoiceCommandsSection` always rendered one (its legend card, plus its own
  English « No command matches » line). Fixed: the legend renders only when a command matches and the local line is
  gone, so the global state appears. The e2e now asserts the message (red before the fix, green after).
  Still open (UX): the Voice section text is English-only, not in the locale catalogs.
- **« Travail récent »**: not sandboxed. `recentFiles` (`electron/platform/windows.ts`) runs PowerShell over the real
  `%APPDATA%\Microsoft\Windows\Recent` shortcuts and `fs.stat`s each target, so it reads the real profile, metadata
  only, from the UI process (not through `executeGuardedTool` or the read roots). It ignores `HERALD_OS_CONFIG_DIR`,
  so the e2e run shows real file names of this machine. To do: honour an isolation variable in tests, and decide if
  the list must follow the agent read roots.
- `prompt/` (master prompts) is now git-ignored; it is operator input, not product.
