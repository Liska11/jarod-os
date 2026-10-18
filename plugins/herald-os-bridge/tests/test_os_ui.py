"""The ``os_ui`` tool: socket client, tier mapping from the shell's catalogue, approval and audit.

A fake control server stands in for the Electron shell; ``authorize`` is captured."""

from __future__ import annotations

import importlib
import json
import os
import shutil
import socket
import tempfile
import threading
import time

import pytest


if hasattr(socket, "AF_UNIX"):
    LOCAL_KIND = "unix"
else:  # Windows: the shell's door is a named pipe
    from fake_pipe import PipeServer

    LOCAL_KIND = "pipe"


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "page.open", "title": "Open a page or app", "description": "", "tier": "read", "args": [{"name": "name", "type": "string", "required": True, "description": "Page"}], "phrases": [], "hidden": False},
    {"id": "memory.add", "title": "Remember something", "description": "", "tier": "mutate", "args": [{"name": "text", "type": "string", "required": True, "description": "Text"}], "phrases": [], "hidden": False},
    {"id": "memory.forget", "title": "Forget a memory", "description": "", "tier": "destructive", "args": [{"name": "match", "type": "string", "required": True, "description": "Match"}], "phrases": [], "hidden": False},
]


class FakeShell:
    """A JSON-lines server answering like the Electron control server: on a Unix socket (macOS, Linux) or,
    on Windows, on a named pipe (the shell's door there)."""

    def __init__(self, kind: str, token: str):
        self.kind, self.token = kind, token
        self.requests: list[dict] = []
        self.path = ""
        if kind == "pipe":
            self.pipe = PipeServer(self._answer)
            self.endpoint = self.pipe.endpoint
            return
        # AF_UNIX paths are capped at ~104 bytes on macOS; pytest's tmp_path is far longer.
        self.dir = tempfile.mkdtemp(prefix="hos-", dir="/tmp")
        self.path = os.path.join(self.dir, "c.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.endpoint = self.path
        self.server.listen(4)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

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
                conn.sendall(self._answer(data))

    def _answer(self, data: bytes) -> bytes:
        request = json.loads(data.decode())
        self.requests.append(request)
        return (json.dumps(self._reply(request)) + "\n").encode()

    def _reply(self, request: dict) -> dict:
        if request.get("token") != self.token:
            return {"ok": False, "error": "invalid control token"}
        cmd = request.get("cmd")
        if cmd == "ui-list":
            return {"ok": True, "result": CATALOGUE}
        if cmd == "ui-state":
            return {"ok": True, "result": {"page": "overview", "windows": []}}
        if cmd == "ui":
            if request.get("command") == "page.open":
                return {"ok": True, "summary": f"Opened {request['args'].get('name')}", "page": request["args"].get("name")}
            if request.get("command") == "memory.add":
                return {"ok": True, "summary": "Remembered", "highlight": {"kind": "memory", "id": "MEMORY.md:3"}}
            return {"ok": False, "error": "nope"}
        return {"ok": False, "error": "unknown"}

    def close(self):
        if self.kind == "pipe":
            self.pipe.close()
            return
        self.server.close()
        shutil.rmtree(self.dir, ignore_errors=True)


@pytest.fixture(params=[LOCAL_KIND])
def shell(request, monkeypatch, plugin):
    fake = FakeShell(request.param, "secret-token")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", fake.endpoint)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.clear()
    yield fake
    fake.close()
    tools._UI_CATALOGUE.clear()


@pytest.fixture
def decisions(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    seen = []

    def authorize(tool, tier, action, summary, *, paths=(), delegate_confirm=False):
        seen.append((tool, tier, action, summary, delegate_confirm))
        return perm.Decision(True, "allowed")

    monkeypatch.setattr(tools, "authorize", authorize)
    return seen


def test_run_read_command_through_socket(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": {"name": "memory"}}))
    assert reply["success"] is True
    assert reply["page"] == "memory"
    assert decisions[-1][0] == "os_ui" and decisions[-1][1].value == "read" and decisions[-1][2] == "page.open"
    assert shell.requests[-1]["token"] == "secret-token" and shell.requests[-1]["source"] == "agent"


def test_tier_comes_from_the_catalogue(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    json.loads(tools.handle_os_ui({"action": "run", "command": "memory.add", "args": {"text": "likes tea"}}))
    assert decisions[-1][1].value == "mutate"
    assert "likes tea" in decisions[-1][3]
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    assert tools.ui_tier_for("memory.forget", catalogue).value == "destructive"
    assert tools.ui_tier_for("mystery.command", catalogue).value == "mutate"


def test_unknown_command_is_rejected_before_authorizing(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "nope.x"}))
    assert reply["success"] is False and "unknown command" in reply["error"]
    assert not decisions


def test_list_and_state(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    listed = json.loads(tools.handle_os_ui({"action": "list"}))
    assert [c["id"] for c in listed["commands"]] == ["page.open", "memory.add", "memory.forget"]
    assert listed["commands"][0]["args"][0]["required"] is True
    state = json.loads(tools.handle_os_ui({"action": "state"}))
    assert state["page"] == "overview"


def test_shell_refusal_becomes_a_tool_error(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.update({"memory.forget": CATALOGUE[2]})
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "memory.forget", "args": {"match": "x"}}))
    assert reply["success"] is False and reply["error"] == "nope"


def test_string_args_are_parsed(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": '{"name": "memory"}'}))
    assert reply["success"] is True and reply["page"] == "memory"


def test_system_open_stays_inside_the_os(plugin, shell, decisions, tmp_path):
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.update({
        "web.open": {"id": "web.open", "title": "Open a web page", "tier": "act"},
        "file.open": {"id": "file.open", "title": "Open a file", "tier": "act"},
        "files.show": {"id": "files.show", "title": "Show in Files", "tier": "read"},
    })
    doc = tmp_path / "hello.pdf"
    doc.write_bytes(b"%PDF-1.4")
    json.loads(tools.handle_system_open({"target": "url", "url": "https://example.com"}))
    assert shell.requests[-1]["command"] == "web.open" and shell.requests[-1]["args"] == {"url": "https://example.com"}
    json.loads(tools.handle_system_open({"target": "path", "path": str(doc)}))
    assert shell.requests[-1]["command"] == "file.open" and shell.requests[-1]["args"] == {"name": str(doc)}
    json.loads(tools.handle_system_open({"target": "reveal", "path": str(doc)}))
    assert shell.requests[-1]["command"] == "files.show"
    json.loads(tools.handle_system_open({"target": "path", "path": str(tmp_path)}))
    assert shell.requests[-1]["command"] == "files.show"


def test_system_open_with_a_named_app_uses_the_host(plugin, shell, decisions, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    opened = []
    fake_host = type("H", (), {"open_path": lambda self, path, app: opened.append((str(path), app)), "platform": "darwin"})()
    monkeypatch.setattr(tools, "host", lambda: fake_host)
    doc = tmp_path / "hello.pdf"
    doc.write_bytes(b"%PDF-1.4")
    before = len(shell.requests)
    reply = json.loads(tools.handle_system_open({"target": "path", "path": str(doc), "app": "Preview"}))
    assert reply["success"] is True and opened == [(str(doc), "Preview")]
    assert len(shell.requests) == before


def test_system_open_editor_uses_the_first_installed_editor(plugin, shell, decisions, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    opened, installed = [], {"Cursor", "Zed"}
    fake_host = type("H", (), {
        "open_path": lambda self, path, app: opened.append((str(path), app)),
        "resolve_app": lambda self, name: name if name in installed else None,
        "platform": "darwin",
    })()
    monkeypatch.setattr(tools, "host", lambda: fake_host)
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path)}))
    assert reply["success"] is True and opened == [(str(tmp_path), "Cursor")]
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path), "editor": "zed"}))
    assert reply["success"] is True and opened[-1] == (str(tmp_path), "Zed")
    installed.clear()
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path)}))
    assert reply["success"] is False and "Visual Studio Code, Cursor, Zed" in reply["error"]


def test_without_shell_the_tool_explains(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    monkeypatch.delenv("HERALD_OS_CONTROL_SOCKET", raising=False)
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    reply = json.loads(tools.handle_os_ui({"action": "state"}))
    assert reply["success"] is False and "control socket" in reply["error"]


def test_tcp_endpoint_is_refused_everywhere(plugin, isolated_home, monkeypatch):
    # The shell never announces a TCP endpoint: a tcp:// value, from the environment, is not a socket
    # this client will dial.
    ui = _mod(plugin, "ui")
    assert not hasattr(ui, "parse_tcp_endpoint")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:5150")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "t")
    with pytest.raises(ui.ShellUnavailable):
        ui.control_endpoint()


def test_shared_endpoint_follows_hermes_home(plugin, isolated_home, monkeypatch):
    ui = _mod(plugin, "ui")
    monkeypatch.delenv("HERALD_OS_CONTROL_SOCKET", raising=False)
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    (isolated_home / "herald-os").mkdir()
    socket_file = isolated_home / "herald-os" / "control.sock"
    socket_file.write_text("", encoding="utf-8")
    (isolated_home / "herald-os" / "control.json").write_text(json.dumps({"socket": str(socket_file), "token": "t"}), encoding="utf-8")
    assert ui.control_endpoint() == (str(socket_file), "t")


def test_pipe_endpoint_is_a_name_not_a_path(plugin):
    """Windows reaches the shell over a named pipe: a flat name under ``\\\\.\\pipe\\``, never a file
    path and never a TCP endpoint."""
    ui = _mod(plugin, "ui")
    assert ui.pipe_path_for("pipe://herald-os-9f2c") == r"\\.\pipe\herald-os-9f2c"
    for bad in ("tcp://127.0.0.1:5150", "/run/user/1000/herald-os/control.sock", "pipe://", "pipe://a/b", "pipe://a\\b", "pipe://c:\\x", ""):
        assert ui.pipe_path_for(bad) is None


def test_a_pipe_endpoint_needs_no_socket_file(plugin, monkeypatch):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "pipe://herald-os-absent")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    assert ui.control_endpoint() == ("pipe://herald-os-absent", "secret-token")


def test_request_dials_the_pipe_and_carries_the_token(plugin, monkeypatch):
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "pipe://herald-os-test")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    seen = []

    def exchange(path, body):
        seen.append((path, body))
        return json.dumps({"ok": True, "result": []}).encode() + b"\n"

    monkeypatch.setattr(ui, "_pipe_exchange", exchange)
    assert ui.run_command("page.open", {"name": "memory"}) == {"ok": True, "result": []}
    path, body = seen[0]
    assert path == r"\\.\pipe\herald-os-test"
    assert body.endswith("\n")
    assert json.loads(body) == {"cmd": "ui", "command": "page.open", "args": {"name": "memory"}, "source": "agent", "token": "secret-token"}


def test_a_pipe_that_never_answers_gives_up(plugin, monkeypatch):
    """A pipe read blocks without a timeout of its own, so the agent must not be able to wait on it
    forever."""
    ui = _mod(plugin, "ui")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "pipe://herald-os-silent")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    monkeypatch.setattr(ui, "_pipe_exchange", lambda path, body: time.sleep(30))
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="did not answer"):
        ui.request({"cmd": "ui", "command": "page.open"}, timeout=0.2)
    assert time.monotonic() - started < 10
