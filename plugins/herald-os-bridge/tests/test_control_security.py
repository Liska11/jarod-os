"""Security of the shell control plane (R1): secrets must not reach child processes.

Reproduces, inside an isolated temporary profile (``isolated_home``), the finding that the shell
hands the bridge its control endpoint and token, and that ``util.run`` passed the whole parent
environment on to every child. Any command the agent ran could therefore read the token and talk to
the control socket directly, bypassing the approval gate in the tool layer.

These tests assert the invariant rather than the symptom: they fail on the unfixed code and hold
after the fix.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
BRIDGE_DIR = PLUGIN_DIR / "bridge"

CONTROL_SECRETS = (
    "HERALD_OS_CONTROL_TOKEN",
    "HERALD_OS_CONTROL_SOCKET",
    "HERMES_OS_CONTROL_TOKEN",
    "HERMES_OS_CONTROL_SOCKET",
)

GATEWAY_SECRETS = (
    "HERMES_DASHBOARD_SESSION_TOKEN",
    "JAROD_GATEWAY_TOKEN",
)

PROBE = "HERALD_OS_TEST_MARKER"


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


@pytest.fixture
def shell_env(tmp_path, monkeypatch):
    """One control endpoint plus its token and the gateway's, exactly as the shell exports them."""
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", "tcp://127.0.0.1:5555")
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "token-that-must-not-travel")
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "gateway-secret-that-must-not-travel")
    monkeypatch.setenv(PROBE, "kept")
    return tmp_path


def _child_report(util, names):
    """Ask a real child process what it inherited."""
    code = "import json, os; print(json.dumps({k: os.environ.get(k) for k in %r}))" % (list(names),)
    result = util.run([sys.executable, "-c", code])
    assert result.code == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_the_probe_environment_is_really_there(shell_env):
    """Guards the guard: if the fixture stops exporting the secrets, the tests below prove nothing."""
    import os

    assert os.environ["HERALD_OS_CONTROL_TOKEN"] == "token-that-must-not-travel"


def test_child_process_never_inherits_the_control_secrets(plugin, shell_env):
    """R1: a child spawned by the bridge must not be able to read the control endpoint or token."""
    util = _mod(plugin, "util")
    seen = _child_report(util, CONTROL_SECRETS)
    assert seen == dict.fromkeys(CONTROL_SECRETS), f"control secrets leaked into a child process: {seen}"


def test_child_process_never_inherits_the_gateway_secrets(plugin, shell_env):
    """The gateway's own session token is the same class of secret and is filtered too."""
    util = _mod(plugin, "util")
    seen = _child_report(util, GATEWAY_SECRETS)
    assert seen == dict.fromkeys(GATEWAY_SECRETS), f"gateway secrets leaked into a child process: {seen}"


def test_child_environment_is_still_an_environment(plugin, shell_env):
    """Filtering must be surgical: the child keeps everything an ordinary command needs."""
    util = _mod(plugin, "util")
    seen = _child_report(util, (PROBE, "PATH", "USERPROFILE", "SystemRoot"))
    assert seen[PROBE] == "kept"
    assert seen["PATH"], "PATH was stripped"
    assert seen["USERPROFILE"] or seen["SystemRoot"], "the environment was replaced instead of filtered"


def test_control_env_reads_once_and_scrubs_its_own_environment(plugin, shell_env):
    """The reader takes the value out of ``os.environ``, so nothing this process starts can see it —
    including the platform shell handlers (``os.startfile``) that accept no environment argument."""
    import os

    util = _mod(plugin, "util")
    util.forget_control_env()
    assert util.control_env("CONTROL_TOKEN") == "token-that-must-not-travel"
    assert util.control_env("CONTROL_SOCKET") == "tcp://127.0.0.1:5555"
    assert "HERALD_OS_CONTROL_TOKEN" not in os.environ
    assert "HERALD_OS_CONTROL_SOCKET" not in os.environ
    assert util.control_env("CONTROL_TOKEN") == "token-that-must-not-travel"


def test_control_endpoint_uses_the_scrubbing_reader(plugin, shell_env):
    """The one caller that needs the token reads it through ``control_env``."""
    import os

    util = _mod(plugin, "util")
    ui = _mod(plugin, "ui")
    util.forget_control_env()
    path, token = ui.control_endpoint()
    assert (path, token) == ("tcp://127.0.0.1:5555", "token-that-must-not-travel")
    assert "HERALD_OS_CONTROL_TOKEN" not in os.environ
    assert "HERALD_OS_CONTROL_SOCKET" not in os.environ
    # The gateway's token is Hermes's own and stays in this process; it is still filtered from every
    # child we start. `child_env` is the single place that decides what a child may see.
    assert not [name for name in util.CONTROL_ENV_NAMES if name in util.child_env()]


def test_control_env_keeps_the_legacy_prefix_working(plugin, monkeypatch):
    """The pre-rename ``HERMES_OS_`` spelling is still honoured, and still scrubbed."""
    import os

    util = _mod(plugin, "util")
    util.forget_control_env()
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    monkeypatch.setenv("HERMES_OS_CONTROL_TOKEN", "legacy-token")
    assert util.control_env("CONTROL_TOKEN") == "legacy-token"
    assert "HERMES_OS_CONTROL_TOKEN" not in os.environ


def test_child_env_refuses_to_reintroduce_a_control_secret(plugin, shell_env):
    """A caller must not be able to opt the secret back in through the ``env=`` argument."""
    util = _mod(plugin, "util")
    env = util.child_env({"HERALD_OS_CONTROL_TOKEN": "smuggled", PROBE: "override"})
    assert "HERALD_OS_CONTROL_TOKEN" not in env
    assert env[PROBE] == "override"
    assert env["PATH"] == util.child_env()["PATH"]


def test_every_subprocess_call_site_filters_the_environment():
    """No module may spawn a child with an unfiltered environment.

    ``util.py`` owns ``child_env``; every other ``subprocess`` call site under ``bridge/`` must pass
    ``env=`` built from it, so detached app launches (osascript, explorer.exe, xdg-open) cannot
    carry the token into an unrelated program either.
    """
    offenders: list[str] = []
    for path in sorted(BRIDGE_DIR.rglob("*.py")):
        lines = path.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if "subprocess.Popen(" not in line and "subprocess.run(" not in line:
                continue
            window = "\n".join(lines[index : index + 6])
            if "env=" not in window and path.name != "util.py":
                offenders.append(f"{path.relative_to(PLUGIN_DIR)}:{index + 1}")
    assert not offenders, "subprocess call sites without a filtered environment: " + ", ".join(offenders)


def test_util_run_builds_the_environment_through_child_env(plugin, shell_env):
    """``run`` is the bridge's single execution helper, so it is the single place to filter."""
    source = (BRIDGE_DIR / "util.py").read_text(encoding="utf-8")
    assert "env=child_env(" in source
    assert "env={**os.environ" not in source


def test_taking_the_control_env_leaves_nothing_to_inherit(plugin, shell_env):
    """The platform openers (``os.startfile``, ShellExecute, ``open -a``) take no ``env=``, so the
    only way their children cannot read the token is for this process to hold it outside the
    environment. Reading it up front does that; the endpoint still works afterwards."""
    import os

    util = _mod(plugin, "util")
    ui = _mod(plugin, "ui")
    util.forget_control_env()
    monkeypatch_names = ("HERALD_OS_CONTROL_SOCKET", "HERALD_OS_CONTROL_TOKEN")
    assert [name for name in monkeypatch_names if name in os.environ] == list(monkeypatch_names)

    util.take_control_env()

    assert [name for name in monkeypatch_names if name in os.environ] == []
    # The gateway's token is Hermes's own runtime credential: it stays, and is filtered per child.
    assert os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] == "gateway-secret-that-must-not-travel"
    assert "HERMES_DASHBOARD_SESSION_TOKEN" not in util.child_env()
    # Taking it early must not cost the bridge its ability to reach the shell.
    assert ui.control_endpoint() == ("tcp://127.0.0.1:5555", "token-that-must-not-travel")


def test_the_plugin_takes_the_control_env_when_it_is_imported(monkeypatch):
    """The guarantee starts at plugin load, not at the first UI request."""
    import importlib.util
    import os

    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "load-time-secret")
    name = "herald_os_bridge_load_probe"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    module.__path__ = [str(PLUGIN_DIR)]  # type: ignore[attr-defined]
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        assert "HERALD_OS_CONTROL_TOKEN" not in os.environ
        util = sys.modules[name + ".bridge.util"]
        assert util.control_env("CONTROL_TOKEN") == "load-time-secret"
    finally:
        for loaded in [key for key in sys.modules if key.startswith(name)]:
            del sys.modules[loaded]
