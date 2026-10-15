"""Make the plugin importable as a package for tests, isolated from the real Hermes home."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load_plugin_package() -> types.ModuleType:
    name = "herald_os_bridge_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    module.__path__ = [str(PLUGIN_DIR)]  # type: ignore[attr-defined]
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    _forget_control_env()
    return home


def _forget_control_env() -> None:
    """Give every test a clean control-plane reader.

    ``bridge.util.control_env`` reads the shell's endpoint and token once and then removes them from
    ``os.environ``, which is correct for one process talking to one shell but would otherwise let the
    first test's values leak into every later one."""
    util = sys.modules.get("herald_os_bridge_under_test.bridge.util")
    forget = getattr(util, "forget_control_env", None) if util is not None else None
    if forget is not None:
        forget()


@pytest.fixture
def plugin():
    return _load_plugin_package()


@pytest.fixture
def bridge(plugin):
    return sys.modules[plugin.__name__ + ".bridge"]
