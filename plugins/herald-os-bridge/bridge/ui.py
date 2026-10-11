"""Client for the Herald OS control socket: the agent's way to run commands in the shell's UI.

The Electron shell (macOS and Windows desktop, Linux panels modes) serves a JSON-lines socket and
hands the backend its endpoint and a per-launch token through ``HERALD_OS_CONTROL_SOCKET`` and
``HERALD_OS_CONTROL_TOKEN``. The endpoint is a Unix socket path, or ``tcp://127.0.0.1:<port>`` on
Windows (loopback only: the token travels in the clear). Every request carries the token; replies
are single JSON objects.

Requests:
    {"cmd": "ui", "command": "<id>", "args": {...}, "source": "agent"}  -> CommandResult
    {"cmd": "ui-list"}                                                  -> {"ok": true, "result": [CommandSummary]}
    {"cmd": "ui-state"}                                                 -> {"ok": true, "result": {page, windows, ...}}
"""

from __future__ import annotations

import json
import os
import re
import socket
from typing import Any

from .util import hermes_home, os_env

DEFAULT_TIMEOUT = 12.0
# The only TCP endpoint accepted: the shell never listens beyond this machine.
_TCP_ENDPOINT = re.compile(r"^tcp://127\.0\.0\.1:(\d{1,5})$")


def parse_tcp_endpoint(endpoint: str) -> tuple[str, int] | None:
    """``(host, port)`` for a ``tcp://127.0.0.1:<port>`` endpoint, None for anything else (a socket path)."""
    match = _TCP_ENDPOINT.match(endpoint.strip())
    if not match or not 0 < int(match[1]) < 65536:
        return None
    return "127.0.0.1", int(match[1])


class ShellUnavailable(RuntimeError):
    """The shell is not running (or did not hand us a socket), so UI commands cannot run."""


def shared_endpoint() -> tuple[str, str]:
    """A shell attached to a backend it did not start writes ``herald-os/control.json`` (0600) instead."""
    try:
        with open(hermes_home() / "herald-os" / "control.json", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return "", ""
    return str(data.get("socket") or ""), str(data.get("token") or "")


def control_endpoint() -> tuple[str, str]:
    """``(socket_path, token)`` from the environment the shell gave the backend, or the shared file."""
    path = os_env("CONTROL_SOCKET").strip()
    token = os_env("CONTROL_TOKEN").strip()
    if not path or not token:
        path, token = shared_endpoint()
    if not path or not token:
        raise ShellUnavailable("Herald OS is not running this session (no control socket); UI commands need the shell.")
    if parse_tcp_endpoint(path) is None and not os.path.exists(path):
        raise ShellUnavailable(f"The Herald OS shell is not listening ({path}); is it running?")
    return path, token


def request(payload: dict[str, Any], *, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    """Send one request and return the parsed reply; raises ``ShellUnavailable`` or ``RuntimeError``."""
    path, token = control_endpoint()
    body = json.dumps({**payload, "token": token}) + "\n"
    tcp = parse_tcp_endpoint(path)
    if tcp is None and not hasattr(socket, "AF_UNIX"):
        raise ShellUnavailable(f"This Python cannot reach the Herald OS control socket {path}.")
    sock = socket.socket(socket.AF_INET if tcp else socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(tcp if tcp else path)
        sock.sendall(body.encode("utf-8"))
        chunks = b""
        while not chunks.endswith(b"\n"):
            part = sock.recv(65536)
            if not part:
                break
            chunks += part
    except (OSError, socket.timeout) as exc:
        raise RuntimeError(f"Herald OS did not answer: {exc}") from exc
    finally:
        sock.close()
    if not chunks.strip():
        raise RuntimeError("Herald OS returned an empty reply")
    try:
        reply = json.loads(chunks.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Herald OS returned malformed JSON: {exc}") from exc
    if not isinstance(reply, dict):
        raise RuntimeError("Herald OS returned an unexpected reply")
    return reply


def run_command(command: str, args: dict[str, Any] | None = None, *, source: str = "agent") -> dict[str, Any]:
    return request({"cmd": "ui", "command": command, "args": args or {}, "source": source})


def list_commands() -> list[dict[str, Any]]:
    reply = request({"cmd": "ui-list"})
    if not reply.get("ok"):
        raise RuntimeError(str(reply.get("error") or "could not list commands"))
    result = reply.get("result")
    return result if isinstance(result, list) else []


def shell_state() -> dict[str, Any]:
    reply = request({"cmd": "ui-state"})
    if not reply.get("ok"):
        raise RuntimeError(str(reply.get("error") or "could not read the shell state"))
    result = reply.get("result")
    return result if isinstance(result, dict) else {}


def summarise_commands(commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trim the catalogue to what the model needs to pick and call a command."""
    out = []
    for entry in commands:
        if not isinstance(entry, dict):
            continue
        args = entry.get("args") or []
        out.append({
            "id": entry.get("id"),
            "title": entry.get("title"),
            "description": entry.get("description"),
            "tier": entry.get("tier"),
            "args": [
                {k: v for k, v in {"name": a.get("name"), "type": a.get("type"), "required": a.get("required") or False, "enum": a.get("enum"), "description": a.get("description")}.items() if v not in (None, False, [])}
                for a in args if isinstance(a, dict)
            ],
        })
    return out
