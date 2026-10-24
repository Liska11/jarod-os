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
| `bin/jarod-host-spike` | assembles all of it, refuses to start on any missing prerequisite | `main.ts` |

The spike executes nothing (a no-op executor answers what the gate authorises) and has no approval
channel, so `mutate` and `destructive` commands are refused with `denied-policy`. The tokens go to files
in `--token-dir` so the door can be driven by hand; a real host keeps the backend token in memory.

## Fail closed

The host does not serve (exit status 2, nothing announced on stdout) when:

- `JAROD_OS_CONTRACTS_DIR` is unset, the folder, an index entry, a schema or the golden matrix is missing, a
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
JAROD_OS_CONTRACTS_DIR=../contracts/v1 cargo run -- --journal /tmp/control-audit.jsonl --token-dir /tmp/jarod-tokens
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
12. **The redaction is wider than the shell's.** The TypeScript `redactSecrets` finds values made of token
    characters inside runs; the Rust one also finds free-form values (the vault's) anywhere in the text. The
    host's own tokens, capabilities and nonces are in the token set, so both agree on them.
11. **A token-shaped but well-formed `requestId`** is echoed to the caller who sent it, in both hosts (the caller
    already has it); the journal never holds it, because the redacted form is not a well-formed id and is dropped.

## In shadow of the shell (V-22, 2026-10-24): `jarod-control-shadow`

The first step of moving the door, and only that: **the Rust adjudicator decides beside the TypeScript one, it never rules.** Off
unless `JAROD_HOST_CONTROL=1`; the rollback is the flag.

- `src/bin/jarod-control-shadow.rs` (any platform: the adjudication is pure): `[--contracts DIR]` (else `JAROD_OS_CONTRACTS_DIR`). On
  stdin, a first line with two tokens minted for it, then one line per request (`surface`, `request`, the catalogue's tier for its
  command id, whether the catalogue is loaded); on stdout `{"ready":true}`, then one `adjudicate` decision per line. Missing contracts or
  bad tokens: exit 2 before `ready`. `tests/shadow.rs` (2 tests) drives the real process.
- The shell (`apps/desktop/electron/shell/control-shadow.ts`, wired in `main.ts`) adds an observer to both doors (`ControlSecurity`
  `addObserver`: told each decision after it is made, cannot change it, ignored if it throws). Each request goes to the shadow with only
  `cmd`, `command`, `args` and the shadow token of the client the door recognised: **the live tokens never leave the shell**, so
  authentication is compared by its outcome, not re-checked. Any differing field (`allowed`, `client`, `code`, `tier`, `reason`) goes to
  `<config>/control-shadow.jsonl`, redacted by the door. Difference 2 above, when this side's argument check refuses the request too, is
  counted as known and not written. A missing binary or one that stops only turns the shadow off, with a line in the log.
- Proof: `control-shadow.test.ts` runs every kind of request in the C2 matrix through both real doors and the real binary, with the
  catalogue loaded and not yet loaded: 0 divergences, 2 known (difference 2), over more than 300 requests across the two doors. A wrongly allowed
  request is caught and written down. `e2e/control-shadow.spec.ts`: in the running app the shadow starts and stays up with the flag,
  nothing starts without it.

- Counter: `<config>/control-shadow-stats.json` (compared, diverged, known, dropped, the same per `surface:cmd`, at most 200 distinct
  rows, keys redacted), written at start, at most once a second while requests come, and when the shadow stops (`stopReason`, `app quit`
  when the app quits; the log line repeats the totals).
- **Validated on a real session** (2026-10-24, `e2e/control-shadow-session.spec.ts`): the built app with its real bundled core, throwaway
  profile, flag on; the test sends nothing to the door itself. First-run screens, core ready, capability registry read then re-checked 5
  times (what Réglages › Capacités does), the page opened, the app quit. 7 requests compared (`backend:ui-list` 6, `backend:state` 1),
  0 diverged, 0 known, 0 dropped, stopped on `app quit`; the same on three runs. Scope of that proof: the traffic a session sends without a
  model, i.e. the core's own requests on the backend door (read tier). On Windows the panel door is not open (Linux panels only), and the
  `ui`/`run` requests an agent's tools send need a model and were not part of it.

Not done: the binary is not packaged; agent turns (`ui`/`run`, act and mutate tiers) not yet seen through the shadow in a real session;
the in-process door (`submitLocal`) is not adjudicated by `adjudicateOnly`, so it is not shadowed; the Rust host does not serve the door.

## Storage (phase 2.1, 2.2): `crates/host-storage`

The NVMe volume is a **controlled zone, not a safe one**. C: holds Windows and the minimal host; D: is the
work volume (models, downloads, updates, sandboxes), and it is never handed to a plugin.

```rust
pub trait StorageVolume {
    fn resolve(&self, zone: Zone) -> PathBuf;                       // host-internal, never given to a plugin
    fn available_space(&self) -> Result<u64>;
    fn reserve(&self, request: &ReservationRequest) -> Result<Lease>;
    fn release(&self, lease_id: &str) -> Result<()>;                // content stays, counted against the zone
    fn purge_cache(&self, policy: &PurgePolicy) -> Result<PurgeReport>;
}
```

A plugin sends `{plugin, zone, requestedBytes, purpose}` (`c9-storage-reservation`, validated against the
schema before it is read) and receives a lease (`c9-storage-lease`): `<root>/<zone>/<plugin>/<lease id>`.
Both contracts are **provisional** (the TypeScript and Python suites validate their fixtures; nothing writes
them but this host yet).

| Concern | How |
|---|---|
| Zones | 7 reservable (`models`, `downloads`, `updates`, `sandboxes`, `cache`, `temp`, `artifacts`); `profiles`, `databases`, `security-logs` are never reservable, scanned or purged, whatever a policy says |
| Quotas | per zone, counted as *on disk + still owed to active leases*; never exceeded under concurrency (one lock) |
| Space | no reservation takes the volume below `min_free_bytes`, and what active leases are still owed comes off the top |
| Paths | `path.rs` is the only way a name becomes a path: no `..`, absolute path, drive or stream syntax, device name, trailing dot; **no reparse point anywhere** (a junction planted in a lease is refused; a junction orphan is removed as a link and its target survives) |
| State | `<root>/.host/state.json`, written atomically; unreadable, wrong version, or an entry that names a path rather than a plugin or lease: the volume **does not open** |
| Zone ACL (Windows) | `acl::harden_zone_root`: protected DACL, this user only, full control, inherited; read back from the live directory; Everyone, Users, SYSTEM, Administrators are refused by name |
| Purge order | 1 interrupted temp files and expired unreleased leases, 2 caches (least recently used first), 3 finished sandboxes (not `.retain`), 4 old artifacts, 5 old validated updates, 6 unused models (only with agreement), 7 never the host's own data. A selection is a **prefix** of the ordered plan, so a tier is touched only after every lower tier |
| Last working version | the most recently validated update, anything marked `.current`, anything locked, anything under a `protect`ed path is never removed |
| Report first | `PurgePolicy::default()` is a dry run; it lists what each tier would take, what needs the person's agreement and what was skipped, and why |
| Orphans, dedup, VHDX | `find_orphans` / `reclaim_orphans` (age, dry run), `dedup` (hard links, immutable zones only, file identity checked so a pair already linked saves nothing), `inventory_vhdx` |
| Health | `DiskHealthProbe` (PowerShell, read-only) with plain thresholds for temperature, wear and errors; an unreadable counter is "unknown", never an alert and never a reason to delete |

What the zone does **not** do, stated plainly: it cannot stop a plugin from writing outside its lease (that
is the sandbox of phase 3), it holds no secret (the vault of 2.3 lives under C:), and its "network filtered,
distinct identity, auditable reset" properties belong to the VM/sandbox that will run on it, not to this
crate. NVMe temperature and wear were not readable without elevation on the development machine: the probe
returned the disks and their Windows health, with the counters unknown.

## The vault (phase 2.3): `crates/host-vault`

The one place a secret lives at rest. Sealed with DPAPI (current-user scope, no UI) with the secret's **name
as extra entropy**, one `<name>.sec` file each (`JVLT` + format byte + the sealed blob).

- Nothing readable at rest: the tests scan the whole directory for each value in raw, UTF-16 and hex form,
  and for fragments of it.
- A blob that does not open (flipped byte, truncated, wrong header, **copied under another name**, sealed for
  another user) is `VaultError::Corrupt`, never `None`, and is unknown to the redaction.
- A protector that fails on `put` leaves no file and keeps the previous value; replacement is write-then-rename.
- Names are plain lowercase ids (no path, no device name, no trailing dot); a vault directory that is a link is
  refused; `open_hardened` also gives the directory the user-only DACL of the storage zone.
- `SecretBytes` is zeroed on drop and prints `[redacted]`; the observer hears operations and names, never values.
- **Redaction**: `vault.secret_source()` feeds `ControlSecurity::add_secret_source`, so a vault value in any
  free-text field of a request is journalled as `[REDACTED:vault]` (tested with the real pipeline and a real
  journal file, including a value stored after the host started). While doing this the redaction was extended:
  values made only of token characters are still found inside runs (linear), anything else (a Telegram bot token
  contains `:`) is searched at every position, both by constant-time digest comparison.

Limits, stated: a value shorter than 8 characters is not masked (masking a 4-character PIN would destroy
ordinary text); a value that is not valid UTF-8 cannot be matched as text; the cleartext necessarily exists in
this process's memory while it is in use (the redaction keeps a copy to compare with), which only a separate
process boundary would change.

## The sandbox (phase 3.1): `crates/host-sandbox`

Write confinement of a command in an AppContainer (R4), with a `jarod-sandbox` CLI and a machine self-test.
See `docs/sandbox.md` (what is proven, and the stated limits: legacy `dir`/`del`/`attrib` do not work inside).

## Not done here

The TypeScript side of the sandbox (3.2), plugins (3.3). Unix-socket transport (Linux image).
Authenticode/signing of the host binary (a different trust chain).
