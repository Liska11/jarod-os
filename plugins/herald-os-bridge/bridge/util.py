"""Small shared helpers: subprocess execution and result envelopes."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


@dataclass(frozen=True)
class ExecResult:
    code: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.code == 0


#: Variables that carry authority over the shell's control socket or the gateway. The shell exports
#: them to the bridge on purpose, so the bridge can drive the UI; nothing the bridge starts may
#: inherit them. A child that reads the control token can talk to the socket directly and skip the
#: approval gate in the tool layer. These names are filtered from every child (``child_env``); the
#: subset the bridge itself reads is also removed from this process (``control_env``) — the gateway's
#: session token belongs to the Hermes runtime sharing this process and is only filtered, not taken.
#: Contract c5 (contracts/v1) is additive only: each rename ADDS its names and keeps the older ones, so a token exported under
#: any name the shell has ever used is still filtered. ``JAROD_OS_*`` joined on 2026-10-19 (Jarod-OS rename, phase 2).
CONTROL_ENV_NAMES = frozenset(
    {
        "JAROD_OS_CONTROL_TOKEN",
        "JAROD_OS_CONTROL_SOCKET",
        "JAROD_OS_CLI_TOKEN",
        "HERALD_OS_CONTROL_TOKEN",
        "HERALD_OS_CONTROL_SOCKET",
        "HERMES_OS_CONTROL_TOKEN",
        "HERMES_OS_CONTROL_SOCKET",
        "HERALD_OS_CLI_TOKEN",
        "HERMES_OS_CLI_TOKEN",
        "JAROD_GATEWAY_TOKEN",
        "HERMES_DASHBOARD_SESSION_TOKEN",
    }
)

#: Control variables read once and then removed from ``os.environ`` (see ``control_env``).
_TAKEN: dict[str, str] = {}


def child_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment for a child process: everything except the control-plane secrets.

    ``env`` adds or overrides ordinary variables. A control secret named there is dropped anyway, so
    no caller can smuggle one back in."""
    merged = {**os.environ, **(env or {})}
    return {name: value for name, value in merged.items() if name not in CONTROL_ENV_NAMES}


def control_env(name: str) -> str:
    """Read one control-plane variable and take it out of this process's environment.

    ``JAROD_OS_<name>``, falling back to the older ``HERALD_OS_<name>`` then ``HERMES_OS_<name>`` (the newest name set wins),
    the value remembered for later calls. EVERY name is removed from ``os.environ``, the ones not used too: removing them is what
    makes the guarantee hold for every way a child can be started, including the platform shell handlers (``os.startfile``,
    ShellExecute, ``open -a``) that take no environment argument at all."""
    key = f"{ENV_PREFIXES[0]}{name}"
    if key not in _TAKEN:
        value = ""
        for candidate in (f"{prefix}{name}" for prefix in ENV_PREFIXES):
            found = os.environ.pop(candidate, "")
            if found and not value:
                value = found
        _TAKEN[key] = value
    return _TAKEN[key]


def forget_control_env() -> None:
    """Drop the remembered control values so the next ``control_env`` reads the environment again.

    For a process that is handed a new shell, and for tests that must exercise the read itself."""
    _TAKEN.clear()


def take_control_env() -> None:
    """Read the control endpoint and tokens now, at plugin load.

    ``child_env`` covers everything the bridge starts itself, but the platform openers
    (``os.startfile``, ShellExecute, ``open -a``) take no environment argument: their child inherits
    this process's environment whatever we pass. Reading the values out of ``os.environ`` up front
    leaves nothing there to inherit, whenever the first launch happens."""
    for name in ("CONTROL_SOCKET", "CONTROL_TOKEN", "CLI_TOKEN"):
        control_env(name)


def run(argv: Sequence[str], *, timeout: float = 15.0, env: Mapping[str, str] | None = None, cwd: str | None = None, encoding: str | None = None) -> ExecResult:
    """Run a fixed argv (never a shell string) and never raise on non-zero exit.

    ``encoding`` names how the child's output is decoded (default: the locale's, as ``text=True``
    does); on Windows no console window is opened for the child. The child gets ``child_env``, never
    this process's environment as-is."""
    extra: dict[str, Any] = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    if encoding:
        extra.update(encoding=encoding, errors="replace")
    else:
        extra["text"] = True
    try:
        proc = subprocess.run(
            list(argv), capture_output=True, timeout=timeout, cwd=cwd,
            env=child_env(env), check=False, **extra,
        )
    except subprocess.TimeoutExpired as exc:
        return ExecResult(124, (exc.stdout or b"").decode() if isinstance(exc.stdout, bytes) else (exc.stdout or ""), f"timed out after {timeout}s")
    except FileNotFoundError as exc:
        return ExecResult(127, "", f"{argv[0]}: not found ({exc})")
    return ExecResult(proc.returncode, proc.stdout or "", proc.stderr or "")


def ok(**payload: Any) -> str:
    return json.dumps({"success": True, **payload}, ensure_ascii=False, default=str)


def fail(error: str, **payload: Any) -> str:
    return json.dumps({"success": False, "error": error, **payload}, ensure_ascii=False, default=str)


def expand(path: str) -> Path:
    """Expand ``~`` and environment variables and resolve to an absolute path without following the
    final symlink (so protected-path checks see the path the user named)."""
    expanded = os.path.expandvars(os.path.expanduser(path.strip()))
    return Path(os.path.abspath(expanded))


def hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - outside a Hermes runtime (tests) fall back to the default.
        if os.environ.get("HERMES_HOME"):
            return Path(os.environ["HERMES_HOME"])
        # Hermes's own default: %LOCALAPPDATA%\hermes for a native Windows install, ~/.hermes elsewhere.
        if sys.platform == "win32":
            return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "hermes"
        return Path.home() / ".hermes"


#: Prefixes an OS setting is read under, newest first: ``JAROD_OS_`` since the Jarod-OS rename (2026-10-19), then the
#: names it had before (``HERALD_OS_``, then ``HERMES_OS_``), still read. ``HERALD_OS_DEV_UNSIGNED`` is not read through here:
#: contract c8 fixes that name.
ENV_PREFIXES = ("JAROD_OS_", "HERALD_OS_", "HERMES_OS_")


def os_env(name: str) -> str:
    """``JAROD_OS_<name>``, falling back to the older ``HERALD_OS_<name>`` then ``HERMES_OS_<name>``: the newest name set wins."""
    for prefix in ENV_PREFIXES:
        value = os.environ.get(f"{prefix}{name}")
        if value:
            return value
    return ""


def data_dir() -> Path:
    """``$HERMES_HOME/herald-os``. Files still in the pre-rename ``hermes-os`` folder are moved over
    first (the shell does the same at launch; whichever runs first wins, neither overwrites)."""
    path = hermes_home() / "herald-os"
    legacy = hermes_home() / "hermes-os"
    if legacy.is_dir() and not legacy.is_symlink():
        try:
            path.mkdir(parents=True, exist_ok=True)
            for entry in legacy.iterdir():
                target = path / entry.name
                if not target.exists():
                    entry.rename(target)
            legacy.rmdir()
        except OSError:
            pass
    return path


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
