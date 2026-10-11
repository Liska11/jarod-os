"""Windows host adapter built on what every Windows 10/11 ships: Windows PowerShell 5.1 (``Get-CimInstance``,
``Get-NetTCPConnection``, ``Get-StartApps``, ``Get-WinEvent``, the Recycle Bin through
``Microsoft.VisualBasic``), the shell (``os.startfile``, ``explorer.exe``, ``ms-settings:``) and, for
file search, ripgrep when it is installed.

Every ``parse_*`` / ``build_*`` function is pure and unit-tested with fixture data on any platform; the
methods on ``WindowsHost`` call ``winps`` (PowerShell) or the shell and hand the result to them.
Arguments reach PowerShell as JSON in an environment variable, never inside the script text."""

from __future__ import annotations

import ctypes
import os
import platform
import re
import shutil
import socket
import stat as statmod
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path, PureWindowsPath
from typing import Any, Iterator, Literal, Sequence

from ..util import hermes_home, run
from . import winps
from .base import AppInfo, FileSearch, FoundFile, HostAdapter, HostNotSupported, PortListener, ProcessRow
from .search import matches_search, search_extensions, search_time_bounds

# --- constants ------------------------------------------------------------------------------

# Programs whose death ends the session or the machine; the kill tool refuses them by name and pid.
CRITICAL_PROCESS_NAMES = frozenset({
    "system", "registry", "secure system", "memory compression", "smss.exe", "csrss.exe", "wininit.exe",
    "winlogon.exe", "services.exe", "lsass.exe", "lsaiso.exe", "dwm.exe", "svchost.exe", "fontdrvhost.exe",
})

BATTERY_STATES = {
    1: "discharging", 2: "on AC power", 3: "charged", 4: "low", 5: "critical", 6: "charging",
    7: "charging", 8: "charging", 9: "charging", 11: "partially charged",
}

# What `ms-settings:` opens for the pane names the tool layer shares with macOS.
SETTINGS_PANES: dict[str, str] = {
    "general": "about", "about": "about", "appearance": "personalization-colors", "colors": "personalization-colors",
    "accessibility": "easeofaccess", "display": "display", "displays": "display", "wallpaper": "personalization-background",
    "desktop_and_dock": "taskbar", "taskbar": "taskbar", "screen_saver": "lockscreen", "lock_screen": "lockscreen",
    "battery": "batterysaver", "power": "powersleep", "privacy": "privacy", "privacy_and_security": "privacy",
    "security": "windowsdefender", "microphone": "privacy-microphone", "camera": "privacy-webcam",
    "location": "privacy-location", "screen_recording": "privacy-graphicscaptureprogrammatic",
    "users_and_groups": "yourinfo", "passwords": "signinoptions", "wifi": "network-wifi", "bluetooth": "bluetooth",
    "network": "network", "notifications": "notifications", "sound": "sound", "focus": "quiethours",
    "keyboard": "typing", "mouse": "mousetouchpad", "trackpad": "devices-touchpad", "printers": "printers",
    "software_update": "windowsupdate", "storage": "storagesense", "date_and_time": "dateandtime",
    "login_items": "startupapps", "apps": "appsfeatures", "default_apps": "defaultapps",
}

# Opening these with the system's default action would run them, not show them.
EXECUTABLE_SUFFIXES = frozenset({
    ".exe", ".com", ".scr", ".bat", ".cmd", ".msi", ".msp", ".msc", ".cpl", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
    ".ps1", ".psm1", ".hta", ".reg", ".jar", ".dll", ".lnk", ".url", ".appref-ms", ".application", ".gadget",
})

EXCEPTION_NAMES = {
    "0xc0000005": "access violation (the program touched memory it did not own)",
    "0xc0000409": "stack buffer overrun or fail-fast (the program stopped itself after detecting corruption)",
    "0x80000003": "breakpoint (a deliberate trap or a debugger break)",
    "0xc00000fd": "stack overflow",
    "0xc0000374": "heap corruption",
    "0xc0000094": "integer division by zero",
    "0xc000001d": "illegal instruction",
    "0xe0434352": ".NET unhandled exception",
    "0xe06d7363": "C++ exception that was not caught",
    "0xc0000135": "a required DLL was not found",
    "0xc0000142": "a DLL failed to initialise",
    "0xc000007b": "invalid image format (a 32-bit and 64-bit mix-up)",
    "0xc0000006": "in-page I/O error (a file the program had mapped went away)",
    "0x40000015": "fatal application exit",
}

# Folders that are noise for a search of the person's files.
_SKIP_DIRS = frozenset({"node_modules", ".git", "$recycle.bin", "system volume information", "__pycache__", ".venv", "venv", ".cache"})
_REPARSE_LINK_TAGS = (0xA0000003, 0xA000000C)  # mount point (junction), symbolic link.

LOG_LEVELS: dict[str, list[int]] = {"error": [1, 2], "fault": [1], "any": []}
_LEVEL_NAMES = {1: "CRITICAL", 2: "ERROR", 3: "WARNING", 4: "INFO", 5: "VERBOSE"}


# --- pure parsers ---------------------------------------------------------------------------

def parse_system_info(data: dict[str, Any]) -> dict[str, Any]:
    """The ``SYSTEM_INFO`` script's JSON -> the cross-platform ``system_info`` payload (Python adds the rest)."""
    total = int(data.get("total_kb") or 0) * 1024
    free = int(data.get("free_kb") or 0) * 1024
    disks = []
    for disk in winps.as_list(data.get("disks")):
        size, left = int(disk.get("total_bytes") or 0), int(disk.get("free_bytes") or 0)
        if size > 0:
            disks.append({"mount": disk.get("mount"), "total_bytes": size, "used_bytes": max(0, size - left), "free_bytes": left})
    battery = None
    raw = data.get("battery")
    if isinstance(raw, dict) and raw.get("percent") is not None:
        battery = {"percent": int(raw["percent"]), "state": BATTERY_STATES.get(int(raw.get("status") or 0), "unknown")}
    caption = re.sub(r"^Microsoft\s+", "", str(data.get("caption") or "Windows")).strip()
    version = str(data.get("version") or "")
    return {
        "os": f"{caption} ({version})" if version else caption, "build": str(data.get("build") or ""),
        "chip": re.sub(r"\s+", " ", str(data.get("chip") or "")).strip() or None, "cpu_cores": int(data.get("logical") or 0),
        "memory_total_bytes": total, "memory_used_bytes": max(0, total - free),
        "load_average": None,  # Windows has no load average.
        "uptime_seconds": int(data["uptime_seconds"]) if data.get("uptime_seconds") is not None else None,
        "disks": disks, "battery": battery,
    }


def build_process_rows(data: dict[str, Any], logical_cpus: int, owners: dict[int, str] | None = None) -> list[ProcessRow]:
    """The ``PROCESSES`` script's JSON -> rows. CPU is per-core-summed in the script; it is scaled to 0-100 of the machine."""
    total = int(data.get("total_memory") or 0)
    cores = max(1, logical_cpus)
    rows: list[ProcessRow] = []
    for raw in winps.as_list(data.get("rows")):
        rss = int(raw.get("rss") or 0)
        name = str(raw.get("name") or "")
        path = str(raw.get("path") or "")
        rows.append(ProcessRow(
            pid=int(raw["pid"]), ppid=int(raw.get("ppid") or 0), user=(owners or {}).get(int(raw["pid"]), ""),
            cpu_percent=round(min(100.0, float(raw.get("cpu") or 0.0) / cores), 1),
            mem_percent=round(rss / total * 100, 1) if total else 0.0, rss_bytes=rss, command=path or name,
        ))
    return rows


def parse_listeners(data: Any, port: int) -> list[PortListener]:
    return [
        PortListener(pid=int(row["pid"]), command=str(row.get("name") or ""), user=str(row.get("user") or ""), port=port, protocol=str(row.get("protocol") or "tcp"))
        for row in winps.as_list(data) if row.get("pid") is not None
    ]


def parse_start_apps(data: Any) -> list[AppInfo]:
    """``Get-StartApps`` rows -> apps. One program often has several Start entries (an installer's
    folder-GUID path and the real path); the first of each name is kept. ``bundle_id`` is the AppID that
    ``shell:AppsFolder\\<AppID>`` launches."""
    apps: dict[str, AppInfo] = {}
    for row in winps.as_list(data):
        name, app_id = str(row.get("name") or "").strip(), str(row.get("id") or "").strip()
        if name and app_id:
            apps.setdefault(name.lower(), AppInfo(name=name, path=f"shell:AppsFolder\\{app_id}", bundle_id=app_id))
    return sorted(apps.values(), key=lambda a: a.name.lower())


def parse_running_apps(data: Any) -> list[AppInfo]:
    return [
        AppInfo(name=str(row.get("description") or row.get("process") or "").strip(), path=str(row.get("path") or ""), running=True, pid=int(row["pid"]))
        for row in winps.as_list(data) if row.get("pid") is not None and (row.get("description") or row.get("process"))
    ]


def parse_wlan(text: str) -> dict[str, Any] | None:
    """``netsh wlan show interfaces`` -> the connection summary, or None. The labels are localised, so
    only the ones that read the same everywhere (SSID, Signal) are required."""
    ssid = re.search(r"^\s*SSID\s*:\s*(.+?)\s*$", text, re.MULTILINE)
    if not ssid:
        return None

    def field(*labels: str) -> str | None:
        found = re.search(rf"^\s*(?:{'|'.join(labels)})[^:\n]*:\s*(.+?)\s*$", text, re.MULTILINE | re.IGNORECASE)
        return found[1] if found else None

    # The labels are translated, the order of the lines is not: after "SSID" come BSSID, network type,
    # radio type, authentication, cipher, connection mode, (band,) channel, receive rate, transmit rate,
    # signal. A label this table does not know is read by position instead of being dropped.
    rows = [tuple(part.strip() for part in line.split(":", 1)) for line in text.splitlines() if ":" in line]
    start = next((i for i, (label, _) in enumerate(rows) if label.upper() == "SSID"), len(rows))
    after = rows[start + 1:]
    numbers = [value for _, value in after if re.fullmatch(r"\d+(?:[.,]\d+)?", value)]

    signal = re.search(r"^\s*(?:Signal|Señal)\s*:\s*(\d+)\s*%", text, re.MULTILINE | re.IGNORECASE) or re.search(r":\s*(\d+)\s*%\s*$", text, re.MULTILINE)
    channel = field("Channel", "Canal") or (numbers[0] if numbers else None)
    rate = field("Receive rate", "Vitesse de réception") or (numbers[1] if len(numbers) > 1 else None)
    rate = rate.replace(",", ".") if rate else rate
    return {
        "interface": field("Name", "Nom", "Nombre"), "connected": True, "ssid": ssid[1],
        "phy_mode": field("Radio type", "Type de radio") or (after[2][1] if len(after) > 2 else None),
        "channel": int(channel) if channel and channel.isdigit() else None,
        "rate_mbps": float(rate) if rate and re.fullmatch(r"[\d.]+", rate) else None,
        "signal_percent": int(signal[1]) if signal else None,
        "security": field("Authentication", "Authentification") or (after[3][1] if len(after) > 3 else None),
    }


def parse_network(data: dict[str, Any]) -> dict[str, Any]:
    config = winps.as_list(data.get("config"))
    adapters = {str(a.get("name")): a for a in winps.as_list(data.get("adapters"))}
    default = next((c for c in config if c.get("gateway")), None)
    interfaces = []
    for entry in config:
        ipv4 = str(entry.get("ipv4") or "")
        if not ipv4 or ipv4.startswith("169.254."):
            continue
        name = str(entry.get("name") or "")
        interfaces.append({
            "name": str(entry.get("description") or name), "device": name, "mac": (adapters.get(name) or {}).get("mac") or None,
            "ipv4": ipv4, "default_route": entry is default,
        })
    wifi = parse_wlan(str(data.get("wlan") or ""))
    return {
        "online": default is not None, "default_interface": default.get("name") if default else None,
        "gateway": default.get("gateway") if default else None, "dns": [str(d) for d in winps.as_list(default.get("dns") if default else [])][:6],
        "interfaces": interfaces, "wifi": wifi, "note": None,
    }


def parse_bluetooth(devices: Any) -> dict[str, Any]:
    rows = winps.as_list(devices)
    paired = sorted({str(d["name"]) for d in rows if d.get("name") and re.match(r"^BTH(?:ENUM|LE)\\DEV_", str(d.get("id") or ""), re.IGNORECASE)})
    radios = [d for d in rows if d.get("name") and not re.match(r"^BTH", str(d.get("id") or ""), re.IGNORECASE) and d.get("present")]
    return {
        "powered_on": any(str(r.get("status")) == "OK" for r in radios) if radios else None,
        "connected": [],
        "paired": paired,
        "note": "Windows does not tell which paired device is connected right now." if paired else None,
    }


def parse_appearance(data: dict[str, Any]) -> dict[str, Any]:
    dark = data.get("apps_light")
    displays = [
        {"name": s.get("name"), "resolution": f"{s.get('width')}x{s.get('height')}", "main": bool(s.get("primary")), "connection": None}
        for s in winps.as_list(data.get("screens"))
    ]
    return {"dark_mode": dark == 0 if dark is not None else False, "displays": displays}


def parse_audio(data: dict[str, Any]) -> dict[str, Any]:
    """``"40|0"`` (percent|muted) for the default playback and capture devices -> the shared audio payload."""

    def split(value: Any) -> tuple[int | None, bool | None]:
        match = re.fullmatch(r"(\d+)\|([01])", str(value or ""))
        return (int(match[1]), match[2] == "1") if match else (None, None)

    out_level, out_muted = split(data.get("output"))
    in_level, _ = split(data.get("input"))
    return {"output_volume": out_level, "input_volume": in_level, "alert_volume": None, "muted": out_muted}


def format_log_lines(rows: Any, limit: int) -> list[str]:
    """Newest-first event rows -> chronological ``time LEVEL provider: message`` lines, the last ``limit``."""
    lines = [
        f"{r.get('time')} {_LEVEL_NAMES.get(int(r.get('level') or 4), 'INFO')} {r.get('provider')}: {r.get('message') or ''}".rstrip()
        for r in winps.as_list(rows)
    ]
    lines.reverse()
    return lines[-limit:]


def normalise_exception_code(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    if re.fullmatch(r"(?:0x)?[0-9a-f]+", text):
        return "0x" + text.removeprefix("0x").rjust(8, "0")
    return text


def summarise_crash(row: dict[str, Any]) -> dict[str, Any]:
    code = normalise_exception_code(row.get("code"))
    return {
        "report": str(row.get("record")), "app": row.get("app"), "version": row.get("version"), "time": row.get("time"),
        "exception": {"code": code, "meaning": EXCEPTION_NAMES.get(code or "")},
        "faulting_module": row.get("module"), "module_version": row.get("module_version"), "fault_offset": row.get("offset"),
        "process_id": int(row["pid"]) if str(row.get("pid") or "").isdigit() else None,
        "app_path": row.get("app_path"), "module_path": row.get("module_path"), "message": str(row.get("message") or "")[:4000],
    }


def resolve_pane(pane: str) -> str:
    def squash(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower().replace("&", "and"))

    key = squash(pane)
    panes = {squash(name): value for name, value in SETTINGS_PANES.items()}
    target = panes.get(key) or next((value for name, value in panes.items() if key and key in name), None)
    if target is None:
        raise ValueError(f"unknown settings pane '{pane}'. Known: {', '.join(sorted(SETTINGS_PANES))}")
    return target


def is_executable_path(path: Path) -> bool:
    return path.suffix.lower() in EXECUTABLE_SUFFIXES


def _glob_escape(text: str) -> str:
    return re.sub(r"([\\*?\[\]{}!])", r"[\1]", text)


def rg_arguments(search: FileSearch, roots: Sequence[str], *, skip_appdata: bool) -> list[str]:
    """``rg --files`` arguments narrowing the listing by what a glob can express (extensions, else the name)."""
    argv = ["--files", "--no-messages", "--no-ignore", "--no-config"]
    for noise in sorted(_SKIP_DIRS):
        argv += ["--glob", f"!**/{noise}/**"]
    if skip_appdata:
        argv += ["--glob", "!**/AppData/**"]
    exts = sorted(search_extensions(search))
    if exts:
        for ext in exts:
            argv += ["--iglob", f"*.{_glob_escape(ext)}"]
    elif search.name:
        argv += ["--iglob", f"*{_glob_escape(search.name)}*"]
    return [*argv, "--", *roots]


def rg_content_arguments(text: str, roots: Sequence[str], *, skip_appdata: bool) -> list[str]:
    argv = ["--files-with-matches", "--fixed-strings", "--ignore-case", "--no-messages", "--no-ignore", "--no-config", "--max-filesize", "2M"]
    for noise in sorted(_SKIP_DIRS):
        argv += ["--glob", f"!**/{noise}/**"]
    if skip_appdata:
        argv += ["--glob", "!**/AppData/**"]
    return [*argv, "--regexp", text, "--", *roots]


def _is_link(st: os.stat_result) -> bool:
    return statmod.S_ISLNK(st.st_mode) or getattr(st, "st_reparse_tag", 0) in _REPARSE_LINK_TAGS


def walk_entries(roots: Sequence[str], *, deadline: float, skip_appdata: bool) -> Iterator[tuple[str, bool]]:
    """Every file and folder under ``roots`` as ``(path, is_dir)``: no junction or symlink is followed,
    noise folders are skipped, and the walk stops at ``deadline`` (a ``time.monotonic()`` value)."""
    stack = list(roots)
    while stack and time.monotonic() < deadline:
        directory = stack.pop()
        try:
            iterator = os.scandir(directory)
        except OSError:
            continue
        with iterator:
            for entry in iterator:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    lowered = entry.name.lower()
                    if is_dir:
                        if lowered in _SKIP_DIRS or (skip_appdata and lowered == "appdata") or _is_link(entry.stat(follow_symlinks=False)):
                            continue
                        stack.append(entry.path)
                    yield entry.path, is_dir
                except OSError:
                    continue


def measure_tree(root: Path, depth: int, *, deadline: float) -> tuple[int, dict[str, int], bool, bool]:
    """Sizes by folder down to ``depth`` levels (``du -d`` for Windows): returns ``(total, {folder: bytes},
    timed_out, hit_errors)``. File sizes are logical sizes; links are not followed."""
    sizes: dict[str, int] = {}
    state = {"timed_out": False, "errors": False}

    def visit(directory: str, level: int) -> int:
        total = 0
        try:
            iterator = os.scandir(directory)
        except OSError:
            state["errors"] = True
            return 0
        with iterator:
            for entry in iterator:
                if time.monotonic() > deadline:
                    state["timed_out"] = True
                    break
                try:
                    st = entry.stat(follow_symlinks=False)
                    if _is_link(st):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        total += visit(entry.path, level + 1)
                    else:
                        total += st.st_size
                except OSError:
                    state["errors"] = True
        if 1 <= level <= depth:
            sizes[directory] = total
        return total

    total = visit(str(root), 0)
    return total, sizes, state["timed_out"], state["errors"]


# --- the adapter ----------------------------------------------------------------------------

_DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


class WindowsHost(HostAdapter):
    platform = "win32"
    critical_pids = (0, 4)
    critical_process_names = CRITICAL_PROCESS_NAMES

    def __init__(self) -> None:
        self._apps_cache: tuple[float, list[AppInfo]] | None = None

    def available(self) -> bool:
        return sys.platform == "win32" and winps.powershell_exe() is not None

    # --- read -------------------------------------------------------------------------------
    def system_info(self) -> dict[str, Any]:
        info = parse_system_info(winps.ps_json(winps.SYSTEM_INFO, timeout=30) or {})
        return {
            **info, "hostname": socket.gethostname(), "arch": platform.machine(),
            "user": os.environ.get("USERNAME") or os.environ.get("USER"), "home": str(Path.home()),
        }

    def _rows(self, *, sample: bool) -> list[ProcessRow]:
        data = winps.ps_json(winps.PROCESSES, {"sample": sample}, timeout=40) or {}
        return build_process_rows(data, os.cpu_count() or 1)

    def _with_owners(self, rows: list[ProcessRow]) -> list[ProcessRow]:
        if not rows or len(rows) > 40:
            return rows
        try:
            owners = {int(o["pid"]): str(o.get("user") or "") for o in winps.as_list(winps.ps_json(winps.OWNERS, {"pids": [r.pid for r in rows]}, timeout=30))}
        except winps.PowerShellError:
            return rows
        for row in rows:
            row.user = owners.get(row.pid, row.user)
        return rows

    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]:
        rows = self._rows(sample=sort == "cpu")
        rows.sort(key=(lambda r: r.cpu_percent) if sort == "cpu" else (lambda r: r.rss_bytes), reverse=True)
        return self._with_owners(rows[:limit])

    def find_processes(self, name: str, limit: int) -> list[ProcessRow]:
        needle = name.lower()
        # A plain listing (the kill tool looks a pid up with an empty name) needs no CPU sample.
        rows = [r for r in self._rows(sample=bool(needle)) if needle in r.command.lower() or needle in r.name.lower()]
        rows.sort(key=lambda r: r.cpu_percent, reverse=True)
        return self._with_owners(rows[:limit]) if needle else rows[:limit]

    def listeners_on_port(self, port: int) -> list[PortListener]:
        return parse_listeners(winps.ps_json(winps.LISTENERS, {"port": int(port)}, timeout=30), int(port))

    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]:
        total, sizes, timed_out, errors = measure_tree(path, depth, deadline=time.monotonic() + timeout)
        children = sorted(sizes.items(), key=lambda kv: kv[1], reverse=True)
        return {
            "path": str(path), "total_bytes": None if timed_out else total, "timed_out": timed_out,
            "entries": [{"path": p, "bytes": b} for p, b in children[:limit]],
            "note": "Sizes exclude items that could not be read (access denied)." if errors else None,
        }

    # --- file search ------------------------------------------------------------------------
    @staticmethod
    def _ripgrep() -> str | None:
        # Hermes's installer ships ripgrep under <HERMES_HOME>\tools\ripgrep-<version>-<platform>.
        shipped = sorted((hermes_home() / "tools").glob("ripgrep-*/rg.exe"), reverse=True)
        for candidate in (shutil.which("rg"), *(str(p) for p in shipped), str(hermes_home() / "bin" / "rg.exe")):
            if candidate and os.path.isfile(candidate):
                return candidate
        return None

    @staticmethod
    def _search_roots(scope: str | None) -> tuple[list[str], bool]:
        """``(roots, skip_appdata)``: the named folder, else the person's own folders (never all of AppData)."""
        if scope:
            return [os.path.abspath(os.path.expanduser(scope))], False
        home = Path.home()
        bases = [home, *(Path(os.environ[v]) for v in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial") if os.environ.get(v))]
        roots: list[str] = []
        for base in bases:
            for folder in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"):
                candidate = str(base / folder)
                if os.path.isdir(candidate) and candidate.lower() not in (r.lower() for r in roots):
                    roots.append(candidate)
        return roots or [str(home)], True

    def _candidates(self, query: FileSearch, roots: list[str], skip_appdata: bool, deadline: float) -> Iterator[tuple[str, bool]]:
        rg = self._ripgrep()
        if (query.kind or "any") == "folder" or rg is None:
            yield from walk_entries(roots, deadline=deadline, skip_appdata=skip_appdata)
            return
        result = run([rg, *rg_arguments(query, roots, skip_appdata=skip_appdata)], timeout=max(1.0, deadline - time.monotonic()), encoding="utf-8")
        for line in result.stdout.splitlines():
            if line.strip():
                yield line.strip(), False

    def _content_matches(self, query: FileSearch, roots: list[str], skip_appdata: bool, deadline: float) -> Iterator[tuple[str, bool]]:
        rg = self._ripgrep()
        if not query.text or rg is None or time.monotonic() >= deadline:
            return
        result = run([rg, *rg_content_arguments(query.text, roots, skip_appdata=skip_appdata)], timeout=max(1.0, deadline - time.monotonic()), encoding="utf-8")
        for line in result.stdout.splitlines():
            if line.strip():
                yield line.strip(), False

    def find_files(self, query: FileSearch) -> list[FoundFile]:
        kind = query.kind or "any"
        if not any((query.text, query.name, kind != "any", query.since, query.until, query.extensions)):
            raise ValueError("search needs at least one of: text, name, kind, since/until, extensions")
        bounds = search_time_bounds(query)  # Validates the dates before spending time on the listing.
        roots, skip_appdata = self._search_roots(query.scope)
        deadline = time.monotonic() + 25.0
        limit = max(1, query.limit)
        # Content hits satisfy `text` by themselves, so they are judged without it.
        by_name = query
        by_content = FileSearch(**{**query.__dict__, "text": None, "scope": None})
        found: dict[str, FoundFile] = {}

        def consider(path: str, is_dir: bool, judged: FileSearch) -> None:
            if path in found:
                return
            try:
                st = os.stat(path)
            except OSError:
                return
            # Windows' creation time is what "created yesterday" means; `since`/`until` compare against it.
            if not matches_search(path, judged, is_dir=is_dir, mtime=st.st_ctime, bounds=bounds):
                return
            found[path] = FoundFile(path=path, size=None if is_dir else st.st_size, modified=datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"), kind="folder" if is_dir else "file")

        for path, is_dir in self._candidates(by_name, roots, skip_appdata, deadline):
            consider(path, is_dir, by_name)
            if len(found) >= limit * 20:
                break
        if query.text:
            for path, is_dir in self._content_matches(query, roots, skip_appdata, deadline):
                consider(path, is_dir, by_content)
                if len(found) >= limit * 20:
                    break
        return sorted(found.values(), key=lambda f: f.modified or "", reverse=True)[:limit]

    # --- apps -------------------------------------------------------------------------------
    def installed_apps(self) -> list[AppInfo]:
        now = time.monotonic()
        if self._apps_cache and now - self._apps_cache[0] < 30:
            return self._apps_cache[1]
        apps = parse_start_apps(winps.ps_json(winps.INSTALLED_APPS, timeout=30))
        self._apps_cache = (now, apps)
        return apps

    def running_apps(self) -> list[AppInfo]:
        return parse_running_apps(winps.ps_json(winps.RUNNING_APPS, timeout=30))

    def resolve_app(self, name: str) -> AppInfo | None:
        needle = name.strip().lower().removesuffix(".exe")
        apps = self.installed_apps()
        for app in apps:
            if app.name.lower() == needle:
                return app
        for app in apps:
            if needle in app.name.lower() or (app.bundle_id and needle == app.bundle_id.lower()):
                return app
        return None

    @staticmethod
    def _command_path(name: str) -> str | None:
        """A bare program name (``notepad``, ``chrome``) -> its ``.exe`` through PATH or the App Paths registry.
        Paths and script types are refused: a name must not become an arbitrary command."""
        text = name.strip()
        if not text or re.search(r"[\\/:\"<>|*?]", text):
            return None
        stem = text if text.lower().endswith(".exe") else text + ".exe"
        found = shutil.which(stem)
        if found and found.lower().endswith(".exe"):
            return found
        try:
            import winreg  # noqa: PLC0415 - Windows only.

            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{stem}") as key:
                        value = str(winreg.QueryValue(key, None) or "").strip('"')
                        if value.lower().endswith(".exe") and os.path.isfile(value):
                            return value
                except OSError:
                    continue
        except ImportError:
            pass
        return None

    @staticmethod
    def _launch(argv: Sequence[str]) -> None:
        subprocess.Popen(list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=_DETACHED, close_fds=True)

    def _app_executable(self, app: str) -> str:
        """The program file for an app named by the caller, for opening something *with* it."""
        resolved = self.resolve_app(app)
        if resolved and resolved.bundle_id and os.path.isfile(resolved.bundle_id):
            return resolved.bundle_id
        command = self._command_path(app)
        if command:
            return command
        raise RuntimeError(f"cannot open things with '{app}': it is not an installed program that takes a file or address")

    def open_app(self, name: str, args: Sequence[str] = ()) -> None:
        app = self.resolve_app(name)
        if app and not args:
            os.startfile(app.path)  # type: ignore[attr-defined]  # noqa: S606 - ShellExecute on shell:AppsFolder\<AppID>.
            return
        if app and app.bundle_id and os.path.isfile(app.bundle_id):
            self._launch([app.bundle_id, *args])
            return
        command = self._command_path(name)
        if command:
            self._launch([command, *args])
            return
        if app:
            raise RuntimeError(f"{app.name} cannot be started with arguments")
        raise RuntimeError(f"could not find an application called '{name}'")

    def open_url(self, url: str, app: str | None = None) -> None:
        if app:
            self._launch([self._app_executable(app), url])
        else:
            os.startfile(url)  # type: ignore[attr-defined]  # noqa: S606 - the tool layer allows web schemes only.

    def open_path(self, path: Path, app: str | None = None) -> None:
        if app:
            self._launch([self._app_executable(app), str(path)])
            return
        if is_executable_path(path):
            raise RuntimeError(f"{path.name} is a program or script: opening it would run it. Name an application to open it with instead.")
        os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606

    def reveal(self, path: Path) -> None:
        # explorer wants /select,"<path>" as one command line; a Windows path cannot contain a quote.
        subprocess.Popen(f'explorer.exe /select,"{path}"', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=_DETACHED)

    def quit_app(self, name: str, force: bool) -> None:
        app = self.resolve_app(name)
        label = app.name if app else name
        wanted = {label.lower().removesuffix(".exe"), name.strip().lower().removesuffix(".exe")}
        if app and app.bundle_id and app.bundle_id.lower().endswith(".exe"):
            wanted.add(PureWindowsPath(app.bundle_id).stem.lower())
        targets = [
            r for r in self.running_apps()
            if r.name.lower().removesuffix(".exe") in wanted or (r.path and PureWindowsPath(r.path).stem.lower() in wanted)
        ]
        if not targets:
            raise RuntimeError(f"{label} is not running")
        closed, refused = 0, 0
        for target in targets:
            try:
                self._stop(int(target.pid or 0), force)
                closed += 1
            except RuntimeError:
                refused += 1
        if not closed:
            raise RuntimeError(f"{label} has no window to close politely; use force to end it (unsaved work is lost)")

    def _stop(self, pid: int, force: bool) -> None:
        try:
            winps.ps_json(winps.STOP_PROCESS, {"pid": pid, "force": bool(force)}, timeout=20)
        except winps.PowerShellError as exc:
            reason = str(exc)
            if reason == "NOTFOUND":
                raise ProcessLookupError(pid) from exc
            if reason == "DENIED":
                raise PermissionError(pid) from exc
            if reason == "NOWINDOW":
                raise RuntimeError(f"process {pid} has no window to close politely; use force to end it") from exc
            raise RuntimeError(reason) from exc

    # --- system state (read) -----------------------------------------------------------------
    def network_status(self) -> dict[str, Any]:
        return parse_network(winps.ps_json(winps.NETWORK, timeout=45) or {})

    def bluetooth_status(self) -> dict[str, Any]:
        return parse_bluetooth(winps.ps_json(winps.BLUETOOTH, timeout=30))

    def audio_status(self) -> dict[str, Any]:
        return parse_audio(winps.ps_json(winps.AUDIO, timeout=30) or {})

    def appearance_status(self) -> dict[str, Any]:
        return parse_appearance(winps.ps_json(winps.APPEARANCE, timeout=30) or {})

    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]:
        args = {"minutes": int(minutes), "levels": LOG_LEVELS.get(level, LOG_LEVELS["error"]), "process": process or "", "limit": int(limit)}
        return format_log_lines(winps.ps_json(winps.EVENT_LOG, args, timeout=60), limit)

    def crash_reports(self, limit: int) -> list[dict[str, Any]]:
        rows = winps.as_list(winps.ps_json(winps.CRASHES, {"limit": int(limit)}, timeout=45))
        return [
            {"report": str(r.get("record")), "app": r.get("app"), "time": r.get("time"), "module": r.get("module"), "exception_code": normalise_exception_code(r.get("code"))}
            for r in rows
        ]

    def crash_report(self, ref: str) -> dict[str, Any]:
        record = ref.strip()
        if not record.isdigit():
            raise ValueError("on Windows, report is the event record number (see action=crashes)")
        return summarise_crash(winps.ps_json(winps.CRASH, {"record": int(record)}, timeout=45) or {})

    # --- system control ----------------------------------------------------------------------
    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if percent is not None:
            args["percent"] = max(0, min(100, int(percent)))
        if muted is not None:
            args["muted"] = bool(muted)
        return parse_audio(winps.ps_json(winps.AUDIO, args, timeout=30) or {})

    def set_dark_mode(self, enabled: bool) -> None:
        winps.ps_json(winps.SET_DARK_MODE, {"enabled": bool(enabled)}, timeout=30)

    def open_settings(self, pane: str) -> str:
        target = resolve_pane(pane)
        os.startfile(f"ms-settings:{target}")  # type: ignore[attr-defined]  # noqa: S606
        return target

    def lock_screen(self) -> None:
        if not ctypes.windll.user32.LockWorkStation():  # type: ignore[attr-defined]
            raise RuntimeError("could not lock the screen")

    def sleep_display(self) -> None:
        # WM_SYSCOMMAND / SC_MONITORPOWER with 2 = off; posted, because a hung window must not block the call.
        if not ctypes.windll.user32.PostMessageW(0xFFFF, 0x0112, 0xF170, 2):  # type: ignore[attr-defined]
            raise RuntimeError("could not sleep the display")

    def set_wifi_power(self, enabled: bool) -> None:
        raise HostNotSupported("switching the Wi-Fi radio needs administrator rights on Windows; use system_control action=settings pane=wifi")

    # --- destructive ------------------------------------------------------------------------
    def kill(self, pid: int, force: bool) -> None:
        self._stop(int(pid), force)

    def trash(self, paths: Sequence[Path]) -> None:
        result = winps.ps_json(winps.TRASH, {"paths": [str(p) for p in paths]}, timeout=120) or {}
        errors = [str(e) for e in winps.as_list(result.get("errors"))]
        if errors:
            raise RuntimeError("could not move to the Recycle Bin: " + "; ".join(errors))

    def notify(self, title: str, body: str) -> None:
        winps.ps_json(winps.TOAST, {"title": title, "body": body}, timeout=30)
