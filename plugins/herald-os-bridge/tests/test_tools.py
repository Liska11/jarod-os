"""Contracts for the pure parts of the tool layer and the macOS parsers."""

from __future__ import annotations

import importlib
import json
from datetime import date
from pathlib import Path


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


def test_resolve_when_windows(plugin):
    tools = _mod(plugin, "tools")
    today = date(2026, 9, 17)  # a Thursday.
    assert tools.resolve_when("yesterday", today) == ("2026-09-16", "2026-09-16")
    assert tools.resolve_when("today", today) == ("2026-09-17", "2026-09-17")
    assert tools.resolve_when("this_week", today) == ("2026-09-14", "2026-09-17")
    assert tools.resolve_when("this_month", today) == ("2026-09-01", "2026-09-17")
    assert tools.resolve_when(None, today) == (None, None)


def test_plan_operations_normalises_batch_and_rejects_bad_ops(plugin):
    tools = _mod(plugin, "tools")
    ops = tools.plan_operations({"action": "batch", "operations": [
        {"op": "mkdir", "path": "~/Desktop/Sorted"},
        {"op": "move", "path": "~/Desktop/a.png", "to": "~/Desktop/Sorted"},
    ]})
    assert [o.op for o in ops] == ["mkdir", "move"]
    assert ops[0].path == Path.home() / "Desktop" / "Sorted"
    assert ops[1].to == Path.home() / "Desktop" / "Sorted"
    import pytest

    with pytest.raises(ValueError):
        tools.plan_operations({"action": "move", "path": "~/x"})
    with pytest.raises(ValueError):
        tools.plan_operations({"action": "batch", "operations": [{"op": "rm", "path": "~/x"}]})


def test_dry_run_never_touches_disk_or_asks(plugin, tmp_path, monkeypatch):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: (_ for _ in ()).throw(AssertionError("dry run must not prompt")))
    target = tmp_path / "new-folder"
    result = json.loads(tools.handle_system_files({"action": "mkdir", "path": str(target), "dry_run": True}))
    assert result["success"] and result["dry_run"]
    assert result["plan"] == [f"create folder {target}"]
    assert not target.exists()


def test_mkdir_applies_after_approval_and_audits(plugin, tmp_path, monkeypatch, isolated_home):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: perm.Decision(True, "approved"))
    target = tmp_path / "Projects" / "Herald"
    result = json.loads(tools.handle_system_files({"action": "mkdir", "path": str(target)}))
    assert result["success"], result
    assert target.is_dir()
    audit_lines = (isolated_home / "herald-os" / "audit.jsonl").read_text().strip().splitlines()
    entry = json.loads(audit_lines[-1])
    assert entry["tool"] == "system_files" and entry["decision"] == "approved" and entry["ok"] is True


def test_denied_mutation_is_not_applied(plugin, tmp_path, monkeypatch):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: perm.Decision(False, "denied", "no"))
    target = tmp_path / "nope"
    result = json.loads(tools.handle_system_files({"action": "mkdir", "path": str(target)}))
    assert not result["success"] and result["decision"] == "denied"
    assert not target.exists()


def test_kill_refuses_critical_pids(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    critical = tools.host().critical_pids[-1]  # 1 on macOS and Linux, 4 (System) on Windows.
    result = json.loads(tools.handle_system_kill_process({"pid": critical}))
    assert not result["success"] and "critical" in result["error"]


def test_open_rejects_non_web_schemes(plugin):
    tools = _mod(plugin, "tools")
    result = json.loads(tools.handle_system_open({"target": "url", "url": "javascript:alert(1)"}))
    assert not result["success"]


def test_mdfind_query_for_yesterdays_screenshots(plugin):
    darwin = _mod(plugin, "host.darwin")
    base = _mod(plugin, "host.base")
    query = darwin.build_mdfind_query(base.FileSearch(kind="screenshot", since="2026-09-16", until="2026-09-16"))
    assert "kMDItemIsScreenCapture == 1" in query
    assert 'kMDItemContentCreationDate >= $time.iso("2026-09-16T00:00:00")' in query
    assert 'kMDItemContentCreationDate < $time.iso("2026-09-17T00:00:00")' in query


def test_mdfind_query_requires_a_clause(plugin):
    darwin = _mod(plugin, "host.darwin")
    base = _mod(plugin, "host.base")
    import pytest

    with pytest.raises(ValueError):
        darwin.build_mdfind_query(base.FileSearch())


def test_parse_ps_and_lsof(plugin):
    darwin = _mod(plugin, "host.darwin")
    rows = darwin.parse_ps("  512   1 sam  12.5  0.3  204800 /usr/bin/node\n 999 512 sam 0.0 0.0 1024 /bin/zsh -l\n")
    assert rows[0].pid == 512 and rows[0].name == "node" and rows[0].rss_bytes == 204800 * 1024
    assert rows[1].command == "/bin/zsh -l"
    lsof = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 512 sam 23u IPv6 0x1 0t0 TCP *:3000 (LISTEN)\nnode 512 sam 24u IPv4 0x2 0t0 TCP 127.0.0.1:3000 (LISTEN)\n"
    listeners = darwin.parse_lsof(lsof, 3000)
    assert [l.pid for l in listeners] == [512], "one row per pid even with dual-stack sockets"
    assert listeners[0].protocol == "tcp"


def test_parse_network_and_bluetooth_and_volume(plugin):
    darwin = _mod(plugin, "host.darwin")
    ports = darwin.parse_hardware_ports("Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb\n\nHardware Port: Thunderbolt 1\nDevice: en1\nEthernet Address: cc:dd\n")
    assert [p["device"] for p in ports] == ["en0", "en1"] and ports[0]["name"] == "Wi-Fi"
    airport = json.dumps({"SPAirPortDataType": [{"spairport_airport_interfaces": [
        {"_name": "en0", "spairport_status_information": "spairport_status_connected",
         "spairport_current_network_information": {"_name": "<redacted>", "spairport_network_phymode": "802.11ax", "spairport_network_rate": 34}},
        {"_name": "awdl0"}]}]})
    wifi = darwin.parse_airport(airport)
    assert wifi["connected"] is True and wifi["ssid"] is None and wifi["phy_mode"] == "802.11ax"
    bt = darwin.parse_bluetooth(json.dumps({"SPBluetoothDataType": [{"controller_properties": {"controller_state": "attrib_on"}, "device_connected": [{"AirPods": {}}], "device_not_connected": [{"Mouse": {}}]}]}))
    assert bt == {"powered_on": True, "connected": ["AirPods"], "paired": ["Mouse"]}
    assert darwin.parse_volume_settings("output volume:30, input volume:57, alert volume:100, output muted:false") == {"output_volume": 30, "input_volume": 57, "alert_volume": 100, "muted": False}


def test_copy_is_a_mutate_operation_that_does_not_overwrite(plugin, tmp_path, monkeypatch):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: perm.Decision(True, "approved"))
    src = tmp_path / "a.txt"
    src.write_text("hello")
    result = json.loads(tools.handle_system_files({"action": "copy", "path": str(src), "to": str(tmp_path / "b.txt")}))
    assert result["success"] and (tmp_path / "b.txt").read_text() == "hello" and src.exists()
    again = json.loads(tools.handle_system_files({"action": "copy", "path": str(src), "to": str(tmp_path / "b.txt")}))
    assert not again["success"] and "already exists" in again["error"]


def test_settings_pane_lookup_is_forgiving(plugin):
    darwin = _mod(plugin, "host.darwin")
    assert darwin.SETTINGS_PANES["privacy_and_security"].startswith("com.apple.settings.PrivacySecurity")
    assert "screen_recording" in darwin.SETTINGS_PANES


def test_system_control_refuses_empty_notify(plugin):
    tools = _mod(plugin, "tools")
    assert not json.loads(tools.handle_system_control({"action": "notify"}))["success"]
