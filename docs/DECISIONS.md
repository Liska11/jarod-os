# Architecture Decision Records

Short records of the decisions that shape Herald OS. Newest last.

## ADR-001: Consume upstream Hermes, do not fork it

Herald OS runs against the user's installed Hermes runtime (`$HERMES_HOME/hermes-agent`), which
`hermes update` keeps current. The only upstream code compiled into the shell is
`apps/shared/src` (JSON-RPC client and generated contract), vendored as a pinned snapshot in
`upstream/` and refreshed by `scripts/sync-upstream.sh`. Rationale: the runtime moves fast
(facade-plus-siblings decomposition, ~39k tests); a fork would fall behind within weeks, and the
upstream wire contract is already stable and generated.

## ADR-002: New lean shell instead of lifting the Hermes Desktop renderer

Hermes Desktop's renderer is ~585k lines and its chat, session and store layers are coupled to a
multi-connection pane shell. Herald OS needs a fullscreen environment with a different information
architecture, so it builds its own renderer on the same transport. Desktop is used as a reference
for patterns (backend ladder, ready handshake, terminal IPC, design tokens), not copied.

## ADR-003: Sessions use `source: "herald_os"`

Upstream folds the `desktop_ui` toolset into sessions whose source is `desktop`. Those tools need
client handlers that only Hermes Desktop implements. Herald OS declares its own source so the agent
never sees tools it cannot complete.

## ADR-004: The system bridge is an out-of-tree plugin executing on the backend host

The bridge registers tools with `ctx.register_tool(..., toolset="herald_os")` and never touches
core files. In Alpha the backend always runs on the same Mac as the shell, so the tools execute
server-side behind a `HostAdapter` abstraction. Client-side execution (for remote backends) is
deferred until upstream exposes a generic plugin server-request hook; the adapter boundary keeps
that move mechanical.

## ADR-005: Permissions reuse the upstream approval gate

Rather than inventing a parallel confirmation channel, mutating and destructive bridge operations
call `tools.approval.request_tool_approval`. The request surfaces to the shell as the standard
`approval` server request (once / session / always / deny), so approvals for shell commands and
for system-bridge actions share one card, one allowlist and one audit path. Destructive actions
use a per-call `rule_key` so "always" cannot persist for them.

## ADR-006: Fullscreen, not kiosk

Herald OS launches fullscreen and frameless but always allows leaving (`Cmd+Ctrl+F` toggles
fullscreen, `Cmd+Q` quits). Alpha runs on top of the user's macOS session and must never trap them.

## ADR-007: REST runs in Electron main

The renderer gets a `rest(method, path, body)` capability, and main adds the session token to each
request, so renderer code never handles the token for REST. The renderer does see the token inside
the gateway WebSocket URL it dials for streaming (the gateway authenticates WebSockets by query
string), so this is not a credential boundary against a compromised renderer. What protects the
backend is that it listens on 127.0.0.1 only and the token changes on every launch.

Amendment (voice): main also mints the tokenized URL for the backend's `/api/audio/speak-stream`
WebSocket (`window.heraldOS.voice.audioWsUrl`). The renderer already dials the gateway WebSocket
with the same loopback token, so this widens nothing; a WebSocket proxied through main would add
a copy of every PCM frame for no security gain. REST stays in main.

## ADR-009: Answer both request contracts (server requests and legacy events)

The pinned upstream snapshot delivers `approval` / `clarify` / `sudo` / `secret` as server-to-client
JSON-RPC requests. The runtime most users have installed today (0.21.0) still emits them as
`<kind>.request` events answered through `<kind>.respond` RPCs. Herald OS folds the legacy shape
into the same `ServerRequest` object (`apps/desktop/src/lib/legacy-requests.ts`), so cards and stores
have one code path and an older runtime keeps working until `hermes update` moves it forward.
The fallback is narrow, named, and covered by unit tests, as upstream's compatibility rule asks.

## ADR-010: System tools stay directly callable

Upstream defers plugin and MCP tools behind its Tool Search bridge (`tool_search` /
`tool_describe` / `tool_call`) to protect the prompt budget. Deferred, the model reliably fell back
to `terminal` for tasks the bridge handles better (a `find` over three folders instead of a
Spotlight screenshot query). There is no per-plugin "keep direct" knob upstream, so bootstrap sets
`tools.tool_search.enabled: off` and Settings exposes the switch. Cost: ~5k prompt tokens for the
eight schemas, cache-stable across a conversation. Proposed upstream: let a plugin manifest declare
`direct_toolsets`, or extend `_DIRECT_SURFACE_TOOLSETS` with session-source-gated toolsets.

## ADR-011: Backend is spawned with HERMES_DESKTOP=1

Upstream keys three behaviours on this flag: the loopback token-auth exemption when a public
dashboard URL is configured, the in-process cron ticker (no gateway is running), and orphan
reaping of backends the app previously spawned. Herald OS owns its backend exactly the way Hermes
Desktop does, so it sets the flag (plus `HERALD_OS=1` for its own consumers). Session platform is
still taken from `source: "herald_os"`, never from this env var, in line with upstream's
"surface capability is a property of the session" rule.

## ADR-008: Platform abstraction in two places

Machine facts and actions used by the shell (installed apps, system stats, open/reveal) go through
`apps/desktop/electron/platform/HostPlatform`; agent-facing capabilities go through the plugin's
`HostAdapter`. Both have `darwin` and `linux` implementations and a typed stub for `win32`, so the
Windows future has a place to land without touching call sites.

## ADR-012: Herald OS Linux Stage 1 is a session, not a distribution

The first Linux target boots a stock Fedora Cloud image into the Herald OS shell as the only
session. Kernel, systemd, NetworkManager and packaging stay Fedora's; Herald OS owns what the user
sees. This proves the experience before any security or packaging work. See `docs/LINUX.md`.

- **Fedora Cloud Base + cloud-init, not the interactive installer.** The seed ISO creates the user
  and runs `linux/provision.sh` unattended, so a VM is reproducible from two scripts and works in
  both QEMU (scriptable) and UTM (nicer window) from the same qcow2.
- **`cage` as the Stage 1 compositor.** A kiosk compositor gives the shell the whole output with no
  code of our own; foreign apps stack fullscreen on top. Window management between foreign apps
  needs our own wlroots compositor and is deferred to Stage 2 with the capability broker.
- **`greetd` autologin.** `default_session` runs the compositor as the `hermes` user on VT1 and
  respawns it when it exits; there is no greeter UI. Crash recovery for free.
- **Electron on Wayland via Ozone, kiosk mode gated by `HERALD_OS_KIOSK=1`.** The same shell binary
  runs windowed on macOS and as the session on Linux; `window.ts` branches on the env var, not the
  platform, so a Linux developer can still run it windowed under GNOME.
- **The backend stays shell-managed.** `hermes serve` is spawned by Electron exactly as on macOS.
  A systemd user unit would add a second lifecycle model before the broker (Stage 2) gives it a
  reason to exist.
- **SELinux permissive on the Stage 1 VM.** greetd and cage have no tailored policy; enforcing
  mode blocks the session on Fedora. Writing policy is part of Stage 2's sandboxing work.
- **Repo copied into the VM, not used in place.** Native modules (`node-pty`, Electron) must be
  installed on Linux; rsync over SSH (`linux/dev/push.sh`) or from the VirtioFS share
  (`herald-os-sync`) keeps one source of truth on the Mac.

## ADR-013: Two voice engines behind one voice core; the free one is the default

Herald OS talks and listens through `apps/desktop/src/store/voice.ts` and two interchangeable engines
(`apps/desktop/src/lib/voice/*-engine.ts`). Hermes is the brain in both: sessions, tools, memory and
approvals never move.

- **Chained (default, no extra cost).** Renderer mic -> energy endpointing -> `POST
  /api/audio/transcribe` -> `prompt.submit` with `surface: "voice-live"` (upstream's spoken-reply
  note: short, no markdown) -> `/api/audio/speak-stream` sentence by sentence while the reply
  streams. Providers are whatever `stt.provider` / `tts.provider` say in the runtime's config
  (Nous-managed OpenAI audio for subscribers, `local` faster-whisper and `edge` for free, keys for
  the rest). Turn latency is about two seconds; barge-in and an end-of-speech cue keep it
  conversational.
- **Live (opt-in, $0.05 per open minute).** OpenAI `gpt-live-1` over WebRTC with client
  delegation, exactly the contract upstream's Desktop implements: every `session.delegation.created`
  becomes a Hermes turn and the reply returns as `session.commentary.append`. It is the only path
  with true full duplex and sub-second replies, and the only one that costs per minute, so the
  engine opens a session only for a conversation, closes it after `liveIdleSeconds` of silence,
  refuses to open past `liveDailyCapMinutes`, and shows the running meter on the orb.
- **Rejected: gpt-realtime as the brain.** Cheaper audio, but it would either replace Hermes's
  tools and memory or need a second function-call bridge to reach them.
- **Wake word stays in the runtime.** `wake.start` / `wake.feed` / `wake.detected` with
  openWakeWord's bundled "hey hermes" model; the shell streams 16 kHz PCM when the runtime asks
  for client capture and otherwise lets it open the host mic. No second detector to maintain.
- **One microphone graph.** `audio-capture.ts` opens the mic once and fans frames out to the wake
  feed, the utterance recorder, the barge-in monitor and the WebRTC sender, so the menu-bar
  indicator is literally "the mic is open".
- **Config writes go through `PUT /api/config`** (deep merge), the same path the Hermes dashboard
  uses, so `hermes tools` and Herald OS Settings never fight over the file.

## ADR-014: One command registry; the agent drives the UI through a control socket

Voice control of the OS needs the shell's actions to be nameable and callable from outside the
component that renders them. Every user-visible action is therefore an `OsCommand` in one registry
(`apps/desktop/src/store/os-commands.ts`; catalogue under `apps/desktop/src/commands/`) with typed
arguments, a permission tier and a `CommandResult` the caller can speak or show. Inline page
handlers that voice needed (automations, connections, mission start, pause-all, the panels
`ShellCommand` switch) moved into stores so the registry, the pages and the command bar share them.

- **Fast path before the model.** A pure matcher (`lib/voice/intents.ts`) compiles each command's
  phrases into whole-utterance grammars. A confident match runs locally (no tokens, under 100 ms)
  and the voice speaks the result; destructive commands never match, and long or reasoning-shaped
  utterances fall through to Hermes. A failed run also falls through, so the words are never lost.
- **Agent -> UI over the control socket, in both shell modes.** Hermes runs in the backend and had
  no way to reach the UI on macOS (the Linux `ControlSocket` was panels-only; upstream's `desktop_ui`
  is gated to Hermes Desktop sessions; plugins cannot emit WebSocket events). The Electron main
  process now serves a JSON-lines Unix socket in desktop mode too (`heraldOsDataDir()/control.sock`)
  and hands the backend its path and a per-launch token; `ui`, `ui-list` and `ui-state` requests are
  forwarded to the Hermes window over IPC and answered with the command's result. The bridge plugin's
  `os_ui` tool is the client; the command's declared tier drives the existing approval gate and audit.
  Rejected: reusing `desktop_ui` (handlers live in Hermes Desktop), notifications as commands (no
  results, not extensible), a gateway server-request (needs core changes; still the long-term path).
- **Show the work.** Commands return a `highlight` target; items carry `data-os-target` and a small
  highlighter scrolls and pulses them; an action HUD captions each voice/agent command. `tool.complete`
  events from Hermes's own memory/cron/file tools map to the matching `*.show` command during voice
  conversations (or with the Follow Hermes preference), never while the user is typing.

## ADR-015: The Studio watches builds through gateway events, not the desktop source

"Build me a website" should let the person watch Hermes work: files appearing, the code with its
changes marked, commands and dev-server output, and the running site. Upstream already streams most
of it to any client: `tool.start` (full arguments, including the content `write_file` is writing),
`tool.complete` with `inline_diff` (Hermes's rendered review diff: ANSI colours and
`a/<path> → b/<path>` headers before ordinary hunks), and `agent.terminal.output` / `terminal.close`
for background processes. The Studio (`apps/desktop/src/features/studio/`, model in `lib/studio-model.ts`,
store in `store/studio.ts`) folds those events per session, for every session the shell knows, so
"show me the code" works for a build already under way.

- **Own preview command instead of `open_preview`.** Upstream's preview tools (`open_preview`,
  `read_preview`, `drive_preview`) are in the `desktop_ui` toolset, which the gateway enables only
  for sessions whose source is `desktop`. Herald OS sessions keep `source: "herald_os"` (ADR-003);
  claiming to be Hermes Desktop would also advertise panes Herald OS does not implement. The
  Studio detects local server addresses in process output and exposes `studio.preview` through
  `os_ui` for Hermes to name one explicitly; a `preview.open` event, if one ever arrives, is honoured.
- **`build.start` owns the setup.** It creates `~/Projects/<slug>` (the `projectsRoot` pref), starts
  a session with that folder as its working directory, opens the Studio and sends a brief that asks
  for `write_file` / `patch` (so every file is visible as it is written), background servers and a
  preview. Voice matches "create / build / make a website for …" on the fast path; longer requests
  reach Hermes, which calls `build.start` through `os_ui`.
- **Previews are their own locked-down view.** `web.openPreview` uses a separate partition, allows
  http(s) and `file://` inside the project folder only, and supports `navigate` / `reload`; the
  Studio reloads it after file changes and retries while a dev server is still starting.
- **The disk is watched too.** `fs.watchTree` (recursive `fs.watch`, dependencies, build output and
  scratch files skipped) catches files that commands create, such as a scaffolded project.
- **Focus rules hold.** A session started with `build.start` opens its Studio when it starts
  working and never again after the user closes it; other sessions that start writing code only get
  a one-time caption ("say 'show me' to watch").

## ADR-016: Hermes OS is now Herald OS

The project is named after the Herald mobile app and uses its logo, the winged H. Hermes stays the
name of the agent inside it: "Ask Hermes", the "hey hermes" wake word, the `hermes` CLI, `~/.hermes`
and `packages/hermes-client` (a client for the Hermes gateway) keep their names.

- **Renamed identifiers.** `herald-os` for packages (`@herald-os/*`), the Linux CLI and session files,
  the bridge plugin (`herald-os-bridge`) and its skill; `HERALD_OS_*` environment variables;
  `herald_os` for the toolset, the session source and approval rule keys; `window.heraldOS`;
  `persist:herald-*` web partitions; app id `dev.iamluke.heraldos`.
- **Existing installs carry over without manual steps.** At launch, Electron main merges
  `$HERMES_HOME/hermes-os` into `herald-os` and moves the `Hermes OS` Chromium profile (local storage,
  web-window logins) and its partitions; the renderer moves `hermes-os.*` local-storage keys; the
  bridge plugin performs the same data-folder merge if it runs first; `npm run bootstrap` relinks the
  plugin and rewrites the Hermes config (enabled plugin, toolset lists, "always allow" approvals);
  on Linux, `linux/migrations/2026-10-03-herald-os-rename.sh` moves per-user state and retires the
  old session files.
- **Old names are still read where users set them.** `HERMES_OS_*` variables (Electron main, the
  bridge, the Linux session), the `hermes_os` config section, and sessions saved with
  `source: "hermes_os"` (listed alongside new ones).

## ADR-017: Fedora stays the base of Herald OS Linux; Arch is a package target

Omarchy showed how much an opinionated Linux can do, and it runs on Arch. Herald OS Linux stays on
Fedora and reaches Arch, Omarchy included, with a package instead. Arch has no official ARM port (its
aarch64 work is an unofficial testbed, and Arch Linux ARM is a separate distribution), while Herald OS
is developed in an aarch64 VM on Apple Silicon and Fedora builds aarch64 and x86_64 from the same
infrastructure. Fedora Asahi Remix is also the main way to run Linux natively on M1 and M2 Macs.

- **One Linux release tarball.** `HeraldOS-<version>-linux-<arch>.tar.gz` holds the built shell and
  everything the session needs: `linux/bin`, the session files, themes, the install catalog and the
  bridge plugin. The Fedora images (ADR-018) and the Arch package (`packaging/arch/`) are both built
  from it, so there is one artifact to test per architecture.
- **The CLI is distro-neutral.** `herald-os` finds the system package manager (dnf, or pacman with an
  AUR helper) and prefers Flatpak for apps. On Omarchy, system updates go through `omarchy update`,
  because Omarchy stops a direct `pacman -Syu` that would skip its snapshot and migrations.
- **Two ways to run on Arch.** The Herald OS session (niri plus the panels) is the same as on Fedora.
  App mode runs inside Hyprland, Omarchy's compositor: one fullscreen window, as on macOS, Omarchy
  keeps its own bar, Herald follows the Omarchy theme, and Herald's theme, update and install
  commands defer to Omarchy's.
- **A compositor interface.** `apps/desktop/electron/wm/` defines what the shell needs from a
  compositor (windows, workspaces, focus, actions); niri and Hyprland implement it and the session
  environment picks one.
- **Rejected: moving the base to Arch.** It would lose the aarch64 VM the project is built in and
  Asahi, and a rolling release needs its own package mirror, snapshots and migration guard to be
  safe for people who are not Linux experts. **Rejected: a full Arch edition beside Fedora.** It
  doubles the image and test matrix for one maintainer.

## ADR-018: Herald OS Linux becomes a distribution built from Fedora bootc images

This brings ADR-012's Stage 3 forward and supersedes the landscape note that put bootable images out
of scope. Herald OS Linux is built as a bootable container image (`linux/image/Containerfile`, from
`quay.io/fedora/fedora-bootc`), and `bootc-image-builder` turns it into an x86_64 installer ISO and
an aarch64 qcow2 that boots straight into Herald OS.

- **Provisioning splits in two.** What every machine needs (packages, the session, the CLI, themes,
  Plymouth, greetd, the shell from the release tarball at `/usr/share/herald-os/app`) runs at image
  build time (`linux/image/packages.sh`); what belongs to a person (Hermes, its sign-in, the default
  apps) runs at first login (`linux/image/firstboot.sh`).
- **Updates can be undone.** `herald-os update` runs `bootc upgrade`, which stages the new image for
  the next boot; `herald-os rollback` runs `bootc rollback`, and the boot menu keeps the previous
  image. This covers what Omarchy's snapshots cover (the system, not `/home`); `/etc` and per-user
  changes still go through `linux/migrations/`. Channels are image tags: `stable` follows releases,
  `edge` follows `main`.
- **Software on an image.** `/usr` is read-only, so apps come from Flatpak, command-line tools go
  into `~/.local` (npm, mise) or a toolbox container, and `dnf install` stays a development-VM tool.
- **The installer asks little.** Anaconda with a kickstart that encrypts the disk by default and
  offers installing beside Windows; a kickstart passed with `inst.ks=` installs unattended. The
  first-boot setup in the shell (name, password, Wi-Fi, Hermes sign-in) also covers handing a machine
  to a new owner, which `herald-os reset` returns to.
- **Secure by default on release images.** firewalld with only LocalSend and mDNS open, SSH off,
  Secure Boot through Fedora's signed shim, fingerprint (`fprintd`) and security keys (`pam-u2f`)
  as opt-in setup commands, firmware through `fwupd`. SELinux stays permissive until the Stage 2
  policy work (ADR-012).
- **Signed with a key, not keylessly, while the repository is private.** Images are signed with a
  cosign key pair held in CI secrets; keyless signing would publish the workflow's identity to the
  public Rekor log.
- **The development loop does not change.** The Fedora Cloud VM with cloud-init (ADR-012) stays the
  fastest way to iterate; images are for releases and for trying Herald OS.

## ADR-019: Plugins run sandboxed

Omarchy's desktop is a set of QML plugins, and third-party ones run inside its shell process with
everything the user can reach. The landscape review rejected that model for Herald OS, and this keeps
the rule while adding widgets: each plugin is a folder with a `manifest.json` and web files, rendered
in a sandboxed frame (`sandbox="allow-scripts"`, so an opaque origin with no reach into the shell's
page, storage or cookies) with no Node and no preload, served from `herald-plugin://<id>/` under a
strict Content Security Policy. The only way out is a message channel the shell answers, and main
checks every call against the manifest and what the user granted.

- **A narrow message API.** `stats` (read the system snapshot), `run` (an `OsCommand` the manifest
  names as `run:<id>`, under the command's own tier: anything that changes something asks each
  time), `notify`, and `storage` (the plugin's own key-value store, 256 KB). A plugin cannot spawn
  processes, read files or reach the network unless its manifest names hosts the user accepted
  when enabling it.
- **Installed disabled.** `herald-os plugin add <git-url>` clones into
  `~/.config/herald-os/plugins/<id>`, validates the manifest and leaves the plugin off until it is
  enabled in Settings > Plugins (or at a terminal, with `herald-os plugin enable`), as Omarchy does.
  Enabling grants exactly what the manifest asks for then; a later manifest that asks for more turns
  the plugin off until the user agrees again. Hermes can install, update and remove plugins but not
  turn them on. Saved files reload the plugin live.
- **Hermes's extension model is unchanged.** Agent capabilities stay in backend Hermes plugins such as
  the bridge, behind the approval gate; widgets are UI that Hermes can also write for you.

## ADR-020: The Jarod core is the backend; Hermes is a compatibility option

Since the Windows port the shell starts the Jarod core (`jarod-core/`, TypeScript) whenever a build has
one, and every `dist:*` script bundles it; Hermes runs only with `HERALD_OS_BACKEND=hermes` or when no
core was built. Two implementations of the system tools followed: the Python bridge
(`plugins/herald-os-bridge`) for Hermes, and the core's own (`jarod-core/packages/plugins/tools/src/system`).

- **New system capabilities go into the core.** The bridge gets fixes, not features: it stays shipped and
  working for people who run Hermes, without a second copy of every new tool.
- **The wire contract stays Hermes's.** The core answers the same JSON-RPC and REST surface, so the shell
  needs no fork per backend, and Hermes keeps working as long as that contract holds.
- **What would end it:** when nobody needs the Hermes backend any more, the bridge and the Hermes ladder
  (`backend/resolve.ts`) can be removed in one change; until then they cost only their tests.

## ADR-021: Updates wait for a published feed

The core already has an update service (`jarod-core/packages/plugins/updates`: a local folder of
installers, plus a remote channel the host provides through electron-updater with sha512 and
Authenticode checks). The shell does not wire it yet: there is no published release feed (the
derivative is not pushed anywhere), and Windows blocks unsigned updates through SmartScreen anyway.

- **Order:** a code-signing certificate first (`CSC_LINK`/`CSC_KEY_PASSWORD`, see README-WINDOWS), then a
  feed (GitHub Releases or a generic HTTPS folder), then electron-updater as the core's `RemoteUpdater`.
- **Until then** a new version is installed by running the new installer, which closes the running app.
