"""Carry the plugin settings of earlier names in the Hermes config over (Hermes OS, then Herald OS, then Jarod-OS). Idempotent.

Run by scripts/bootstrap.sh with the Hermes runtime's own interpreter (it needs ``hermes_cli``):

    python scripts/migrate-hermes-config.py

Renames, wherever they appear in ``$HERMES_HOME/config.yaml``:
  plugin   hermes-os-bridge  -> herald-os-bridge   (plugins.enabled / disabled / entries)
  toolset  hermes_os         -> herald_os          (platform_toolsets, known_plugin_toolsets)
  "always allow" approvals   plugin_rule:hermes_os:*  -> plugin_rule:herald_os:*
  section  hermes_os         -> herald_os
"""

from __future__ import annotations

import copy
import sys
from typing import Any, Callable

OLD_PLUGIN, NEW_PLUGIN = "hermes-os-bridge", "herald-os-bridge"
OLD_TOOLSET, NEW_TOOLSET = "hermes_os", "herald_os"
OLD_RULE, NEW_RULE = "plugin_rule:hermes_os:", "plugin_rule:herald_os:"


def _renamed(values: Any, rename: Callable[[Any], Any]) -> Any:
    """``values`` with each item renamed, keeping order and dropping duplicates."""
    if not isinstance(values, list):
        return values
    out: list[Any] = []
    for value in map(rename, values):
        if value not in out:
            out.append(value)
    return out


def _plugin(value: Any) -> Any:
    return NEW_PLUGIN if value == OLD_PLUGIN else value


def _toolset(value: Any) -> Any:
    return NEW_TOOLSET if value == OLD_TOOLSET else value


def _rule(value: Any) -> Any:
    return NEW_RULE + value[len(OLD_RULE):] if isinstance(value, str) and value.startswith(OLD_RULE) else value


def migrate(config: dict[str, Any]) -> dict[str, Any]:
    """Pure: the migrated copy of a raw config mapping."""
    config = copy.deepcopy(config)

    plugins = config.get("plugins")
    if isinstance(plugins, dict):
        for key in ("enabled", "disabled"):
            if key in plugins:
                plugins[key] = _renamed(plugins[key], _plugin)
        entries = plugins.get("entries")
        if isinstance(entries, dict) and OLD_PLUGIN in entries:
            legacy = entries.pop(OLD_PLUGIN)
            entries.setdefault(NEW_PLUGIN, legacy)

    for section in ("platform_toolsets", "known_plugin_toolsets"):
        platforms = config.get(section)
        if isinstance(platforms, dict):
            for platform, toolsets in list(platforms.items()):
                platforms[platform] = _renamed(toolsets, _toolset)

    if "command_allowlist" in config:
        config["command_allowlist"] = _renamed(config["command_allowlist"], _rule)

    if OLD_TOOLSET in config:
        legacy = config.pop(OLD_TOOLSET)
        config.setdefault(NEW_TOOLSET, legacy)

    _add_jarod_os_plugin_name(config)
    return config


#: Jarod-OS rename, phase 5 (docs/RENAME-PLAN-JAROD-OS.md): the plugin's name. ADDED beside the older one, never in its place, so an
#: earlier version still finds the plugin it knows (Hermes ignores an enabled name it cannot find). The toolset keeps its id,
#: ``herald_os``: Linux setup enables it by that name and saved "always allow" rules (``plugin_rule:herald_os:*``) are keyed by it.
JAROD_PLUGIN = "jarod-os-bridge"


def _add_jarod_os_plugin_name(config: dict[str, Any]) -> None:
    plugins = config.get("plugins")
    if not isinstance(plugins, dict):
        return
    for key in ("enabled", "disabled"):
        names = plugins.get(key)
        if isinstance(names, list) and NEW_PLUGIN in names and JAROD_PLUGIN not in names:
            names.insert(names.index(NEW_PLUGIN) + 1, JAROD_PLUGIN)
    entries = plugins.get("entries")
    if isinstance(entries, dict) and NEW_PLUGIN in entries:
        entries.setdefault(JAROD_PLUGIN, copy.deepcopy(entries[NEW_PLUGIN]))


def main() -> int:
    try:
        from hermes_cli.config import read_raw_config, save_config
    except Exception as exc:  # noqa: BLE001 - not the Hermes interpreter.
        print(f"    config migration skipped: hermes_cli is not importable ({exc})", file=sys.stderr)
        return 0
    raw = read_raw_config() or {}
    migrated = migrate(raw)
    if migrated == raw:
        print("    Hermes config: nothing to migrate")
        return 0
    save_config(migrated)
    print("    Hermes config: moved Hermes OS plugin, toolset and approvals to Herald OS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
