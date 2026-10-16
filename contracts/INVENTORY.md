# Contracts inventory (v1)

Each contract, the code that implements it at this commit, the tests that already protected it, and
the tests added by the 0b freeze. Line numbers are those of the branch `feature/windows-port` when the
contracts were written; the tests, not the numbers, are what keep them honest.

Test files: **TS-shell** = `apps/desktop/electron/shell/contracts.test.ts`,
**TS-kernel** = `jarod-core/packages/plugins/agent/test/contracts.test.ts`,
**PY-bridge** = `plugins/herald-os-bridge/tests/test_contracts.py`,
**PY-linux** = `linux/tests/test_contracts_c8.py`. Every contract's fixtures are walked by TS-shell and
PY-bridge from the same files; TS-kernel repeats the walk for the contracts it owns.

| Id | Status | Source (file:line) | Pre-existing tests | Added by 0b (live checks beyond the fixture walk) |
|---|---|---|---|---|
| `c1-control-request` | frozen | `apps/desktop/electron/shell/control-authz.ts:80` `ControlRequestShape`; `plugins/herald-os-bridge/bridge/ui.py:153,163,186,194` | `control-authz.test.ts`, `test_control_protocol_r2.py` | TS-shell: well-formed fixtures are never refused as `invalid`, rejected ones always refused (real tokens injected). PY-bridge: every request the client builds on the wire validates, with the id and the spent capability |
| `c1-control-decision` | frozen | `control-authz.ts:102` `ControlDecision`, `:423` `adjudicate` | `control-authz.test.ts` | TS-shell: 1,000+ real decisions (every command x token x surface x catalogue state) all validate |
| `c1-control-endpoint` | frozen | `control-authz.ts:671` `controlEndpoint`; `os-control.ts:180`; `ui.py:36,61` | `control-authz.test.ts`, `test_os_ui.py` (`tcp://` refused) | TS-shell: produced endpoints validate, bad nonce throws. PY-bridge: client accepts every produced pipe, refuses `tcp:`/`http:` |
| `c2-authorization-matrix` | frozen | `control-authz.ts:47-70` command sets, `:187` `SHELL_COMMANDS`, `:327` `shellTier` | `control-authz.test.ts` | TS-shell: code sets equal the golden file set for set; tier of every shell command (incl. per-action); each door opens only to its own token, retired commands refused on both |
| `c3-control-audit-entry` | frozen | `control-authz.ts:126` `ControlAuditEntry`, `:585` `record`, `:371` `controlAuditSink` | `control-authz.test.ts:131` (no token), `control-capability.test.ts` | TS-shell: real sink writes 9 lines (allow, refusals, malformed, approval) that all validate and contain no token, capability or nonce |
| `c3-bridge-audit-entry` | frozen | `bridge/audit.py:33` `record`, `:19` `_compact_args` | `test_tools.py:53` | PY-bridge: real writer incl. redaction, truncation, null keys; an `os_ui` attempt is one valid line whose `requestId` equals the one on the wire |
| `c4-permissions-policy` | frozen | `bridge/permissions.py:29,36,95,139` | `test_permissions.py` | PY-bridge: default text validates; valid policies honoured (destructive never pre-authorised); schema-rejected modes fall back to defaults; tier ladder and modes equal the code's |
| `c4-never-always` | frozen | `jarod-core/packages/plugins/agent/src/never-always.ts:10,24` | `permissions-gate.test.ts`, `approval-failclosed.test.ts` | TS-kernel: code equals golden, name for name, each with a reason. PY-bridge: the bridge's file/kill tools are in it and in the manifest |
| `c5-control-env-names` | frozen | `bridge/util.py:31` `CONTROL_ENV_NAMES`; exports at `apps/desktop/electron/backend/manager.ts:335-343`, `jarod-core.ts:135-143` | `test_control_security.py` | PY-bridge: **cross-check** constant == schema == golden; no child inherits any name (even when passed explicitly); every authority variable the shell exports is in the list |
| `c6-plugin-manifest` | frozen | `plugins/herald-os-bridge/plugin.yaml`; `__init__.py:42` `register`; Hermes `plugins_manifest.py:340` | `test_tools.py` | PY-bridge: the real `plugin.yaml` validates, has no `run`, and declares exactly the tools `register()` registers |
| `c7-tool-call` | provisional | `jarod-core/packages/contracts/src/domain.ts:4`; `agent.ts:1158` `executeGuardedTool` | `permissions-gate.test.ts`, `shell-guard.test.ts` | TS-kernel: every call used in the live run validates |
| `c7-guarded-tool-result` | provisional | `agent.ts:1158` | same | TS-kernel: 11 outcomes (unknown tool, invalid args, truncated call, granted, refused, plan mode, rule deny/ask, throws, huge args) all return the envelope |
| `c7-tool-audit-entry` | provisional | `agent.ts:1148` `AuditEntry`, `:1172`; `kernel/src/util.ts:42` `truncate` | `permissions-gate.test.ts` | TS-kernel: every audit line validates and has exactly the closed field set; all five decisions observed |
| `c7-bridge-tool-result` | provisional | `bridge/util.py:116,120` `ok`/`fail` | `test_tools.py` | PY-bridge: helpers and a real failing handler return the envelope |
| `c8-image-trust` | frozen | `linux/bin/herald-os:1307-1309,1459-1464,1498,1528`; `linux/image/packages.sh:98-120`; `Containerfile:11-15`; `linux/image/cosign.pub` | `linux/tests/test_trust.py` | PY-linux: CLI constants == golden; `packages.sh` and `Containerfile` carry the same rule and default; repo holds only a public key; verify argv == golden; published channels have no bypass; empty pin installs nothing |
| `c8-trust-journal-entry` | frozen | `linux/bin/herald-os:1467` `trust_event` | `test_trust.py` | PY-linux: every decision (verified, 4 kinds of refusal, dev-unsigned) writes one valid line without a key |

Not frozen (no schema): see `README.md`, "What is NOT frozen", and `notFrozen` in `v1/index.json`.

## What the freeze found (reported, not corrected)

Mission 0b forbids changing behaviour, so these are findings for the next phases.

1. **The control journal can hold a token.** `ControlSecurity.record` writes the caller's `cmd`,
   `command` and `source` verbatim, and `reason` echoes a caller-chosen command id
   (`unknown command <id>`). A caller that sends a token in one of those fields has it written to
   `control-audit.jsonl` (verified with a probe: the other door's token in `source`, the backend token
   in `cmd`, the CLI token in `command` and in `reason`). The file is user-only (`0600`), and the
   existing test (`control-authz.test.ts:131`) only covers the well-behaved path. The shape heuristic of
   `c3-control-audit-entry` rejects such a line; the code does not prevent it. For phase 1: mask or
   refuse token-shaped values before journaling.
2. **`plugin.yaml` has no `run:` field**, and neither does Hermes' manifest (`plugins_manifest.py`
   reads `name, version, description, author, requires_env, provides_tools, provides_hooks, kind,
   requires_hermes, capabilities`, the v2 fields, `emits`, `listens`). The brief's "`run: command`"
   does not exist at HEAD. The schema therefore forbids the key: a manifest cannot name a command, and
   an unknown key would be silently ignored by the loader.
3. **The tool audit line is longer than it looks.** `AuditEntry.args` is cut at 500 characters but the
   cut appends `\n… [tronqué, N caractères de plus]`, so a long argument is 537+ characters. The
   first draft of the schema said 500; the live test caught it (bound is now 600).
4. **The Python reader is wider than the host's writer.** The client accepts any
   `pipe://[A-Za-z0-9._-]{1,200}`; the shell only ever emits `pipe://herald-os-<16 lowercase hex>`.
   Not a bug, but a Rust host must emit the strict form and may not rely on the client to catch a typo.
5. **The shell ignores some malformed arguments instead of refusing them.** `args` of a type other than
   array/object (for a shell command) is read as "no arguments" by `stringArgs`, not refused. The
   schema is stricter than the code here; no invalid fixture relies on it.
6. **`NEVER_ALWAYS` names a tool the bridge does not provide**: `system_quit_app` is defined in the
   kernel (`plugins/tools/src/system/act.ts`), not in `plugin.yaml`. Consistent (the kernel owns it),
   but the two sides of "the Windows system tools" live in different places.
7. **A coverage regression from 0a remains**: 18 shell-protocol tests in `test_os_ui.py` and
   `test_control_protocol_r2.py` skip on Windows (no `AF_UNIX`). The new contract tests do not depend
   on a socket: the client is exercised through a patched pipe transport, which runs on Windows.

## Limits

- `ajv` is imported by the TS suites but declared by no workspace package; it resolves from the root
  `node_modules` through hoisting. A clean install that dedupes differently could lose it. Declaring it
  as a `devDependency` needs a lockfile update (network), so it was left for the commit that can do it.
- The schemas and the Python/TS code are checked against each other; the Rust host does not exist yet,
  so nothing proves a second implementation can be written from these files alone. Phase 0c is that proof.
- `c8-image-trust` records the policy; it cannot prove `bootc` enforces it
  (`--enforce-container-sigpolicy` was not exercised, as in 0a).
