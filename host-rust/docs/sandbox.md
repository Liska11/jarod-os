# Sandbox (phase 3.1): `crates/host-sandbox`

Real write confinement of a command on Windows (R4). A Job Object limits memory, CPU and process count but not
files; an **AppContainer** does. This crate runs a command in one.

## What happens on a run

1. `Policy::workspace` is checked: it must exist, not be a link, and be neither a broad place (drive root,
   `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`, Windows, Program Files, ProgramData) nor a parent of one.
2. A fresh AppContainer profile with a unique SID is created (`jarod-os.sb.<random>`).
3. That SID is granted **modify** on the workspace (inheritable, propagated to what is already inside, so an
   existing file can be edited in place; no `WRITE_DAC`/`WRITE_OWNER`) and **read+execute** on `read_roots`.
4. The process starts suspended through `STARTUPINFOEX` with `SECURITY_CAPABILITIES` (no capability unless
   `network` is set) and a `HANDLE_LIST` of exactly stdin/stdout/stderr, is put in a Job Object (memory cap,
   process cap, kill-on-close, UI restrictions), then resumed.
5. Output is read on threads and capped; at the timeout the whole tree is ended.
6. Grants are revoked (with propagation) and the profile deleted. A grant that cannot be revoked is an error,
   not a silent leftover.

Anything that cannot be set up means the command is **not started** (`SandboxError::Refused`). There is no
unconfined fallback.

The command's environment is built from an allowlist: `PATH` is System32 + Windows only, `TEMP`/`TMP` are the
workspace's `.tmp`, and `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` point inside `<workspace>\.tmp\home`. The parent's
environment is not inherited (tested with a sentinel variable).

## Proven here (`tests/attack_matrix.rs`, real AppContainer, each with a control)

Writes inside the workspace work (create, edit in place, mkdir, rename, rmdir). Refused by the kernel: create,
overwrite, append, rename and delete of a file outside; a child and grandchild process; a junction inside the
workspace pointing out; a hard link to an outside file; an alternate data stream on an outside file; a registry
write. Also: timeout ends the tree, output is capped without blocking the child, grants are gone after normal
exit and after a timeout, too-broad workspaces and a missing program are refused.

**Mutation check:** granting `MODIFY` on the workspace's *parent* instead makes 6 of the 15 tests fail.

`self_test()` (and `jarod-sandbox selftest`) runs the inside/outside pair on the machine in front of it. The
host must not accept `writeScope: workspace` where it is not `confining`.

## Known limits, stated

- **Legacy `cmd.exe` utilities `dir`, `del` and `attrib` fail with "Access denied" inside the sandbox.** They
  resolve every folder above the working directory, which the AppContainer may not list. `type`, `copy`, `ren`,
  `move`, `mkdir`, `rmdir`, redirections, `for`, and programs using the Win32 API directly are unaffected.
  Granting list on the ancestors was tried and rejected: setting a DACL on `%LOCALAPPDATA%\Temp` walks and
  rewrites its whole subtree (minutes, and it touches files that are not ours). Consequence for the attack
  matrix: the "delete outside" case is only meaningful through `ren`; the delete-by-API case is covered by the
  kernel check being the same DACL.
- `cmd.exe` receives arguments with embedded double quotes as `\"` (Windows command-line quoting), which it does
  not understand. Callers pass paths without quotes or use relative paths; a program that parses its own command
  line (most do) is fine.
- AppContainers may read broad system locations by design (`C:\Windows`, `Program Files`). Reads are not hidden.
- The kernel's refusals happen inside the child and are not logged per attempt; the host reports what changed in
  the workspace instead.
- Developed and tested on one build (Windows 11 10.0.26300). Behaviour of other builds is not claimed.
- Network is off by default (not even loopback); this was configured, not exercised by a test.

## CLI

```text
jarod-sandbox selftest
jarod-sandbox run --workspace DIR [--timeout SECONDS] [--read-root DIR]... [--network] -- PROGRAM [ARGS...]
```

One JSON line on stdout. `run` exits 0 when the command ran (its exit code is in `exitCode`), 2 with
`{"refused": "..."}` when the sandbox would not start it.
