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


def run(argv: Sequence[str], *, timeout: float = 15.0, env: Mapping[str, str] | None = None, cwd: str | None = None, encoding: str | None = None) -> ExecResult:
    """Run a fixed argv (never a shell string) and never raise on non-zero exit.

    ``encoding`` names how the child's output is decoded (default: the locale's, as ``text=True``
    does); on Windows no console window is opened for the child."""
    extra: dict[str, Any] = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    if encoding:
        extra.update(encoding=encoding, errors="replace")
    else:
        extra["text"] = True
    try:
        proc = subprocess.run(
            list(argv), capture_output=True, timeout=timeout, cwd=cwd,
            env={**os.environ, **(env or {})}, check=False, **extra,
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


def os_env(name: str) -> str:
    """``HERALD_OS_<name>``, falling back to the pre-rename ``HERMES_OS_<name>``."""
    return os.environ.get(f"HERALD_OS_{name}") or os.environ.get(f"HERMES_OS_{name}") or ""


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
