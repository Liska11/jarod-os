"""Client for the Jarod-OS control socket: the agent's way to run commands in the shell's UI.

The Electron shell hands the backend its endpoint and a per-launch token through
``HERALD_OS_CONTROL_SOCKET`` and ``HERALD_OS_CONTROL_TOKEN``. The endpoint is a Unix socket path on
macOS and Linux, and ``pipe://<name>`` on Windows: the shell's own named pipe, opened by the owner
rather than a port anything on the machine can dial. Every request carries the token; replies are
single JSON objects.

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
import threading
from typing import Any

from .util import control_env, hermes_home

DEFAULT_TIMEOUT = 12.0
# The only TCP endpoint accepted: the shell never listens beyond this machine.
_TCP_ENDPOINT = re.compile(r"^tcp://127\.0\.0\.1:(\d{1,5})$")
# A Windows named pipe: one name, no host, no port.
_PIPE_ENDPOINT = re.compile(r"^pipe://([A-Za-z0-9._-]{1,200})$")


def parse_tcp_endpoint(endpoint: str) -> tuple[str, int] | None:
    """``(host, port)`` for a ``tcp://127.0.0.1:<port>`` endpoint, None for anything else (a socket path)."""
    match = _TCP_ENDPOINT.match(endpoint.strip())
    if not match or not 0 < int(match[1]) < 65536:
        return None
    return "127.0.0.1", int(match[1])


def pipe_path_for(endpoint: str) -> str | None:
    """The ``\\\\.\\pipe\\<name>`` path for a ``pipe://<name>`` endpoint, None for anything else."""
    match = _PIPE_ENDPOINT.match(endpoint.strip())
    if not match:
        return None
    return f"\\\\.\\pipe\\{match[1]}"


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
    """``(socket_path, token)`` from the environment the shell gave the backend, or the shared file.

    Both are read with ``control_env``, which removes them from ``os.environ`` as it reads: the
    endpoint and the token are needed for the lifetime of this process, not of its children."""
    path = control_env("CONTROL_SOCKET").strip()
    token = control_env("CONTROL_TOKEN").strip()
    if not path or not token:
        path, token = shared_endpoint()
    if not path or not token:
        raise ShellUnavailable("Jarod-OS is not running this session (no control socket); UI commands need the shell.")
    if parse_tcp_endpoint(path) is None and pipe_path_for(path) is None and not os.path.exists(path):
        raise ShellUnavailable(f"The Jarod-OS shell is not listening ({path}); is it running?")
    return path, token


def _pipe_exchange(path: str, body: str) -> bytes:
    """One JSON line over a Windows named pipe, one line back.

    A pipe is a byte stream like any other, so the read loops until the newline arrives instead of
    trusting one read to be one message.
    """
    with open(path, "r+b", buffering=0) as handle:
        handle.write(body.encode("utf-8"))
        chunks = b""
        while not chunks.endswith(b"\n"):
            part = handle.read(65536)
            if not part:
                break
            chunks += part
    return chunks


def _pipe_request(path: str, body: str, timeout: float) -> bytes:
    """Run the exchange where it can be walked away from: a pipe blocks without a timeout of its own,
    and a shell that never answers must not hang the agent. The worker is a daemon, so a stuck read
    never holds up this process either."""
    outcome: list[Any] = []

    def exchange() -> None:
        try:
            outcome.append(_pipe_exchange(path, body))
        except OSError as exc:
            outcome.append(exc)

    worker = threading.Thread(target=exchange, name="herald-os-control-pipe", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise RuntimeError(f"Jarod-OS did not answer within {timeout:.0f}s")
    answer = outcome[0] if outcome else OSError("the pipe closed without an answer")
    if isinstance(answer, OSError):
        raise RuntimeError(f"Jarod-OS did not answer: {answer}")
    return answer


def request(payload: dict[str, Any], *, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    """Send one request and return the parsed reply; raises ``ShellUnavailable`` or ``RuntimeError``."""
    path, token = control_endpoint()
    body = json.dumps({**payload, "token": token}) + "\n"
    pipe = pipe_path_for(path)
    tcp = None if pipe else parse_tcp_endpoint(path)
    if pipe is None and tcp is None and not hasattr(socket, "AF_UNIX"):
        raise ShellUnavailable(f"This Python cannot reach the Jarod-OS control socket {path}.")
    if pipe is not None:
        chunks = _pipe_request(pipe, body, timeout)
    else:
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
            raise RuntimeError(f"Jarod-OS did not answer: {exc}") from exc
        finally:
            sock.close()
    if not chunks.strip():
        raise RuntimeError("Jarod-OS returned an empty reply")
    try:
        reply = json.loads(chunks.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Jarod-OS returned malformed JSON: {exc}") from exc
    if not isinstance(reply, dict):
        raise RuntimeError("Jarod-OS returned an unexpected reply")
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
