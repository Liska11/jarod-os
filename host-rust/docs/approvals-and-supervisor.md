# Approvals and supervisor (phase 2.4)

## One prompt, one authority: `host_control::broker`

Anything the host does only with a person's agreement goes through one `ApprovalBroker`: a `mutate` or
`destructive` control call today, the removal of unused models tomorrow. The host is the authority and the only
party that can answer; Hermes (the agent) is the **initiator**, never the approver.

| Rule | Where it is enforced | Test |
|---|---|---|
| The answer comes from the host's window (a `Prompter`), through no wire command, field or capability | the matrix has no approving command; a request cannot carry its own approval | `nothing_that_can_be_sent_to_the_host_answers_an_approval` |
| One prompt at a time; a second request while one is open is **denied, not queued** | `ApprovalBroker::request` (single slot) | `one_prompt_at_a_time_and_a_second_request_is_denied_not_queued` |
| No prompter, a window that is gone, a prompter that fails: a no | `HostControlGate` | `a_window_that_is_gone_is_a_no`, `fc4_…rejects_or_throws…` |
| A prompter that **panics, even before returning a future**, is a no and the connection survives | the provider runs inside its own task | `fc4_an_approval_service_that_rejects_or_throws…` (both forms) |
| Nobody answers: the gate's timeout denies **and withdraws the prompt** | `AbortOnDrop` on the prompt task | `fc4_…never_answers…` |
| The caller hangs up while the person has not answered: the prompt is withdrawn and the slot freed | `serve_connection` keeps listening while a request is handled, and drops the handler on disconnect | `fc4_a_caller_that_goes_away…` |
| A late, repeated or invented answer is ignored | `ChannelPrompter::answer` | same file |
| The arguments preview is for the person's eyes, never journalled | `ApprovalAsk.preview` is not written by the gate | `the_person_says_yes_through_the_host_window…` |

The FC4 scenarios of `jarod-core/packages/plugins/agent/test/approval-failclosed.test.ts` (the agent loop's own
tests of the same rule) are reproduced against the Rust host: an approval service that rejects, throws, never
answers or is abandoned means the tool does not run, and an ordinary refusal leaves it unexecuted while an
agreement is the witness that it can run. The moment-of-effect scenarios (AR2–AR8: "always allow", plan mode,
permissions read at every call) are the agent loop's policy and stay in the TypeScript kernel; the host does
not decide *whether* to ask, it makes sure that asking cannot be bypassed or stuck.

Two defects found while writing these tests, both fixed in the gate: approval ids came from the clock (two asks
in the same millisecond collided; they are now random), and dropping the handle of the prompt task left the
prompt running (it now aborts on drop). `wire.rs` also changed: while a request waits for a person, the
connection is still read, so a disconnect is noticed and further requests are queued within bounds
(64 lines, 4 MiB).

The spike binary's window is its own console: `herald-host-spike … --approve-on-console` prints what is about to
happen to stderr and reads one line from stdin; only `y` or `yes` is a yes, EOF is a no
(`the_console_is_the_approval_window_and_only_a_typed_yes_is_a_yes`). The real window is a `Prompter` for the
Tauri/Electron UI of phase 7; nothing else in the host changes when it exists.

Not unified yet: the Electron shell still shows its own dialog (`approveMutation` in `main.ts`) until the UI
moves to the new host (phase 7). The storage purge's "unused models, with agreement" has the hook
(`PurgeReport::needs_agreement`) but does not call the broker yet.

## The supervisor: `host-supervisor`

Starts a child, keeps it alive, never trusts it.

- **Environment is built, not inherited.** `ChildEnv` takes an allowlist (`WINDOWS_ESSENTIALS` plus what the
  caller names). The names of `c5-control-env-names`, **loaded from `contracts/v1`**, are never inherited
  (compared without case, as Windows does) and cannot be `set`; the only way in is `grant_control(name, value)`,
  per name, for a name the contract lists. The Cordis kernel is granted `JAROD_GATEWAY_TOKEN` and nothing else.
- **The tree dies with the host.** Each child generation is in a Windows Job Object with
  `KILL_ON_JOB_CLOSE`: killing the host from outside (no chance to clean up) ends the child and its
  grandchildren (`killing_the_host_takes_the_whole_process_tree_with_it`, with the binary and a real process
  tree). A crashed or restarted child's leftovers are terminated with its job.
- **Ready, health, restart.** Ready = a sentinel line (`HERMES_BACKEND_READY port=N` for the kernel, the line the
  Electron shell reads today); health = `GET /api/status` expecting `{"status":"ok"}`, N failures in a row end
  the child; restart with an exponential backoff, and give up (state `Failed`, with the reason) after too many
  failures inside a window; a program that cannot be started is not retried; a deliberate stop is never
  restarted and cuts a backoff short.
- **Output is bounded and redacted.** A line is kept to 64 KiB; every line goes through the journal's redaction
  against the values the host knows (the vault's, and the control values the child was granted) before a log
  sink sees it.
- **Stop = close stdin**, the only clean stop on Windows and what the kernel waits for (`--exit-on-stdin-close`);
  after a grace period the whole tree is terminated.

### Gate: the current kernel starts under the Rust supervisor

`the_current_cordis_kernel_starts_under_the_rust_supervisor_and_stops_cleanly` launches the real
`jarod-core/dist/gateway/gateway.mjs` (the file Electron launches) with `node --init --exit-on-stdin-close
--workspace <ws>`, on a **throwaway profile** (`JAROD_HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP` all under a
temporary root; the real profile is never visible to it), granted only `JAROD_GATEWAY_TOKEN`. It reaches
`HERMES_BACKEND_READY`, answers `GET /api/status` with `{"status":"ok","backend":"jarod"}`, wrote its profile
where told, and on a polite stop removes its token file and exits. That is the process-level contract; the
functional parity of the whole app on the new host (chat, settings, apps, onboarding) is phase 7.

Limits: the supervisor is Windows-only for process-tree control; a restart does not carry the kernel's session
state (the kernel owns its own persistence); `herald-supervise` is a development command, not a service.
