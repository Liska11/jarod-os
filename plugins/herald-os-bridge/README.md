# herald-os-bridge

The Hermes plugin that lets Hermes act on the computer and drive the Jarod-OS interface. It is a
regular out-of-tree plugin: Hermes loads it from `$HERMES_HOME/plugins/herald-os-bridge`, a link
`npm run bootstrap` creates to this folder. Nothing in the Hermes core is patched.

Tools, permission tiers, protected paths, the policy file and the audit log are documented in
[docs/SYSTEM-BRIDGE.md](../../docs/SYSTEM-BRIDGE.md).

```
__init__.py          register(): the `herald_os` toolset and the bundled skills (SKILLS)
plugin.yaml          manifest: name, version, tools, supported platforms
bridge/
  tools.py           tool schemas and handlers (TOOL_SPECS)
  permissions.py     tiers, protected paths, the approval gate
  audit.py           one JSON line per call in $HERMES_HOME/jarod-os/audit.jsonl
  crash.py           crash report summaries for system_logs (macOS .ips, Linux core dumps; Windows reads WER events in host/windows.py)
  ui.py              client for the shell's control socket, a Unix socket or loopback TCP on Windows (the `os_ui` tool)
  util.py            shared helpers (data folder, JAROD_OS_* settings)
  host/              HostAdapter per OS: darwin.py, linux.py, posix.py, windows.py (+ winps.py, the PowerShell scripts)
skills/
  herald-os/         when to use these tools
  diagnose-crash/    how to explain a crash from its report
  herald-os-tailor/  how to change Jarod-OS itself: themes, fonts, keybindings, settings
tests/               pytest suite: `npm run test:bridge` from the repository root
```

## Enabling it by hand

`npm run bootstrap` does all of this. Without it:

```bash
ln -s "$PWD/plugins/herald-os-bridge" ~/.hermes/plugins/herald-os-bridge
hermes plugins enable herald-os-bridge
hermes tools enable herald_os
```

To switch the tools off without uninstalling, set `herald_os.bridge.enabled: false` in
`~/.hermes/config.yaml`, or `JAROD_OS_BRIDGE_DISABLED=1` in the backend's environment for one run.
