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
