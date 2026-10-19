"""scripts/migrate-hermes-config.py: pre-rename Hermes OS settings carry over to Jarod-OS."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "migrate-hermes-config.py"


def _migrate():
    spec = importlib.util.spec_from_file_location("migrate_hermes_config", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.migrate


def test_renames_plugin_toolsets_rules_and_section():
    raw = {
        "plugins": {
            "enabled": ["hermes-weather", "hermes-os-bridge"],
            "entries": {"hermes-os-bridge": {"allow_tool_override": False}},
        },
        "platform_toolsets": {"cli": ["file", "hermes_os", "web"]},
        "known_plugin_toolsets": {"cli": ["a2a", "hermes_os"]},
        "command_allowlist": ["plugin_rule:hermes_os:os_ui:mission.start", "recursive delete"],
        "hermes_os": {"bridge": {"enabled": False}},
    }

    out = _migrate()(raw)

    # Then the Jarod-OS name is ADDED beside it (phase 5): an earlier version still finds the plugin it knows.
    assert out["plugins"]["enabled"] == ["hermes-weather", "herald-os-bridge", "jarod-os-bridge"]
    assert out["plugins"]["entries"] == {"herald-os-bridge": {"allow_tool_override": False}, "jarod-os-bridge": {"allow_tool_override": False}}
    assert out["platform_toolsets"]["cli"] == ["file", "herald_os", "web"]
    assert out["known_plugin_toolsets"]["cli"] == ["a2a", "herald_os"]
    assert out["command_allowlist"] == ["plugin_rule:herald_os:os_ui:mission.start", "recursive delete"]
    assert out["herald_os"] == {"bridge": {"enabled": False}}
    assert "hermes_os" not in out
    assert raw["plugins"]["enabled"][1] == "hermes-os-bridge", "the input is not mutated"


def test_dedupes_when_both_names_are_present_and_is_idempotent():
    migrate = _migrate()
    raw = {"plugins": {"enabled": ["hermes-os-bridge", "herald-os-bridge"]}, "platform_toolsets": {"cli": ["herald_os", "hermes_os"]}}

    once = migrate(raw)

    assert once["plugins"]["enabled"] == ["herald-os-bridge", "jarod-os-bridge"]
    assert once["platform_toolsets"]["cli"] == ["herald_os"]
    assert migrate(once) == once


def test_leaves_unrelated_configs_alone():
    raw = {"model": {"default": "x"}, "plugins": {"enabled": ["other"]}}

    assert _migrate()(raw) == raw


def test_adds_the_jarod_os_plugin_name_beside_the_older_one_and_keeps_the_toolset():
    """Jarod-OS rename, phase 5: the plugin is jarod-os-bridge; the older name stays listed (additive, for a rollback). The toolset
    keeps its id, herald_os: Linux setup enables it by that name and saved "always allow" rules are keyed by it."""
    raw = {
        "plugins": {"enabled": ["web", "herald-os-bridge"], "disabled": ["herald-os-bridge"], "entries": {"herald-os-bridge": {"allow_tool_override": True}}},
        "platform_toolsets": {"cli": ["herald_os"]},
        "command_allowlist": ["plugin_rule:herald_os:os_ui:mission.start"],
    }

    out = _migrate()(raw)

    assert out["plugins"]["enabled"] == ["web", "herald-os-bridge", "jarod-os-bridge"]
    assert out["plugins"]["disabled"] == ["herald-os-bridge", "jarod-os-bridge"], "a plugin the person turned off stays off"
    assert out["plugins"]["entries"] == {"herald-os-bridge": {"allow_tool_override": True}, "jarod-os-bridge": {"allow_tool_override": True}}
    assert out["platform_toolsets"] == {"cli": ["herald_os"]}
    assert out["command_allowlist"] == ["plugin_rule:herald_os:os_ui:mission.start"]


def test_the_jarod_os_step_is_idempotent_and_never_overwrites_entries_set_for_the_new_name():
    migrate = _migrate()
    raw = {"plugins": {"enabled": ["herald-os-bridge", "jarod-os-bridge"], "entries": {"herald-os-bridge": {"a": 1}, "jarod-os-bridge": {"a": 2}}}}

    once = migrate(raw)

    assert once["plugins"]["enabled"] == ["herald-os-bridge", "jarod-os-bridge"]
    assert once["plugins"]["entries"]["jarod-os-bridge"] == {"a": 2}
    assert migrate(once) == once
