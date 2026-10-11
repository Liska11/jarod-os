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

    assert out["plugins"]["enabled"] == ["hermes-weather", "herald-os-bridge"]
    assert out["plugins"]["entries"] == {"herald-os-bridge": {"allow_tool_override": False}}
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

    assert once["plugins"]["enabled"] == ["herald-os-bridge"]
    assert once["platform_toolsets"]["cli"] == ["herald_os"]
    assert migrate(once) == once


def test_leaves_unrelated_configs_alone():
    raw = {"model": {"default": "x"}, "plugins": {"enabled": ["other"]}}

    assert _migrate()(raw) == raw
