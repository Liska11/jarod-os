"""Client for the Jarod-OS control socket: the agent's way to run commands in the shell's UI.

The Electron shell hands the backend its endpoint and a per-launch token through
``JAROD_OS_CONTROL_SOCKET`` and ``JAROD_OS_CONTROL_TOKEN``. The endpoint is a Unix socket path on
macOS and Linux, and ``pipe://<name>`` on Windows: the shell's own named pipe, opened by the owner
rather than a port anything on the machine can dial. Every request carries the token; replies are
single JSON objects.

Requests:
    {"cmd": "ui", "command": "<id>", "args": {...}, "source": "agent"}  -> CommandResult
    {"cmd": "ui-list"}                                                  -> {"ok": true, "result": [CommandSummary]}
    {"cmd": "ui-state"}                                                 -> {"ok": true, "result": {page, windows, ...}}

A command that changes the machine is not run by the socket: the shell asks the person first and
answers ``approval-granted`` with a one-shot capability bound to this command and these arguments.
``run_command`` sends it back once, and the shell spends it on that single call (R2).

Every request may also carry ``requestId``, the caller's own name for the attempt. It is not a
credential: the shell writes it into ``control-audit.jsonl`` beside the bridge's line in
``audit.jsonl``, so one attempt can be read across both (R2.2).
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
# A Windows named pipe: one name, no host, no port. No TCP endpoint exists: the shell never listens.
_PIPE_ENDPOINT = re.compile(r"^pipe://([A-Za-z0-9._-]{1,200})$")


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
    if pipe_path_for(path) is None and not os.path.exists(path):
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
    if pipe is None and not hasattr(socket, "AF_UNIX"):
        raise ShellUnavailable(f"This Python cannot reach the Jarod-OS control socket {path}.")
    if pipe is not None:
        chunks = _pipe_request(pipe, body, timeout)
    else:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(path)
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


def identified(payload: dict[str, Any], request_id: str | None) -> dict[str, Any]:
    """The payload plus the caller's name for this attempt, when it has one (R2.2).

    Both sides write the same id into their own journal, so one attempt can be followed across the
    bridge's ``audit.jsonl`` and the shell's ``control-audit.jsonl``. It authorises nothing: the
    request is decided by the token, the catalogue and — for a mutation — the shell's own approval.
    """
    return {**payload, "requestId": request_id} if request_id else payload


def run_command(
    command: str,
    args: dict[str, Any] | None = None,
    *,
    source: str = "agent",
    request_id: str | None = None,
) -> dict[str, Any]:
    """Run one catalogued command, taking up the shell's approval when it asks for one.

    R2: the shell authorises the mutation, not the socket. A refusal comes back as ``{ok: false,
    code: "unauthorized"|"denied-approval"|...}`` and nothing on the machine has changed.
    """
    payload = identified({"cmd": "ui", "command": command, "args": args or {}, "source": source}, request_id)
    reply = request(payload)
    capability = reply.get("capability")
    if reply.get("code") == "approval-granted" and isinstance(capability, dict) and capability.get("id"):
        # Sent once, for these exact arguments, and never written down: the shell spends it, and a
        # second attempt with the same value is refused as a replay. The request id is the same one:
        # an approval and the call it authorises are one attempt, not two.
        reply = request({**payload, "capability": capability["id"]})
    return reply


def list_commands(*, request_id: str | None = None) -> list[dict[str, Any]]:
    reply = request(identified({"cmd": "ui-list"}, request_id))
    if not reply.get("ok"):
        raise RuntimeError(str(reply.get("error") or "could not list commands"))
    result = reply.get("result")
    return result if isinstance(result, list) else []


def shell_state(*, request_id: str | None = None) -> dict[str, Any]:
    reply = request(identified({"cmd": "ui-state"}, request_id))
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
