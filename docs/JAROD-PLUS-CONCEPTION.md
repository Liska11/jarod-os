# The eight changes: design and decisions (2026-10-18)

This note follows `docs/AUDIT-GLOBAL.md` and the request `prompt/Prompt-Jarod_os-plus.txt`. Each change has its own document; this one gives the decisions, the components reused, and how the changes depend on each other.

## Order followed (by dependency)

1. **UI base** (audit A-02 to A-05), with **5 (model picker)** and **6 (navigation)**. These touch the same screens and need no new external access.
2. **8, Internet switch**: before any new external access.
3. **1, external backup**: built on the core's maintenance mode. It removes the vault's values from its copies, which is part of what 4 asks for.
4. **4, secrets**: consolidates the core's existing vault. No second vault.
5. **2, Tailscale / SSH**: after 8 (the remote-machines exception) and after 4.
6. **3, updates**: after 8 (no check while the Internet is off).
7. **7, duplex voice**: after auditing the existing voice components. Barge-in, VAD, echo cancellation and turn invalidation were already there.

## Components reused, never duplicated

| Need | Existing component | Added |
|---|---|---|
| Stop and restart the engine | `BackendManager.stop/start` | Restart only if the engine was running (`isCoreRunning`) |
| Copy files | `fs.promises`, the hard-link backup pattern | Hashed copy, `.incomplete` folder, read-back check |
| Engine database | `Db`, `rekeyFile`, `VACUUM INTO` | `snapshotWithoutSecrets`, maintenance mode `--db-snapshot` |
| Vault | `VaultService`, `vault-*` channels, native confirmations | Type, temporary entries, revocation, protection status |
| SSH | `SshService` (`StrictHostKeyChecking=yes`), `ssh-hosts-*` | Separate network test, host-key trust with its fingerprint, terminal |
| Terminal | node-pty, `vm` and `environment` options | `ssh` option |
| Updates | Control gate, host catalogue | One confirmed `winget upgrade` (`shell.winget.upgrade`), docs/UPDATES.md |
| Tool gate | `executeGuardedTool` | `toolVerdict` (Internet switch) |
| Voice | `ChainedEngine`, `SpeakStream`, `Endpointer` | `SentenceSpeaker`, duplex / classic mode, measurements |
| Model picker | `ModelPicker` | Moved into the header; offline state |
| Sidebar | `Sidebar`, `$sidebar` | Toggle at the top, scrolling area, floating tooltips |

## How the changes interact

| Change | Interacts with | How |
|---|---|---|
| 8 → 2 | Remote machines | The declared machines feed `remoteHosts`. The exception lets them through, and only them. The SSH terminal, the network test and key reading follow the policy. |
| 8 → 3 | Updates | No check, no `winget upgrade` while the Internet is off. Old results are shown with their date. |
| 8 → 5 | Model picker | Cloud models marked offline, local models first, never switched silently. |
| 8 → 7 | Voice | Cloud speech-to-text and speech are cut by the engine's socket guard. Local speech (SAPI, whisper.cpp) keeps working. |
| 8 → environments, VMs | Programs | `uv --offline`; Node, `wsl --install` and winget are refused. |
| 4 → 1 | Backup | Vault values are left out of the backup. A temporary secret is never on disk. |
| 1 ↔ local backup ↔ restore | Concurrency | A shared lock (`operation-lock.ts`). |

## Contracts and migrations

| Item | Detail |
|---|---|
| `network-policy.json` (shell config, version 1) | Written at the first start. The core gets its path through `JAROD_NETWORK_POLICY`. |
| `external-backup.json` and `instance.json` | Shell config. |
| `updates-check.json` | Shell config. |
| `VaultEntry` | Gains `kind?` and `temporary?`, both optional: no migration. `vault-status` and `vault-revoke` join the channel list. |
| `VoicePrefs.duplex` | Default `true`: the previous behaviour. |
| `TerminalCreateOptions` | Gains `ssh?`. The `winget?` option is gone: an upgrade runs from Système › Mises à jour, through the gate. |
| Sidebar | A stored width equal to the old default (132) moves to the new one (184). A width chosen by hand is kept. |

**No destructive migration.**

## Decisions on reversible choices

| Choice | Decision |
|---|---|
| Missing policy file | Internet on, the earlier behaviour. An invalid file means Internet off. |
| `run_shell` and MCP offline | Refused by default, with a distinct, stated exception: "commandes locales". Jarod cannot cut those programs off the network. |
| Remote execution by the agent | Not built. The SSH terminal belongs to the person. This is said in the UI. |
| Restoring VMs | To a separate folder, never over machines in use. |
| Shell preferences | Only `prefs.json` is backed up and restored. The disk location and the Internet switch are left out: a restore must not turn the Internet back on. |
| Navigation | A single fold control, moved to the top so it is always reachable, rather than a second control for the page group. |
