# host-rust: the control boundary, in Rust (phase 0c spike)

> Rust owns the machine, Cordis owns the intelligence, plugins add capabilities.

This is the first piece of the privileged host: the **control boundary** of Jarod-OS, ported from the
TypeScript shell (`apps/desktop/electron/shell`) and held to the frozen contracts in
[`contracts/v1`](../contracts/README.md). It is a spike. It changes no existing execution path: nothing
in the app, the kernel or the bridge calls it, and it is not packaged.

## What is in it

`crates/host-control` (one library, one binary, no network dependency, 9 direct dependencies):

| Module | What it does | TypeScript original |
|---|---|---|
| `contracts` | loads `contracts/v1` (schemas, fixtures, the C2 matrix) **from disk**; no copy in the crate | `contracts/v1`, `control-authz.ts:47-70,187` |
| `endpoint` | C1 endpoint: `pipe://herald-os-<16 lowercase hex>`, emitted **and** accepted strictly | `controlEndpoint` |
| `adjudicate` | one request in, one decision out, refusal by default; two tokens, two surfaces | `adjudicate` |
| `capability` | one-shot capabilities: TTL, bound to the call, constant-time nonce, spent **before** execution, atomic under one lock | `control-capability.ts` |
| `redact`, `audit` | the C3 journal; a live token, capability, nonce or pipe nonce is written `[REDACTED:<kind>]` | `redactSecrets`, `ControlSecurity` (0b.1) |
| `gate` | validation, approval, capability spend, a ticket that ends a request exactly once | `HostControlGate.submit` |
| `wire` | JSON lines over any byte stream, 1 MB line limit, idle timeout | `os-control.ts`, `json-lines.ts` |
| `pipe` (Windows) | the named pipe, created **with** an explicit protected DACL, read back off the live object | `os-control.ts` + `pipe-security.ts` (PowerShell) |
| `bin/herald-host-spike` | assembles all of it, refuses to start on any missing prerequisite | `main.ts` |

The spike executes nothing (a no-op executor answers what the gate authorises) and has no approval
channel, so `mutate` and `destructive` commands are refused with `denied-policy`. The tokens go to files
in `--token-dir` so the door can be driven by hand; a real host keeps the backend token in memory.

## Fail closed

The host does not serve (exit status 2, nothing announced on stdout) when:

- `HERALD_OS_CONTRACTS_DIR` is unset, the folder, an index entry, a schema or the golden matrix is missing, a
  schema does not compile, or the golden matrix does not validate against its own schema;
- a token is missing, shorter than 22 characters, or the same as the other;
- the journal cannot be opened;
- the pipe cannot be created (another process already holds the name: `FILE_FLAG_FIRST_PIPE_INSTANCE`), or the
  DACL read back from the live object is not exactly what was asked for: protected, one `FRFW` ACE per
  principal (the logon SID of the session, or the user), no `Everyone`, `Anonymous`, `SYSTEM`,
  `Administrators`; or a token file already exists.

The endpoint is printed only after all of that.

## Run the tests

```bash
cd host-rust
cargo test            # 70 tests; transport tests need Windows (the pipe), the rest run anywhere
cargo clippy --all-targets
```

The binary, by hand:

```bash
HERALD_OS_CONTRACTS_DIR=../contracts/v1 cargo run -- --journal /tmp/control-audit.jsonl --token-dir /tmp/jarod-tokens
```

## Conformance with the contracts

`tests/conformance.rs` validates every fixture of every contract (16 schemas, 146 fixtures: 53 valid,
93 invalid) and requires each to come out as its name says. The TypeScript (shell and kernel) and Python
suites apply the same rule to the same files; all three agree on all 146.

Beyond the fixtures, live checks feed this crate's own output to the schemas: every decision is a valid
`c1-control-decision` (including 1,000 hostile requests), every journal line is a valid
`c3-control-audit-entry` and none contains a live token, capability, nonce or pipe nonce. The tests were
checked to fail when the property they guard is removed (redaction off, capability not spent, DACL not
protected, backend door open to the CLI token).

## Divergences from the TypeScript shell (listed, none fixed on the TypeScript side)

Found by writing the second implementation from the contracts. See also `contracts/INVENTORY.md`.

1. **A contract pattern was not portable.** `c1-control-endpoint` wrote a NUL as `\0` inside a regex class: valid
   ECMAScript, refused by Rust's regex engine, so the host could not even load its contracts. Changed to
   `\u0000` (same meaning in ECMAScript, Python and Rust) in `contracts/v1`; all three suites still agree.
   Rule from now on: contract patterns must compile in ECMAScript, Python `re` and Rust `regex`.
2. **An unlisted action is refused by the policy.** For `plugin` and `branding` the matrix lists the actions. The
   TypeScript tier function falls back (`plugin <unknown>` is `mutate`, `branding <unknown>` is `read`) and the
   argument validator refuses it later. Rust refuses with `invalid` in `adjudicate`, so the decision itself is a
   refusal rather than an allow followed by a refusal.
3. **Shell argument grammar is not ported.** URL schemes, panel names, event names, branding JSON: the contracts
   do not freeze them (README, "not frozen"). The Rust gate checks argument *types* and registry argument specs
   only. They have to be reproduced from `control-authz.test.ts` until they become schemas.
4. **No in-process door.** `submitLocal` (plugins and windows, no token) is not ported; the spike has the pipe only.
5. **Replies are written in request order**, one request at a time per connection; the shell answers each line
   as soon as it is done, possibly out of order.
6. **Stricter at start**: tokens of at least 22 characters, an unopenable journal stops the host. The shell
   mints 32-character tokens and treats the journal as a record, never a gate; that stays true for a line that
   fails to write later (counted, never a reason to allow or refuse).
7. **Idle connections are closed after 60 s.** The shell has no idle limit.
8. **Capabilities** are keyed by their public segment, so only the nonce is compared in constant time; a wrong
   nonce answers `unknown`, like an id never issued.
9. **Binding digests differ across languages** for numbers that print differently (`1.0`, large integers). A
   capability never crosses a process boundary, so this only matters if two hosts ever share a store.
10. **Whitespace and length units**: `trim()` follows Unicode `White_Space` (JavaScript also trims U+FEFF); the
    journal's 4096-character cut counts characters, not UTF-16 units.
11. **A token-shaped but well-formed `requestId`** is echoed to the caller who sent it, in both hosts (the caller
    already has it); the journal never holds it, because the redacted form is not a well-formed id and is dropped.

## Not done here (phase 2 and later)

Storage volumes, the secret vault, the approval UI, the supervisor of the Cordis kernel, the updater, the
sandbox. Unix-socket transport (Linux image). Authenticode/signing of the host binary (a different trust chain).
