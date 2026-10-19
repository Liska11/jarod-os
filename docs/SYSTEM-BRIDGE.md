# System Bridge

The system bridge is how Hermes acts on the computer. It is a Hermes plugin
(`plugins/herald-os-bridge`) that registers a small toolset named `herald_os`. Every capability is
an explicit tool with a typed schema, a permission tier, and an audit record. The model never gets
unrestricted machine access.

## Tools

| Tool | Tier | Purpose |
| --- | --- | --- |
| `system_info` | read | OS version, hardware, uptime, CPU load, memory, disks, battery |
| `system_processes` | read | Top processes by CPU or memory, find by name, find by listening port |
| `system_disk_usage` | read | Largest entries under a directory (bounded depth and time) |
| `system_find_files` | read | File search (Spotlight on macOS, `plocate`/`fd` on Linux): name, kind, screenshots, date ranges, scope |
| `system_apps` | read | Installed applications and currently running applications |
| `system_network` | read | Connectivity (interfaces, gateway, DNS, Wi-Fi link) and Bluetooth devices |
| `system_logs` | read | Recent lines from the system log, filtered by level and process; recent crashes and one crash's facts (macOS crash reports, Linux core dumps) for the `diagnose-crash` skill |
| `system_control` | read / act / mutate | Volume, dark mode, notifications, System Settings panes, display sleep, screen lock; switching Wi-Fi asks first. On Jarod-OS Linux also Wi-Fi networks and joining one (asks first), Bluetooth power (asks first) and devices, the sound output, brightness and the power mode |
| `system_open` | act | Open an app, URL, file or folder; reveal in Finder; open a path in an editor |
| `system_kill_process` | destructive | Terminate a process by pid or by listening port |
| `system_files` | mutate / destructive | Create folders, move, rename, trash (never `rm`); `dry_run` plans |
| `os_ui` | per command | Operate the Jarod-OS interface: open pages and apps, add memories, run automations, start missions and Studio builds. Each command carries its own tier |
| `system_os` | act / mutate | Jarod-OS Linux only: install apps and anything in the install catalog (`catalog_list`, `catalog_install`, `catalog_remove`), widget plugins (`plugin_list`, `plugin_add`, `plugin_update`, `plugin_disable`, `plugin_remove`; turning one on is left to the user), reminders, themes, screenshots, lock, suspend, update |

"Start my development environment" is a skill: it composes `system_open` with Hermes's existing
`terminal` tool rather than adding another core-shaped tool.

## Permission tiers

| Tier | Behaviour | Examples |
| --- | --- | --- |
| `read` | Runs immediately, audited | info, processes, disk usage, search |
| `act` | Runs immediately, audited, surfaced as a notification | open Safari, open a repo in VS Code |
| `mutate` | Requires confirmation; `session` and `always` are honoured | mkdir, move, rename |
| `destructive` | Always requires confirmation; per-call rule key so `always` cannot persist | kill process, trash files |

Confirmation goes through upstream's `tools.approval.request_tool_approval`, which the shell
renders as its approval card. `approvals.mode: off` and yolo mode are honoured exactly as they are
for shell commands, because it is the same gate.

## Enabling

`scripts/bootstrap.sh` links the plugin into `$HERMES_HOME/plugins/herald-os-bridge`, then runs
`hermes plugins enable herald-os-bridge`, `hermes tools enable herald_os` (a saved platform toolset
list is authoritative upstream), and `hermes config set tools.tool_search.enabled off` so the tools
are directly callable rather than deferred behind Hermes's tool-search bridge (see
`DECISIONS.md`, ADR-010). Settings -> Privacy edits the policy file below and shows the audit log.

## Protected paths

Operations that would read or modify these locations are refused before any approval prompt:

- secrets: `~/.ssh`, `~/.gnupg`, `~/Library/Keychains`, `~/Library/Cookies`, `$HERMES_HOME/.env`,
  `$HERMES_HOME/auth.json`;
- system folders: `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc`, `/private/etc`,
  `/var/db`, `/private/var/db`, and on Linux `/boot`, `/lib`, `/lib64`, `/var/lib`, `/proc`, `/sys`.

The list is extended (never shortened) in the policy file. The built-in list is
`BUILTIN_PROTECTED` in `bridge/permissions.py`.

## Policy file

`$HERMES_HOME/jarod-os/permissions.yaml`

```yaml
version: 1
tiers:
  read: allow          # allow | confirm | deny
  act: allow
  mutate: confirm
  destructive: confirm # cannot be set to allow
protected_paths:
  - ~/Documents/Taxes
```

## Audit log

Every tool invocation appends one JSON line to `$HERMES_HOME/jarod-os/audit.jsonl`:
`{ts, tool, tier, action, args, decision, ok, error}`. Arguments are truncated; no file contents are
logged.

## Platform abstraction

`bridge/host/base.py` defines `HostAdapter`. `darwin.py` implements it with `mdfind`, `open`,
`lsof`, `ps`, `osascript`, `system_profiler`, `vm_stat`; `linux.py` with `ps`, `ss`,
`plocate`/`fd`, `gio`, `xdg-open`, `nmcli`, `bluetoothctl`, `wpctl`, `gsettings` and `journalctl`
(shared POSIX parts live in `posix.py`). `windows.py` implements it with Windows PowerShell 5.1
(`Get-CimInstance`, `Get-NetTCPConnection`, `Get-StartApps`, `Get-WinEvent`, the Recycle Bin through
`Microsoft.VisualBasic`), the shell (`os.startfile`, `explorer.exe`, `ms-settings:`) and ripgrep for
file search; its scripts are in `winps.py` and receive their arguments as JSON in an environment
variable, never inside the script text. Pure parsers sit next to each adapter and are tested with
fixture data on every platform. Things Windows cannot do without administrator rights (switching the
Wi-Fi radio) raise `HostNotSupported` with the way around. The adapters exist so the tool layer never
branches on `sys.platform`; the file-search predicates both Linux and Windows use are in `search.py`.

On Windows the protected locations are `~/.ssh`, `~/.gnupg`, the Credential Manager / DPAPI / Vault
stores under `%APPDATA%` and `%LOCALAPPDATA%`, `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`
and `%ProgramData%`, besides Hermes's own `.env` and `auth.json`. Opening a program or script with the
default action is refused (it would run it); the kill tool refuses `System`, `lsass`, `csrss`,
`svchost` and the other processes whose death takes the session down. The shell's control channel is a
loopback TCP port (`tcp://127.0.0.1:<port>` in `JAROD_OS_CONTROL_SOCKET`), authenticated by the
per-launch token like the Unix socket elsewhere.

## Tests

`npm run test:bridge` runs the plugin's pytest suite (`plugins/herald-os-bridge/tests`) with the
Hermes runtime's interpreter, or in a throwaway `uv` environment if that interpreter has no pytest.
