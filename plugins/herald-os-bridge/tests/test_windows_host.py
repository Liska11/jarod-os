"""The Windows adapter: parsers on fixture data, actions with PowerShell and the shell mocked.

Nothing here needs Windows except the one test marked ``windows_only``; ``winps.ps_json`` is replaced
by canned output, so the suite also runs on macOS and Linux."""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import time
from pathlib import Path

import pytest

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="needs Windows PowerShell")


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


@pytest.fixture
def win(plugin):
    return _mod(plugin, "host.windows")


@pytest.fixture
def winps(plugin):
    return _mod(plugin, "host.winps")


@pytest.fixture
def base(plugin):
    return _mod(plugin, "host.base")


@pytest.fixture
def scripted(monkeypatch, winps):
    """Replace ``ps_json`` with a recorder answering from ``answers`` (script constant -> value or exception)."""
    calls: list[tuple[str, dict | None]] = []
    answers: dict[str, object] = {}

    def fake(script, args=None, *, timeout=20.0):
        name = next((k for k in dir(winps) if k.isupper() and getattr(winps, k) == script), "?")
        calls.append((name, args))
        answer = answers.get(name)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(winps, "ps_json", fake)
    return calls, answers


# --- the runner -----------------------------------------------------------------------------

def test_scripts_are_encoded_utf16_and_arguments_never_enter_the_source(winps):
    argv = winps.build_argv("'héllo'", r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    assert argv[1:6] == ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]
    decoded = base64.b64decode(argv[-1]).decode("utf-16-le")
    assert "'héllo'" in decoded and "$env:HERALD_OS_ARGS" in decoded and "exit 1" in decoded


def test_every_script_fits_a_command_line(winps):
    for name in dir(winps):
        value = getattr(winps, name)
        if name.isupper() and isinstance(value, str) and "\n" in value:
            assert len(winps.build_argv(value, "powershell.exe")[-1]) < 30000, name


def test_a_failing_script_surfaces_its_stderr_line(monkeypatch, winps):
    monkeypatch.setattr(winps, "powershell_exe", lambda: "powershell.exe")
    util = _mod_of(winps, "ExecResult")
    monkeypatch.setattr(winps, "run", lambda *a, **k: util(1, "", "\nNOTFOUND\nmore"))
    with pytest.raises(winps.PowerShellError, match="^NOTFOUND$"):
        winps.ps_json("x")


def _mod_of(winps, attr):
    import importlib as _il
    return getattr(_il.import_module(winps.__name__.rsplit(".", 2)[0] + ".util"), attr)


def test_json_output_is_parsed_and_empty_output_is_none(monkeypatch, winps):
    monkeypatch.setattr(winps, "powershell_exe", lambda: "powershell.exe")
    result = _mod_of(winps, "ExecResult")
    monkeypatch.setattr(winps, "run", lambda *a, **k: result(0, '\ufeff{"a": 1}\n', ""))
    assert winps.ps_json("x") == {"a": 1}
    monkeypatch.setattr(winps, "run", lambda *a, **k: result(0, "  \n", ""))
    assert winps.ps_json("x") is None


def test_as_list_normalises_the_single_object_json_quirk(winps):
    assert winps.as_list({"a": 1}) == [{"a": 1}]
    assert winps.as_list(None) == []
    assert winps.as_list([1, 2]) == [1, 2]


# --- parsers --------------------------------------------------------------------------------

def test_system_info_payload_keeps_the_shared_keys(win):
    info = win.parse_system_info({
        "caption": "Microsoft Windows 11 Pro", "version": "10.0.26100", "build": "26100", "total_kb": 16 * 1024 * 1024, "free_kb": 4 * 1024 * 1024,
        "uptime_seconds": 3600, "chip": "Intel(R)  Core(TM) i7", "logical": 12,
        "disks": [{"mount": "C:\\", "total_bytes": 1000, "free_bytes": 400}, {"mount": "D:\\", "total_bytes": 0, "free_bytes": 0}],
        "battery": {"percent": 80, "status": 6},
    })
    assert info["os"] == "Windows 11 Pro (10.0.26100)" and info["build"] == "26100"
    assert info["memory_total_bytes"] == 16 * 1024**3 and info["memory_used_bytes"] == 12 * 1024**3
    assert info["disks"] == [{"mount": "C:\\", "total_bytes": 1000, "used_bytes": 600, "free_bytes": 400}]
    assert info["battery"] == {"percent": 80, "state": "charging"} and info["load_average"] is None
    assert info["chip"] == "Intel(R) Core(TM) i7" and info["cpu_cores"] == 12 and info["uptime_seconds"] == 3600


def test_process_rows_scale_cpu_to_the_machine_and_name_from_the_path(win):
    data = {"total_memory": 1000, "rows": [
        {"pid": 10, "ppid": 4, "name": "chrome.exe", "path": r"C:\Program Files\Google\Chrome\chrome.exe", "rss": 250, "cpu": 400.0},
        {"pid": 4, "ppid": 0, "name": "System", "path": "", "rss": 10, "cpu": 1.0},
    ]}
    rows = win.build_process_rows(data, 8, {10: "sam"})
    assert rows[0].name == "chrome.exe" and rows[0].cpu_percent == 50.0 and rows[0].mem_percent == 25.0 and rows[0].user == "sam"
    assert rows[1].command == "System" and rows[1].name == "System"
    assert win.build_process_rows({"total_memory": 0, "rows": {"pid": 1, "name": "x", "cpu": 900}}, 1)[0].cpu_percent == 100.0


def test_process_name_splits_windows_paths_and_leaves_posix_alone(base):
    row = lambda command: base.ProcessRow(1, 0, "", 0, 0, 0, command)  # noqa: E731
    assert row(r"C:\Windows\System32\svchost.exe").name == "svchost.exe"
    assert row(r"\\server\share\tool.exe").name == "tool.exe"
    assert row("/usr/bin/python3").name == "python3"
    assert row("a\\b").name == "a\\b"


def test_listeners_accept_one_object_or_many(win):
    one = win.parse_listeners({"pid": 7, "protocol": "tcp", "name": "node.exe", "user": "sam"}, 5180)
    assert [(l.pid, l.command, l.user, l.port, l.protocol) for l in one] == [(7, "node.exe", "sam", 5180, "tcp")]
    assert win.parse_listeners([], 80) == [] and win.parse_listeners(None, 80) == []


def test_start_apps_keep_the_first_entry_per_name(win):
    apps = win.parse_start_apps([
        {"name": "7-Zip", "id": r"C:\Tools\7zFM.exe"}, {"name": "7-zip", "id": r"{GUID}\7-Zip\7zFM.exe"},
        {"name": "Calculator", "id": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"}, {"name": "", "id": "x"},
    ])
    assert [a.name for a in apps] == ["7-Zip", "Calculator"]
    assert apps[1].path == "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" and apps[1].bundle_id.endswith("!App")


def test_running_apps_use_the_product_name_when_there_is_one(win):
    apps = win.parse_running_apps([{"pid": 5, "process": "brave", "description": "Brave Browser", "path": "C:\\b.exe"}, {"pid": 6, "process": "foo", "description": "", "path": ""}])
    assert [(a.name, a.pid, a.running) for a in apps] == [("Brave Browser", 5, True), ("foo", 6, True)]


WLAN_FR = """
Il y a 1 interface sur le système :

    Nom                    : Wi-Fi
    Description            : Intel(R) Wi-Fi 6
    État                   : connecté
    SSID                   : MaBox
    BSSID                  : aa:bb:cc:dd:ee:ff
    Type de réseau         : Infrastructure
    Type de radio          : 802.11ax
    Authentification       : WPA2-Personnel
    Canal                  : 36
    Vitesse de réception (Mbits/s)  : 866.7
    Signal                 : 91%
"""


def test_wlan_is_read_in_french_and_english_and_absent_without_a_radio(win):
    wifi = win.parse_wlan(WLAN_FR)
    assert wifi["ssid"] == "MaBox" and wifi["signal_percent"] == 91 and wifi["channel"] == 36 and wifi["rate_mbps"] == 866.7
    assert wifi["interface"] == "Wi-Fi" and wifi["phy_mode"] == "802.11ax" and wifi["security"] == "WPA2-Personnel"
    english = win.parse_wlan("    Name : Wi-Fi\n    SSID : Home\n    Radio type : 802.11ac\n    Channel : 6\n    Signal : 70%\n")
    assert english["ssid"] == "Home" and english["channel"] == 6
    assert win.parse_wlan("Il n’existe aucune interface sans fil sur le système.") is None


def test_network_picks_the_default_route_and_hides_link_local_interfaces(win):
    status = win.parse_network({
        "config": [
            {"name": "Ethernet", "description": "Intel I219", "ipv4": "192.168.1.42", "gateway": "192.168.1.254", "dns": ["1.1.1.1", "1.0.0.1"]},
            {"name": "VPN", "description": "Tunnel", "ipv4": "100.1.2.3", "gateway": "", "dns": []},
            {"name": "Bad", "description": "x", "ipv4": "169.254.3.4", "gateway": "", "dns": []},
        ],
        "adapters": [{"name": "Ethernet", "mac": "AA-BB-CC-DD-EE-FF", "status": "Up"}], "wlan": "",
    })
    assert status["online"] and status["default_interface"] == "Ethernet" and status["gateway"] == "192.168.1.254" and status["dns"] == ["1.1.1.1", "1.0.0.1"]
    assert [(i["device"], i["default_route"]) for i in status["interfaces"]] == [("Ethernet", True), ("VPN", False)]
    assert status["interfaces"][0]["mac"] == "AA-BB-CC-DD-EE-FF" and status["wifi"] is None
    assert not win.parse_network({"config": [], "adapters": [], "wlan": ""})["online"]


def test_bluetooth_lists_paired_devices_and_reads_the_radio(win):
    state = win.parse_bluetooth([
        {"name": "Intel(R) Wireless Bluetooth(R)", "id": "USB\\VID_8087&PID_0033\\5&1", "status": "OK", "present": True},
        {"name": "WH-1000XM5", "id": "BTHENUM\\DEV_AABBCCDDEEFF\\7&2", "status": "OK", "present": True},
        {"name": "Bluetooth Device (RFCOMM)", "id": "BTHENUM\\{0000}_LOCALMFG&0000\\7", "status": "OK", "present": True},
    ])
    assert state["powered_on"] is True and state["paired"] == ["WH-1000XM5"] and state["connected"] == [] and "connected" in state["note"]
    assert win.parse_bluetooth([]) == {"powered_on": None, "connected": [], "paired": [], "note": None}


def test_appearance_and_audio_payloads(win):
    appearance = win.parse_appearance({"apps_light": 0, "screens": {"name": "\\\\.\\DISPLAY1", "width": 3840, "height": 2160, "primary": True}})
    assert appearance == {"dark_mode": True, "displays": [{"name": "\\\\.\\DISPLAY1", "resolution": "3840x2160", "main": True, "connection": None}]}
    assert win.parse_appearance({"apps_light": 1, "screens": []})["dark_mode"] is False
    assert win.parse_audio({"output": "40|1", "input": "58|0"}) == {"output_volume": 40, "input_volume": 58, "alert_volume": None, "muted": True}
    assert win.parse_audio({"output": "", "input": ""})["output_volume"] is None


def test_log_lines_are_chronological_and_capped(win):
    rows = [
        {"time": "2026-10-11 10:02:00", "level": 2, "provider": "Disk", "message": "newest"},
        {"time": "2026-10-11 10:01:00", "level": 1, "provider": "Kernel", "message": "middle"},
        {"time": "2026-10-11 10:00:00", "level": 4, "provider": "App", "message": ""},
    ]
    assert win.format_log_lines(rows, 2) == ["2026-10-11 10:01:00 CRITICAL Kernel: middle", "2026-10-11 10:02:00 ERROR Disk: newest"]


def test_crash_summary_names_the_exception(win):
    summary = win.summarise_crash({"record": 27126, "app": "app.exe", "code": "c0000005", "module": "ntdll.dll", "offset": "0001", "pid": "34608", "message": "x"})
    assert summary["exception"] == {"code": "0xc0000005", "meaning": win.EXCEPTION_NAMES["0xc0000005"]}
    assert summary["process_id"] == 34608 and summary["faulting_module"] == "ntdll.dll" and summary["report"] == "27126"
    assert win.normalise_exception_code("80000003") == "0x80000003" and win.normalise_exception_code("0XC0000409".lower()) == "0xc0000409"
    assert win.normalise_exception_code("") is None


def test_settings_panes_resolve_by_name_or_fragment(win):
    assert win.resolve_pane("Wi-Fi") == "network-wifi" and win.resolve_pane("software update") == "windowsupdate"
    assert win.resolve_pane("bluetooth") == "bluetooth"
    with pytest.raises(ValueError, match="unknown settings pane"):
        win.resolve_pane("nonsense")


# --- file search and disk usage (real files, no PowerShell) ----------------------------------

def test_windows_snipping_tool_names_count_as_screenshots(plugin, base):
    search = _mod(plugin, "host.search")
    shots = base.FileSearch(kind="screenshot")
    for name in ("Capture d’écran 2026-10-10 143012.png", "Screenshot 2026-10-10 143012.png", "Snip 3.png"):
        assert search.matches_search("C:/Users/sam/Pictures/Screenshots/" + name, shots, is_dir=False, mtime=None), name
    assert not search.matches_search("C:/Users/sam/Pictures/holiday.png", shots, is_dir=False, mtime=None)


def test_rg_arguments_prefer_extensions_over_the_name_and_escape_globs(win, base):
    by_name = win.rg_arguments(base.FileSearch(name="a[1]*"), ["C:\\u"], skip_appdata=True)
    assert "*a[[]1[]][*]*" in by_name and "!**/AppData/**" in by_name and by_name[-2:] == ["--", "C:\\u"]
    by_ext = win.rg_arguments(base.FileSearch(kind="pdf", name="tax"), ["C:\\u"], skip_appdata=False)
    assert "*.pdf" in by_ext and not any("tax" in a for a in by_ext) and "!**/AppData/**" not in by_ext
    assert "node_modules" in " ".join(by_ext)


def test_walk_skips_noise_folders_and_stops_at_the_deadline(win, tmp_path):
    (tmp_path / "keep").mkdir()
    (tmp_path / "keep" / "a.txt").write_text("x")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "b.txt").write_text("x")
    (tmp_path / "AppData").mkdir()
    (tmp_path / "AppData" / "c.txt").write_text("x")
    seen = {os.path.relpath(p, tmp_path) for p, _ in win.walk_entries([str(tmp_path)], deadline=time.monotonic() + 10, skip_appdata=True)}
    assert os.path.join("keep", "a.txt") in seen and os.path.join("node_modules", "b.txt") not in seen and os.path.join("AppData", "c.txt") not in seen
    assert list(win.walk_entries([str(tmp_path)], deadline=time.monotonic() - 1, skip_appdata=True)) == []


def test_measure_tree_sums_folders_to_the_requested_depth(win, tmp_path):
    root = tmp_path / "root"
    (root / "a" / "deep").mkdir(parents=True)
    (root / "a" / "one.bin").write_bytes(b"x" * 100)
    (root / "a" / "deep" / "two.bin").write_bytes(b"x" * 50)
    (root / "b").mkdir()
    (root / "b" / "three.bin").write_bytes(b"x" * 10)
    total, sizes, timed_out, errors = win.measure_tree(root, 1, deadline=time.monotonic() + 10)
    assert total == 160 and not timed_out and not errors
    assert sizes == {str(root / "a"): 150, str(root / "b"): 10}


def test_disk_usage_reports_the_shared_shape(win, tmp_path):
    root = tmp_path / "root"
    (root / "big").mkdir(parents=True)
    (root / "big" / "f").write_bytes(b"x" * 500)
    (root / "small").mkdir()
    (root / "small" / "f").write_bytes(b"x" * 5)
    report = win.WindowsHost().disk_usage(root, 1, 5, 10.0)
    assert report["total_bytes"] == 505 and report["timed_out"] is False
    assert [e["bytes"] for e in report["entries"]] == [500, 5] and report["entries"][0]["path"].endswith("big")


def test_find_files_filters_ripgrep_output_and_sorts_newest_first(win, base, tmp_path, monkeypatch):
    shots = tmp_path / "Pictures"
    shots.mkdir()
    old, new, other = shots / "Screenshot 1.png", shots / "Screenshot 2.png", shots / "holiday.png"
    for index, file in enumerate((old, new, other)):
        file.write_bytes(b"x")
        os.utime(file, (1_700_000_000 + index * 100, 1_700_000_000 + index * 100))
    host = win.WindowsHost()
    monkeypatch.setattr(host, "_ripgrep", lambda: "rg")
    ran: list[list[str]] = []

    def fake_run(argv, **kwargs):
        ran.append(list(argv))
        return _mod_of(win, "ExecResult")(0, "\n".join(str(p) for p in (old, new, other)) + "\n", "")

    monkeypatch.setattr(win, "run", fake_run)
    found = host.find_files(base.FileSearch(kind="screenshot", scope=str(shots), limit=10))
    assert [Path(f.path).name for f in found] == ["Screenshot 2.png", "Screenshot 1.png"]
    assert ran[0][0] == "rg" and "--files" in ran[0] and "*.png" in ran[0]
    assert found[0].kind == "file" and found[0].size == 1
    with pytest.raises(ValueError, match="at least one of"):
        host.find_files(base.FileSearch())
    with pytest.raises(ValueError, match="invalid date"):
        host.find_files(base.FileSearch(name="x", since="yesterday"))


def test_find_files_adds_content_hits_for_text(win, base, tmp_path, monkeypatch):
    notes = tmp_path / "notes"
    notes.mkdir()
    named, inside = notes / "budget plan.txt", notes / "meeting.txt"
    named.write_text("a")
    inside.write_text("the budget is approved")
    host = win.WindowsHost()
    monkeypatch.setattr(host, "_ripgrep", lambda: "rg")

    def fake_run(argv, **kwargs):
        listing = "--files-with-matches" not in argv
        return _mod_of(win, "ExecResult")(0, "\n".join(str(p) for p in ((named, inside) if listing else (inside,))) + "\n", "")

    monkeypatch.setattr(win, "run", fake_run)
    found = host.find_files(base.FileSearch(text="budget", scope=str(notes)))
    assert {Path(f.path).name for f in found} == {"budget plan.txt", "meeting.txt"}


def test_ripgrep_shipped_with_hermes_is_found(win, isolated_home, monkeypatch):
    rg = isolated_home / "tools" / "ripgrep-15.2.0-win32-x64" / "rg.exe"
    rg.parent.mkdir(parents=True)
    rg.write_bytes(b"")
    monkeypatch.setattr(win.shutil, "which", lambda name: None)
    assert win.WindowsHost._ripgrep() == str(rg)
    rg.unlink()
    assert win.WindowsHost._ripgrep() is None


def test_folder_search_walks_instead_of_listing_files(win, base, tmp_path, monkeypatch):
    (tmp_path / "Projects" / "herald").mkdir(parents=True)
    host = win.WindowsHost()
    monkeypatch.setattr(host, "_ripgrep", lambda: "rg")
    monkeypatch.setattr(win, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("folders are not listed by ripgrep")))
    found = host.find_files(base.FileSearch(kind="folder", name="herald", scope=str(tmp_path)))
    assert [Path(f.path).name for f in found] == ["herald"] and found[0].kind == "folder"


# --- actions with PowerShell mocked ----------------------------------------------------------

def test_system_info_adds_the_python_side_facts(win, scripted, monkeypatch):
    calls, answers = scripted
    answers["SYSTEM_INFO"] = {"caption": "Windows 11", "version": "10.0.1", "build": "1", "total_kb": 1024, "free_kb": 512, "logical": 4, "disks": [], "battery": None}
    monkeypatch.setenv("USERNAME", "sam")
    info = win.WindowsHost().system_info()
    assert info["user"] == "sam" and info["hostname"] and info["arch"] and info["home"] and info["memory_total_bytes"] == 1024 * 1024
    assert set(info) >= {"os", "build", "hostname", "arch", "chip", "cpu_cores", "memory_total_bytes", "memory_used_bytes", "load_average", "uptime_seconds", "disks", "battery", "user", "home"}


def test_process_listing_samples_cpu_only_when_it_sorts_by_cpu(win, scripted):
    calls, answers = scripted
    answers["PROCESSES"] = {"total_memory": 100, "rows": [
        {"pid": 1, "ppid": 0, "name": "a.exe", "path": "", "rss": 10, "cpu": 5.0}, {"pid": 2, "ppid": 0, "name": "b.exe", "path": "", "rss": 90, "cpu": 1.0}]}
    answers["OWNERS"] = [{"pid": 2, "user": "sam"}, {"pid": 1, "user": ""}]
    host = win.WindowsHost()
    by_memory = host.list_processes("memory", 1)
    assert [(r.pid, r.user) for r in by_memory] == [(2, "sam")] and calls[0] == ("PROCESSES", {"sample": False})
    calls.clear()
    assert [r.pid for r in host.list_processes("cpu", 2)] == [1, 2] and calls[0] == ("PROCESSES", {"sample": True})
    calls.clear()
    assert host.find_processes("B.EXE", 5)[0].pid == 2 and calls[0][1] == {"sample": True}
    calls.clear()
    host.find_processes("", 5000)
    assert calls[0][1] == {"sample": False} and all(name != "OWNERS" for name, _ in calls), "a plain pid lookup needs neither a sample nor owners"


def test_kill_maps_the_script_verdict_to_the_exceptions_the_tool_layer_expects(win, winps, scripted):
    calls, answers = scripted
    host = win.WindowsHost()
    host.kill(1234, True)
    assert calls[-1] == ("STOP_PROCESS", {"pid": 1234, "force": True})
    for word, exc in (("NOTFOUND", ProcessLookupError), ("DENIED", PermissionError), ("NOWINDOW", RuntimeError)):
        answers["STOP_PROCESS"] = winps.PowerShellError(word)
        with pytest.raises(exc):
            host.kill(1234, False)


def test_trash_goes_to_the_recycle_bin_and_reports_what_failed(win, scripted):
    calls, answers = scripted
    host = win.WindowsHost()
    answers["TRASH"] = {"errors": []}
    host.trash([Path(r"C:\Users\sam\a.txt"), Path(r"C:\Users\sam\dir")])
    assert calls[-1] == ("TRASH", {"paths": [r"C:\Users\sam\a.txt", r"C:\Users\sam\dir"]})
    answers["TRASH"] = {"errors": [r"C:\x: not found"]}
    with pytest.raises(RuntimeError, match="Recycle Bin.*not found"):
        host.trash([Path(r"C:\x")])


def test_set_volume_clamps_and_returns_the_new_state(win, scripted):
    calls, answers = scripted
    answers["AUDIO"] = {"output": "100|0", "input": "50|0"}
    state = win.WindowsHost().set_volume(250, False)
    assert calls[-1] == ("AUDIO", {"percent": 100, "muted": False}) and state["output_volume"] == 100
    win.WindowsHost().set_volume(None, True)
    assert calls[-1] == ("AUDIO", {"muted": True})


def test_logs_ask_for_the_event_levels_the_tool_names(win, scripted):
    calls, answers = scripted
    answers["EVENT_LOG"] = [{"time": "2026-10-11 10:00:00", "level": 2, "provider": "P", "message": "m"}]
    host = win.WindowsHost()
    assert host.system_logs(15, "error", "chrome", 50) == ["2026-10-11 10:00:00 ERROR P: m"]
    assert calls[-1][1] == {"minutes": 15, "levels": [1, 2], "process": "chrome", "limit": 50}
    host.system_logs(15, "fault", None, 5)
    assert calls[-1][1]["levels"] == [1]
    host.system_logs(15, "any", None, 5)
    assert calls[-1][1]["levels"] == []


def test_crash_reports_list_and_detail(win, scripted):
    calls, answers = scripted
    answers["CRASHES"] = [{"record": "27126", "time": "2026-10-05T15:27:36", "app": "electron.exe", "module": "electron.exe", "code": "80000003"}]
    host = win.WindowsHost()
    assert host.crash_reports(5) == [{"report": "27126", "app": "electron.exe", "time": "2026-10-05T15:27:36", "module": "electron.exe", "exception_code": "0x80000003"}]
    answers["CRASH"] = {"record": "27126", "app": "electron.exe", "code": "80000003", "pid": "10"}
    assert host.crash_report("27126")["exception"]["code"] == "0x80000003"
    with pytest.raises(ValueError, match="record number"):
        host.crash_report("C:\\x")


def test_quit_app_closes_the_running_app_it_resolves_to(win, winps, scripted):
    calls, answers = scripted
    answers["INSTALLED_APPS"] = [{"name": "Brave", "id": r"C:\Brave\brave.exe"}]
    answers["RUNNING_APPS"] = [{"pid": 11, "process": "brave", "description": "Brave Browser", "path": r"C:\Brave\brave.exe"}, {"pid": 12, "process": "other", "description": "Other", "path": ""}]
    host = win.WindowsHost()
    host.quit_app("Brave", False)
    assert [a for a in calls if a[0] == "STOP_PROCESS"] == [("STOP_PROCESS", {"pid": 11, "force": False})]
    with pytest.raises(RuntimeError, match="is not running"):
        host.quit_app("Notepad", False)
    answers["STOP_PROCESS"] = winps.PowerShellError("NOWINDOW")
    with pytest.raises(RuntimeError, match="no window"):
        host.quit_app("Brave", False)


def test_the_apps_list_is_cached_briefly(win, scripted):
    calls, answers = scripted
    answers["INSTALLED_APPS"] = [{"name": "Calc", "id": "Calc!App"}]
    host = win.WindowsHost()
    host.resolve_app("calc")
    host.resolve_app("calc")
    assert [name for name, _ in calls].count("INSTALLED_APPS") == 1


def test_open_app_launches_through_the_shell_or_by_executable(win, scripted, monkeypatch):
    calls, answers = scripted
    answers["INSTALLED_APPS"] = [{"name": "Calculator", "id": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"}, {"name": "Brave", "id": r"C:\Brave\brave.exe"}]
    started: list = []
    launched: list = []
    monkeypatch.setattr(os, "startfile", lambda target, *a: started.append(target), raising=False)
    host = win.WindowsHost()
    monkeypatch.setattr(host, "_launch", lambda argv: launched.append(list(argv)))
    monkeypatch.setattr(os.path, "isfile", lambda p: p == r"C:\Brave\brave.exe")
    host.open_app("calculator")
    assert started == ["shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"]
    host.open_app("Brave", ["--incognito"])
    assert launched == [[r"C:\Brave\brave.exe", "--incognito"]]
    with pytest.raises(RuntimeError, match="cannot be started with arguments"):
        host.open_app("Calculator", ["x"])
    with pytest.raises(RuntimeError, match="could not find an application"):
        host.open_app("nothing-like-this")


def test_a_bare_name_never_becomes_a_path_or_a_script(win, monkeypatch):
    monkeypatch.setattr(win.shutil, "which", lambda name: r"C:\Windows\notepad.exe" if name == "notepad.exe" else (r"C:\x\evil.bat" if name.endswith(".bat") else None))
    assert win.WindowsHost._command_path("notepad") == r"C:\Windows\notepad.exe"
    for refused in (r"C:\x\evil.exe", "..\\evil", "a/b", "cmd /c calc", "", "evil.bat"):
        assert win.WindowsHost._command_path(refused) is None, refused


def test_default_opening_refuses_programs_and_scripts_but_an_app_may_open_them(win, scripted, monkeypatch):
    calls, answers = scripted
    started: list = []
    monkeypatch.setattr(os, "startfile", lambda target, *a: started.append(target), raising=False)
    host = win.WindowsHost()
    for name in ("setup.exe", "run.BAT", "x.ps1", "link.lnk", "a.vbs"):
        with pytest.raises(RuntimeError, match="would run it"):
            host.open_path(Path("C:/Users/sam") / name)
    host.open_path(Path("C:/Users/sam/notes.txt"))
    assert started == [str(Path("C:/Users/sam/notes.txt"))]
    launched: list = []
    monkeypatch.setattr(host, "_launch", lambda argv: launched.append(list(argv)))
    monkeypatch.setattr(host, "_app_executable", lambda app: r"C:\Windows\notepad.exe")
    host.open_path(Path("C:/Users/sam/x.ps1"), "Notepad")
    assert launched == [[r"C:\Windows\notepad.exe", str(Path("C:/Users/sam/x.ps1"))]]


def test_unsupported_things_say_so(win, base):
    host = win.WindowsHost()
    with pytest.raises(base.HostNotSupported, match="administrator"):
        host.set_wifi_power(True)
    with pytest.raises(base.HostNotSupported):
        host.wifi_networks()
    assert host.platform == "win32" and host.critical_pids == (0, 4) and "lsass.exe" in host.critical_process_names


# --- through the tool layer ------------------------------------------------------------------

def test_kill_by_name_refuses_system_processes(plugin, win, monkeypatch, base):
    tools = _mod(plugin, "tools")
    host = win.WindowsHost()
    monkeypatch.setattr(tools, "host", lambda: host)
    monkeypatch.setattr(host, "find_processes", lambda name, limit: [base.ProcessRow(900, 4, "", 0, 0, 0, r"C:\Windows\System32\svchost.exe")])
    monkeypatch.setattr(tools, "authorize", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must refuse before asking")))
    result = json.loads(tools.handle_system_kill_process({"name": "svchost"}))
    assert not result["success"] and "critical" in result["error"]
    refused_pid = json.loads(tools.handle_system_kill_process({"pid": 4}))
    assert not refused_pid["success"] and "critical" in refused_pid["error"]


def test_find_files_tool_reports_results_through_the_windows_adapter(plugin, win, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    (tmp_path / "report.pdf").write_bytes(b"x")
    host = win.WindowsHost()
    monkeypatch.setattr(host, "_ripgrep", lambda: None)
    monkeypatch.setattr(tools, "host", lambda: host)
    result = json.loads(tools.handle_system_find_files({"name": "report", "scope": str(tmp_path)}))
    assert result["success"] and result["count"] == 1 and result["files"][0]["path"].endswith("report.pdf")


# --- protection and the audit trail ---------------------------------------------------------

def test_windows_protected_locations_are_listed_for_windows_only(plugin):
    perm = _mod(plugin, "permissions")
    assert "%APPDATA%/Microsoft/Credentials" in perm.builtin_protected("win32") and "/usr" not in perm.builtin_protected("win32")
    assert "~/.ssh" in perm.builtin_protected("win32") and "%SystemRoot%" not in perm.builtin_protected("darwin")


@windows_only
def test_credential_stores_and_ssh_keys_are_refused_regardless_of_case(plugin, monkeypatch, tmp_path):
    perm = _mod(plugin, "permissions")
    appdata = tmp_path / "AppData" / "Roaming"
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    policy = perm.parse_policy(None, "win32")
    for target in (appdata / "Microsoft" / "Credentials" / "ABC", Path(str(appdata).upper()) / "MICROSOFT" / "PROTECT" / "key", Path.home() / ".SSH" / "id_ed25519", Path(os.environ["SystemRoot"]) / "System32" / "x.dll"):
        assert perm.protected_root(target, policy) is not None, target
    assert perm.protected_root(tmp_path / "Documents" / "a.txt", policy) is None


def test_the_audit_trail_lives_in_the_hermes_home_in_the_documented_format(plugin, isolated_home):
    audit = _mod(plugin, "audit")
    audit.record(tool="system_kill_process", tier="destructive", action=None, args={"pid": 12, "password": "hunter2"}, decision="approved", ok=True, summary="terminate x")
    line = (isolated_home / "herald-os" / "audit.jsonl").read_text(encoding="utf-8").splitlines()[-1]
    entry = json.loads(line)
    assert list(entry) == ["ts", "tool", "tier", "action", "decision", "ok", "summary", "error", "args"]
    assert entry["args"] == {"pid": 12, "password": "[redacted]"}


def test_hermes_home_defaults_to_local_app_data_on_windows(plugin, monkeypatch, tmp_path):
    util = _mod(plugin, "util")
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setattr(util.sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    assert util.hermes_home() == tmp_path / "Local" / "hermes"


# --- the real thing (Windows only) -----------------------------------------------------------

@windows_only
def test_real_powershell_answers_for_system_info_and_processes(win):
    host = win.WindowsHost()
    assert host.available()
    info = host.system_info()
    assert info["memory_total_bytes"] > 0 and info["cpu_cores"] > 0 and info["disks"] and info["os"].startswith("Windows")
    top = host.list_processes("memory", 3)
    assert 0 < len(top) <= 3 and all(r.pid > 0 and r.rss_bytes > 0 for r in top)
    assert any(r.pid == os.getpid() for r in host.find_processes("", 5000))
