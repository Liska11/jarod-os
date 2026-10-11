# Jarod-OS Alpha 0.1 Implementation Plan

Working copy of the plan that drives Alpha 0.1. `DECISIONS.md` holds the rationale.

## Milestones

1. M0 Scaffold and docs: repository, npm workspaces, upstream sync and lock, client package,
   bootstrap script, architecture and decision records.
2. M1 Hermes end-to-end: backend spawn, WebSocket connect, session create/list/resume, streaming
   transcript, server-request cards, interrupt. Verified against the installed runtime.
3. M2 Shell surfaces: status bar, rail, Home, command bar, Files, Apps, Terminal, System,
   Notifications, Tasks, Skills, Agents, Settings; design system.
4. M3 System bridge plugin: host adapters, tools, permissions, audit, skill; verify the target
   utterances end-to-end.
5. M4 Polish and packaging: fullscreen behaviour, boot/failure screens, performance pass,
   `electron-builder` arm64 DMG, README.

## Target utterances for M3 verification

- "Open Safari."
- "What's using the most CPU?"
- "What's using all my disk space?"
- "Kill the process running on port 3000."
- "Find the screenshots I took yesterday."
- "Open my Jarod project in VS Code." / "Open this repository in my editor."
- "Create a folder for this project."
- "Organize these files." (dry-run plan first, then confirm)
- "Start my development environment."
