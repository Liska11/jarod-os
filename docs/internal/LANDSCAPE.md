# Landscape: AI-native operating environments (September 2026)

What else exists, what each does well, and which ideas are worth carrying into Jarod-OS. Kept
short and opinionated; revisit quarterly.

## Projects

| Project | What it is | Maturity | Worth stealing |
| --- | --- | --- | --- |
| [Omarchy](https://omarchy.org) (DHH / Omacom) | Arch + Hyprland + Quickshell Linux distro. Not "AI as interface" but "AI as first-class citizen": every coding agent pre-wired as a lazy launcher, Hermes and OpenClaw installable from a menu, a default-agent picker, agent skills for tailoring the OS itself, crash capture handed to the agent | Shipping, funded, 4.x | Crash-to-agent, whole-system themes that agents can restyle, "the OS is a surface your agent can modify" (plain config files + skills), keyboard-first menu, plugin manifests that land disabled for review |
| [SomaOS](https://github.com/avsribhas-svg/SomaOS) | Bare-metal Rust compositor; human and agent are co-equal desktop users; agent desktop mode with a human-in-the-loop gate | Early, one author | Agent as a visible co-user (you watch it drive the desktop, interrupt any time); dual-interface apps where agent and human share one data model |
| [TensorAgent OS](https://github.com/viralcode/tensoragentos) | Ubuntu-based bootable image, agent is the primary UI, WebMCP Chromium | Preview | WebMCP-enabled browser: tools exposed by web pages the agent is looking at |
| [Naia OS](https://github.com/JaredKarma/naia-os) | Bazzite-based, OpenClaw gateway, 3D avatar, "always alive" background agent | Early | Agent keeps working while you are away, receives messages; presence/persona surfacing |
| [vinOS](https://github.com/vinpatel/vinos) | Arch + Hyprland, Ollama + Claude Code one keystroke away | 1.1 | Opt-in bundles (`ai`, `dev`, `media`) as one-command environments |
| [OpenNeo](https://github.com/akiraenduo/openneo) | macOS "user-owned agent OS": Task Manager per agent (CPU/RAM/network), network domain allowlist, access-request approval queue, tamper-evident audit log, OKR-driven agents | 0.1 | Per-agent resource accounting, network allowlist with approval queue, hash-chained audit, agents with goals and heartbeats |
| [OpenPawz](https://docs.openpawz.ai) | Tauri multi-agent desktop with 25k MCP integrations, 11 chat platforms, keychain secrets | Shipping | Secrets in the OS keychain; agents discover and install integrations on demand |
| [MacAgentOS](https://github.com/zakos95/macagentos) | SwiftUI + FastAPI experimental Mac agent, diagnostics page, "self update lab" | Experimental | Diagnostics surface that shows backend/provider/tool health in one place |
| [Sai](https://github.com/GodlyDonuts/sai) | Voice-first, screenshot-driven macOS control, one verified action at a time | Experimental | Verify-after-each-action loop and cycle detection for GUI automation |
| [AIOS](https://github.com/agiresearch/AIOS) | Academic "agent kernel": scheduling, memory, tool management for agents | Research | Vocabulary for resource scheduling across agents |
| ChatGPT Work (OpenAI) | Desktop app mode that uses local files/apps/browser with permission; cloud continuation | Shipping | Local-or-cloud execution toggle per task; task-shaped (deliverable) framing |
| Siri AI / App Intents (Apple, macOS 27) | System assistant acting inside apps via developer-declared intents | Shipping later 2026 | Structured per-app actions; Jarod-OS can call Shortcuts/App Intents as a bridge target |

Hermes Desktop itself already ships a HUD overlay, pet, Starmap and Command Center; Jarod-OS
deliberately does not copy those (different product), but their existence means the runtime has the
hooks (events, RPCs) to build equivalents when wanted.

## What Jarod-OS already has that most of these lack

- A real, mature agent runtime underneath (memory, skills self-improvement, cron, subagents, 20
  messaging platforms) instead of a bespoke agent.
- Permission tiers + protected paths + audit for every system action, reusing the runtime's own
  approval gate.
- Upstream compatibility: no fork, pinned contract, plugin-only extension.

## Ideas to adopt, ranked

Ranked by value to the "Hermes is the OS" thesis divided by cost, given the current architecture.

1. **Crash and error capture handed to Hermes** (Omarchy). Watch `~/Library/Logs/DiagnosticReports`
   and `log stream` for crashes/faults; raise a notification "X crashed: diagnose?" that opens a
   session pre-loaded with the report and a `diagnose-crash` skill. Small: a main-process watcher +
   one skill + `system_logs`.
2. **Whole-environment themes driven by Hermes skins** (Omarchy). The runtime already sends a
   `skin` payload on `gateway.ready`; map its colour tokens onto our CSS tokens so `/skin` in chat
   restyles the entire environment, and ship a `herald-os-theme` skill so the agent can author
   themes. Small to medium.
3. **Agent Task Manager** (OpenNeo). Extend the Agents surface with per-session CPU/memory of the
   backend and subagent workers, tokens used, approvals granted, and a "stop" control; surface the
   audit trail inline. Medium: we already have the events and the audit file.
4. **Network allowlist and approval queue** (OpenNeo). Hermes has command allowlists; add a domain
   allowlist for `web_*`/browser tools with a "first contact" approval card, and show egress per
   session. Medium; needs an upstream hook or a `pre_tool_call` plugin rule (which exists).
5. **Agent-as-co-user with a live "hands" indicator** (SomaOS). When the agent uses
   `computer_use`/browser tools, show a persistent banner with the current action and a big
   Interrupt button; never let GUI automation run without visible presence. Small UI, high trust.
6. **The OS as an editable surface + tailoring skill** (Omarchy). A `herald-os-tailor` skill that
   teaches the agent how to change Jarod-OS itself: prefs, policy file, surfaces order, accent,
   default cwd, keybindings. Small (docs + skill).
7. **Opt-in environment bundles** (vinOS). `herald os bundle dev` installs a curated set (VS Code,
   Homebrew packages, dotfiles) through the bridge with one approval; ties into "start my
   development environment". Medium.
8. **Local-or-cloud execution per task** (ChatGPT Work). Hermes already supports remote backends
   and cloud sandboxes (Modal, Daytona); expose "run this in the cloud" on a task so long jobs
   survive the laptop sleeping. Medium; mostly UI over existing runtime features.
9. **Shortcuts / App Intents bridge** (Apple). A `system_shortcut` tool that lists and runs the
   user's Shortcuts (`shortcuts run`), giving Hermes structured access to every app that exposes
   intents. Small.
10. **Verify-after-act loop for GUI automation** (Sai). When the bridge drives an app, screenshot
    and check the result before the next step; bounded retries. Belongs upstream in
    `computer_use`; propose there.
11. **Keychain-backed secrets** (OpenPawz). Hermes keeps secrets in `.env`; the shell could offer
    to move them into the macOS Keychain via the runtime's vault hooks. Medium; upstream-facing.
12. **Always-alive presence** (Naia). Jarod-OS already runs the cron ticker; add a menu-bar
    companion so Hermes keeps receiving and acting when the fullscreen shell is closed. Medium.

## Not adopting

- Custom compositors (SomaOS, TensorAgent, Naia, vinOS): out of scope by design until the shell is
  proven on macOS and Windows. Bootable images moved in scope in October 2026 (ADR-018): Fedora bootc
  images, not a compositor of our own.
- 3D avatars, pets, emotion engines: gimmicks by the project's own standard.
- Unsandboxed shell plugins in the renderer process (Omarchy model): our extension model is the
  Hermes plugin system on the backend, which already has a capability/consent layer. Widgets are
  allowed since ADR-019, each in its own sandboxed view behind a narrow message API.
