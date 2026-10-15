"""The control protocol after R2: one typed door, an authorisation the shell owns, and no replay.

R1 established *who* may ask (two tokens, one per surface) and that every attempt is written down.
R2 closes the second half: the socket no longer carries a free-form "run any command with any
arguments" door (`os`/`os-run`), and a command that changes the machine is not run because a local
process was able to read a file. The shell asks, and answers with a one-shot capability bound to
that command and those exact arguments.

These tests drive the bridge's real client (`bridge/ui.py`) and the CLI's real relay over a socket
that speaks the new protocol, and they assert what a refusal must *not* do: a refused call changes
nothing and is not quietly retried.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = PLUGIN_DIR.parents[1]
CLI = REPO_DIR / "linux" / "bin" / "herald-os"

CATALOGUE = [
    {"id": "page.open", "title": "Open a page", "tier": "read", "args": []},
    {"id": "memory.add", "title": "Remember something", "tier": "mutate", "args": [{"name": "text", "type": "string", "required": True}]},
    {"id": "memory.forget", "title": "Forget a memory", "tier": "destructive", "args": [{"name": "match", "type": "string", "required": True}]},
]

CAPABILITY = "cap_AAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBB"


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


class R2Shell:
    """A control socket that behaves like the shell after R2.

    A mutation is never run on the strength of the token alone: the first attempt is answered with
    ``approval-granted`` and a capability, and only a call that presents that capability — for the
    same command — is executed, once. ``os``/``os-run`` are answered ``unsupported`` and recorded, so
    a test can prove the client never reaches for them.
    """

    def __init__(self, kind: str, token: str, *, deny: bool = False):
        self.kind, self.token, self.deny = kind, token, deny
        self.requests: list[dict] = []
        self.executed: list[str] = []
        self.retired: list[str] = []
        self.spent: set[str] = set()
        if kind == "unix":
            self.dir = tempfile.mkdtemp(prefix="hos-r2-", dir="/tmp")
            self.path = os.path.join(self.dir, "c.sock")
            self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server.bind(self.path)
            self.endpoint = self.path
        else:
            self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server.bind(("127.0.0.1", 0))
            self.endpoint = f"tcp://127.0.0.1:{self.server.getsockname()[1]}"
        self.server.listen(4)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                data = b""
                while not data.endswith(b"\n"):
                    part = conn.recv(65536)
                    if not part:
                        break
                    data += part
                request = json.loads(data.decode())
                self.requests.append(request)
                conn.sendall((json.dumps(self._reply(request)) + "\n").encode())

    def _reply(self, request: dict) -> dict:
        if request.get("token") != self.token:
            return {"ok": False, "code": "unauthenticated", "error": "invalid control token"}
        cmd = str(request.get("cmd") or "")
        if cmd in ("os", "os-run"):
            self.retired.append(cmd)
            return {"ok": False, "code": "unsupported", "error": f"{cmd} is retired"}
        if cmd == "ui-list":
            return {"ok": True, "code": "ok", "result": CATALOGUE}
        if cmd == "ui-state":
            return {"ok": True, "code": "ok", "result": {"page": "overview"}}
        if cmd != "ui":
            return {"ok": False, "code": "unsupported", "error": f"unknown command {cmd}"}
        command = str(request.get("command") or "")
        if command == "page.open":
            self.executed.append(command)
            return {"ok": True, "code": "ok", "summary": "Opened it"}
        capability = request.get("capability")
        if request.get("code") == "replayed" or (capability and capability in self.spent):
            return {"ok": False, "code": "replay", "error": "this capability has already been spent"}
        if capability:
            self.spent.add(str(capability))
            self.executed.append(command)
            return {"ok": True, "code": "ok", "summary": "Forgot it"}
        if self.deny:
            return {"ok": False, "code": "denied-approval", "error": "the request was not approved"}
        return {"ok": False, "code": "approval-granted", "error": "needs approval", "capability": {"id": CAPABILITY, "expiresAt": 1, "binding": "sha256:deadbeef"}}

    def close(self):
        self.server.close()
        if self.kind == "unix":
            shutil.rmtree(self.dir, ignore_errors=True)


@pytest.fixture(params=["unix", "tcp"])
def shell(request, monkeypatch, plugin):
    if request.param == "unix" and not hasattr(socket, "AF_UNIX"):
        pytest.skip("this Python has no AF_UNIX (Windows)")
    fake = R2Shell(request.param, "secret-token")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", fake.endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    _mod(plugin, "util").forget_control_env()
    yield fake
    fake.close()


def test_the_bridge_only_speaks_the_typed_doors(plugin, monkeypatch):
    """`os` and `os-run` are gone from the client, not merely refused by the shell."""
    ui = _mod(plugin, "ui")
    seen: list[dict] = []
    monkeypatch.setattr(ui, "request", lambda payload, **_: seen.append(payload) or {"ok": True})

    ui.run_command("page.open", {"name": "memory"})
    ui.list_commands()
    ui.shell_state()

    assert [payload["cmd"] for payload in seen] == ["ui", "ui-list", "ui-state"]
    assert not [payload for payload in seen if payload["cmd"] in ("os", "os-run")]


def test_a_read_command_runs_on_the_token_alone(plugin, shell):
    ui = _mod(plugin, "ui")
    reply = ui.run_command("page.open", {"name": "memory"})

    assert reply["ok"] is True
    assert shell.executed == ["page.open"]
    assert "capability" not in shell.requests[0]


def test_a_mutation_is_approved_by_the_shell_and_the_capability_is_spent_once(plugin, shell):
    """The shell authorises the mutation; the client takes up its approval and nothing more."""
    ui = _mod(plugin, "ui")
    reply = ui.run_command("memory.forget", {"match": "x"})

    assert reply["ok"] is True
    assert shell.executed == ["memory.forget"], "the mutation must run exactly once"
    assert len(shell.requests) == 2
    assert "capability" not in shell.requests[0], "the first attempt must not carry an approval"
    assert shell.requests[1]["capability"] == CAPABILITY
    assert shell.requests[1]["command"] == shell.requests[0]["command"]
    assert shell.requests[0]["cmd"] == "ui" and shell.requests[1]["cmd"] == "ui"
    assert not shell.retired


def test_a_refusal_is_final_and_changes_nothing(plugin, monkeypatch):
    fake = R2Shell("tcp", "secret-token", deny=True)
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", fake.endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    _mod(plugin, "util").forget_control_env()
    try:
        ui = _mod(plugin, "ui")
        reply = ui.run_command("memory.forget", {"match": "x"})

        assert reply["ok"] is False and reply["code"] == "denied-approval"
        assert fake.executed == [], "a refused mutation must leave no side effect"
        assert len(fake.requests) == 1, "a refusal must not be retried"
        assert "capability" not in fake.requests[0]
    finally:
        fake.close()


def test_a_replayed_capability_is_returned_as_a_refusal_not_retried(plugin, shell):
    ui = _mod(plugin, "ui")
    first = ui.run_command("memory.forget", {"match": "x"})

    assert first["ok"] is True
    # The shell spends the capability, so asking a second time is a fresh approval and then a replay.
    shell.spent.add(CAPABILITY)
    second = ui.run_command("memory.forget", {"match": "x"})

    assert second["ok"] is False and second["code"] == "replay"
    assert shell.executed == ["memory.forget"]
    assert len(shell.requests) == 4, "one approval and one attempt per run, and no extra retries"


def test_the_capability_is_never_written_down(plugin, shell, isolated_home, tmp_path):
    """It lives in one request and one reply: it is not logged, cached or stored."""
    ui = _mod(plugin, "ui")
    assert ui.run_command("memory.forget", {"match": "x"})["ok"] is True

    written: list[str] = []
    for base in (isolated_home, tmp_path):
        for path in base.rglob("*"):
            if path.is_file() and CAPABILITY in path.read_text(encoding="utf-8", errors="ignore"):
                written.append(str(path))

    assert not written, f"the capability was written to disk: {written}"


def test_a_host_refusal_surfaces_as_a_tool_error_with_no_side_effect(plugin, monkeypatch):
    """The tool layer's approval is not the last word: the shell's own refusal still stops the call.

    `os_ui` asks Hermes first (that gate is unchanged), and the host asks the person again for anything
    that changes the machine. When the host says no, the tool reports the failure and the command has
    not run.
    """
    fake = R2Shell("tcp", "secret-token", deny=True)
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", fake.endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    _mod(plugin, "util").forget_control_env()
    tools = _mod(plugin, "tools")
    permissions = _mod(plugin, "permissions")
    monkeypatch.setattr(tools, "authorize", lambda *_, **__: permissions.Decision(True, "allowed"))
    tools._UI_CATALOGUE.clear()
    try:
        reply = json.loads(tools.handle_os_ui({"action": "run", "command": "memory.forget", "args": {"match": "x"}}))

        assert reply["success"] is False
        assert "not approved" in reply["error"]
        assert fake.executed == [], "a refused mutation must leave no side effect"
        assert len([request for request in fake.requests if request.get("cmd") == "ui"]) == 1
    finally:
        fake.close()
        tools._UI_CATALOGUE.clear()


def _load_cli(monkeypatch, runtime: Path):
    """Import the `herald-os` script as a module, with its runtime directory redirected.

    It has no ``.py`` suffix, so the loader is named explicitly; the module-level runtime paths are
    read at import, which is why ``XDG_RUNTIME_DIR`` is set first.
    """
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))
    name = "herald_os_cli_under_test"
    sys.modules.pop(name, None)
    loader = importlib.machinery.SourceFileLoader(name, str(CLI))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    module.__file__ = str(CLI)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


def test_the_cli_takes_up_the_shells_approval_once(monkeypatch, tmp_path):
    cli = _load_cli(monkeypatch, tmp_path)
    sent: list[dict] = []
    replies = [
        {"ok": False, "code": "approval-granted", "error": "needs approval", "capability": {"id": CAPABILITY}},
        {"ok": True, "code": "ok", "summary": "Forgot it"},
    ]

    def fake_send(payload, **_):
        sent.append(dict(payload))
        return replies.pop(0)

    monkeypatch.setattr(cli, "send_payload", fake_send)
    reply = cli.relay_run("memory.forget", {"match": "x"}, quiet=True)

    assert reply["ok"] is True
    assert len(sent) == 2
    assert sent[0]["cmd"] == "run" and sent[0]["command"] == "memory.forget"
    assert sent[0]["args"] == {"match": "x"}
    assert "capability" not in sent[0]
    assert sent[1]["capability"] == CAPABILITY and sent[1]["args"] == {"match": "x"}


def test_the_cli_does_not_retry_a_refusal(monkeypatch, tmp_path):
    cli = _load_cli(monkeypatch, tmp_path)
    sent: list[dict] = []

    def fake_send(payload, **_):
        sent.append(dict(payload))
        return {"ok": False, "code": "denied-approval", "error": "the request was not approved"}

    monkeypatch.setattr(cli, "send_payload", fake_send)
    reply = cli.relay_run("memory.forget", {"match": "x"}, quiet=True)

    assert reply["code"] == "denied-approval"
    assert len(sent) == 1


def test_the_cli_retires_the_free_form_registry_verb():
    """`os <anything> [json]` is exactly the generic mutation door R2 removed: it fails loudly."""
    source = CLI.read_text(encoding="utf-8")

    assert 'relay("os"' not in source
    assert "'os-run'" not in source
    assert '"cmd": "run"' in source
    assert 'RETIRED_COMMANDS = {"os": "use `run ' in source
    assert "relay_run(" in source
