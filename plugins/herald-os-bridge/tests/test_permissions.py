"""Behaviour contracts for the permission engine."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _perm(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.permissions")


def test_destructive_can_never_be_allowed_by_policy(plugin):
    perm = _perm(plugin)
    policy = perm.parse_policy({"tiers": {"destructive": "allow", "read": "deny"}})
    assert policy.mode(perm.Tier.DESTRUCTIVE) == "confirm"
    assert policy.mode(perm.Tier.READ) == "deny"


def test_malformed_policy_falls_back_to_defaults(plugin):
    perm = _perm(plugin)
    policy = perm.parse_policy(["not", "a", "mapping"])
    for tier, mode in perm.DEFAULT_TIER_MODES.items():
        assert policy.mode(tier) == mode


def test_protected_paths_include_builtin_and_user_entries(plugin, isolated_home):
    perm = _perm(plugin)
    policy = perm.parse_policy({"protected_paths": ["~/Documents/Taxes"]})
    assert perm.protected_root(Path.home() / ".ssh" / "id_ed25519", policy) is not None
    assert perm.protected_root(isolated_home / ".env", policy) is not None
    assert perm.protected_root(Path.home() / "Documents" / "Taxes" / "2025.pdf", policy) is not None
    assert perm.protected_root(Path.home() / "Documents" / "notes.txt", policy) is None


def test_protected_paths_cover_linux_system_locations(plugin):
    perm = _perm(plugin)
    for root in ("/boot", "/var/lib", "/lib", "/lib64", "/proc", "/sys"):
        assert root in perm.BUILTIN_PROTECTED
    policy = perm.parse_policy({}, "linux")
    assert perm.protected_root(Path("/boot/vmlinuz"), policy) is not None
    assert perm.protected_root(Path("/var/lib/dpkg/status"), policy) is not None
    assert perm.protected_root(Path("/proc/1/status"), policy) is not None
    assert perm.protected_root(Path("/var/log/syslog"), policy) is None


def test_protected_path_is_refused_before_any_prompt(plugin, monkeypatch):
    perm = _perm(plugin)
    asked = []
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: asked.append(a) or perm.Decision(True, "approved"))
    decision = perm.authorize("system_files", perm.Tier.MUTATE, "move", "move keys", paths=[Path.home() / ".ssh" / "config"])
    assert not decision.allowed
    assert decision.outcome == "protected"
    assert asked == []


def test_confirm_tier_uses_stable_key_for_mutate_and_fresh_key_for_destructive(plugin, monkeypatch):
    perm = _perm(plugin)
    keys = []

    def fake_confirm(tool, reason, rule_key):
        keys.append(rule_key)
        return perm.Decision(True, "approved")

    monkeypatch.setattr(perm, "_confirm", fake_confirm)
    perm.authorize("system_files", perm.Tier.MUTATE, "mkdir", "create folder")
    perm.authorize("system_files", perm.Tier.MUTATE, "mkdir", "create folder")
    perm.authorize("system_kill_process", perm.Tier.DESTRUCTIVE, "kill", "kill node")
    perm.authorize("system_kill_process", perm.Tier.DESTRUCTIVE, "kill", "kill node")
    assert keys[0] == keys[1], "mutate actions share a rule key so 'always' can apply"
    assert keys[2] != keys[3], "destructive actions never share a rule key"


def test_read_tier_runs_without_confirmation(plugin, monkeypatch):
    perm = _perm(plugin)
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not ask")))
    assert perm.authorize("system_info", perm.Tier.READ, "read", "read info").allowed


def test_confirm_fails_closed_without_approval_channel(plugin, monkeypatch):
    perm = _perm(plugin)
    monkeypatch.setitem(sys.modules, "tools", None)
    monkeypatch.setitem(sys.modules, "tools.approval", None)
    decision = perm._confirm("system_files", "mkdir", "herald_os:system_files:mkdir")
    assert not decision.allowed
    assert decision.outcome == "blocked"


def test_policy_file_is_reloaded_when_it_changes(plugin, isolated_home):
    perm = _perm(plugin)
    path = perm.policy_path()
    path.parent.mkdir(parents=True)
    path.write_text("tiers:\n  act: deny\n")
    assert perm.load_policy().mode(perm.Tier.ACT) == "deny"
    import os
    import time

    path.write_text("tiers:\n  act: allow\n")
    os.utime(path, (time.time() + 5, time.time() + 5))
    assert perm.load_policy().mode(perm.Tier.ACT) == "allow"


def test_delegated_confirmation_leaves_the_question_to_the_executor(plugin, monkeypatch):
    """R2.1: for a tool the shell itself gates, the bridge must not ask a second time."""
    perm = _perm(plugin)
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: (_ for _ in ()).throw(AssertionError("the shell asks")))
    decision = perm.authorize("os_ui", perm.Tier.MUTATE, "memory.forget", "Forget a memory", delegate_confirm=True)
    assert decision.allowed
    assert decision.outcome == "delegated"


def test_delegation_never_weakens_the_policy_or_the_protected_paths(plugin, monkeypatch):
    """Only the confirmation moves: a deny, or a protected path, still stops the call outright."""
    perm = _perm(plugin)
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: (_ for _ in ()).throw(AssertionError("nobody may be asked")))
    monkeypatch.setattr(perm, "load_policy", lambda: perm.parse_policy({"tiers": {"mutate": "deny"}}))
    denied = perm.authorize("os_ui", perm.Tier.MUTATE, "memory.add", "Remember", delegate_confirm=True)
    assert not denied.allowed and denied.outcome == "policy_denied"

    monkeypatch.setattr(perm, "load_policy", lambda: perm.parse_policy({}))
    protected = perm.authorize(
        "os_ui", perm.Tier.MUTATE, "memory.add", "Remember", paths=[Path.home() / ".ssh" / "config"], delegate_confirm=True
    )
    assert not protected.allowed and protected.outcome == "protected"


def test_delegation_is_opt_in_per_caller(plugin, monkeypatch):
    """Every other tool keeps the card: the default is still to ask Hermes."""
    perm = _perm(plugin)
    asked: list[str] = []
    monkeypatch.setattr(perm, "_confirm", lambda tool, reason, rule_key: asked.append(tool) or perm.Decision(True, "approved"))
    assert perm.authorize("system_files", perm.Tier.MUTATE, "mkdir", "create folder").outcome == "approved"
    assert asked == ["system_files"]
