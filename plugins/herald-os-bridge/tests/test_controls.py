"""system_control's quick-panel actions: Linux parsers, device picking, validation and redaction."""

from __future__ import annotations

import importlib
import json


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


def test_bluetooth_rows_and_device_picking(plugin):
    linux = _mod(plugin, "host.linux")
    rows = linux.parse_bluetoothctl_device_rows("Device AC:80:0A:12:34:56 WH-1000XM5\nDevice 11:22:33:44:55:66\nDevice aa:bb:cc:dd:ee:ff Magic Mouse\n")
    assert rows == [("AC:80:0A:12:34:56", "WH-1000XM5"), ("11:22:33:44:55:66", "11:22:33:44:55:66"), ("AA:BB:CC:DD:EE:FF", "Magic Mouse")]
    assert linux.pick_device(rows, "wh-1000") == ("AC:80:0A:12:34:56", "WH-1000XM5")
    assert linux.pick_device(rows, "magic mouse") == ("AA:BB:CC:DD:EE:FF", "Magic Mouse")
    assert linux.pick_device(rows, "AC:80:0A:12:34:56")[1] == "WH-1000XM5"
    assert linux.pick_device(rows, "keyboard") is None
    assert linux.pick_device([("a", "Left speaker"), ("b", "Right speaker")], "speaker") is None


def test_pactl_and_power_profiles(plugin):
    linux = _mod(plugin, "host.linux")
    sinks = json.dumps([
        {"name": "alsa_output.analog", "description": "Built-in Audio", "mute": False, "volume": {"front-left": {"value_percent": "40%"}, "front-right": {"value_percent": "44%"}}},
        {"name": "alsa_output.analog.monitor", "description": "Monitor", "volume": {}},
        {"name": "bluez_output.AC", "description": "WH-1000XM5", "mute": True, "volume": {"mono": {"value_percent": "70%"}}},
    ])
    assert linux.parse_pactl_json(sinks, "bluez_output.AC\n") == [
        {"id": "alsa_output.analog", "name": "Built-in Audio", "default": False, "volume": 42, "muted": False},
        {"id": "bluez_output.AC", "name": "WH-1000XM5", "default": True, "volume": 70, "muted": True},
    ]
    assert linux.parse_pactl_json("nope", "") == []
    assert linux.parse_power_profiles("  performance:\n    Driver: x\n\n* balanced:\n\n  power-saver:\n") == {"active": "balanced", "profiles": ["performance", "balanced", "power-saver"]}


def test_names_that_look_like_options_are_refused(plugin):
    tools = _mod(plugin, "tools")
    for action, key in (("wifi_connect", "ssid"), ("bluetooth_connect", "device"), ("set_audio_output", "device")):
        result = json.loads(tools.handle_system_control({"action": action, key: "--help"}))
        assert not result["success"] and "must not start with '-'" in result["error"]
    assert not json.loads(tools.handle_system_control({"action": "set_power_profile", "profile": "turbo"}))["success"]
    assert not json.loads(tools.handle_system_control({"action": "set_brightness"}))["success"]


def test_the_audit_log_never_keeps_a_password(plugin, isolated_home):
    audit = _mod(plugin, "audit")
    audit.record(tool="system_control", tier="mutate", action="wifi_connect", args={"ssid": "Home", "password": "hunter22"}, decision="approved", ok=True)
    line = (isolated_home / "jarod-os" / "audit.jsonl").read_text().strip().splitlines()[-1]
    entry = json.loads(line)
    assert entry["args"] == {"ssid": "Home", "password": "[redacted]"}
    assert "hunter22" not in line
