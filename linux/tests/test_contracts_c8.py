"""C8, the image and installer trust policy (contracts/v1/c8-*), against the code that implements it.

The golden file ``contracts/v1/fixtures/c8-image-trust/valid-current.json`` says what the policy is;
this module checks that the three places that implement it — ``linux/bin/herald-os``,
``linux/image/packages.sh`` and ``linux/image/cosign.pub`` — say the same thing. The generic fixture
walk over every contract is in the bridge suite (``plugins/herald-os-bridge/tests/test_contracts.py``)
and in the TypeScript suites; this file adds the checks that need the Linux CLI.

Needs ``jsonschema``. On Windows the CLI reads ``os.getuid`` at import, so the loader supplies it for
the duration of the load only (same trick as test_trust.py).
"""

import importlib.machinery
import importlib.util
import json
import os
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
V1 = ROOT / "contracts" / "v1"
CLI_SOURCE = ROOT / "linux" / "bin" / "herald-os"


def _load_cli():
    added = not hasattr(os, "getuid")
    if added:
        os.getuid = lambda: 1000  # type: ignore[attr-defined]
    try:
        loader = importlib.machinery.SourceFileLoader("herald_os_cli_contract_c8", str(CLI_SOURCE))
        spec = importlib.util.spec_from_loader("herald_os_cli_contract_c8", loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module
    finally:
        if added:
            del os.getuid  # type: ignore[attr-defined]


cli = _load_cli()
GOLDEN = json.loads((V1 / "fixtures" / "c8-image-trust" / "valid-current.json").read_text(encoding="utf-8"))
JOURNAL = Draft202012Validator(json.loads((V1 / "c8-trust-journal-entry.schema.json").read_text(encoding="utf-8")))
POLICY_OK = {
    "transports": {"docker": {GOLDEN["image"]["repository"]: [GOLDEN["verification"]["policyRule"]]}}
}


def test_the_cli_constants_are_the_golden_policy():
    verification, bypass, pin = GOLDEN["verification"], GOLDEN["devBypass"], GOLDEN["installerPin"]
    assert cli.IMAGE_REPO == GOLDEN["image"]["repository"]
    assert list(cli.PUBLISHED_CHANNELS) == GOLDEN["image"]["publishedChannels"]
    assert cli.TRUST_KEY.as_posix() == verification["publicKeyOnDevice"]
    assert cli.POLICY_PATH.as_posix() == verification["policyPath"]
    assert cli.DEV_BYPASS == bypass["variable"]
    assert cli.HERMES_INSTALLER == pin["url"]
    assert cli.TRUST_JOURNAL.as_posix().endswith(GOLDEN["journal"]["path"].removeprefix("~/"))
    # The pin is either reviewed (64 hex) or empty, and empty means nothing is installed.
    assert re.fullmatch(r"(?:[0-9a-f]{64})?", cli.HERMES_INSTALLER_SHA256)
    assert pin["constant"] == "HERMES_INSTALLER_SHA256"


def test_the_image_build_installs_the_golden_key_and_rule():
    script = (ROOT / "linux" / "image" / "packages.sh").read_text(encoding="utf-8")
    rule = GOLDEN["verification"]["policyRule"]
    assert GOLDEN["verification"]["publicKeyInRepository"] == "linux/image/cosign.pub"
    assert GOLDEN["verification"]["publicKeyOnDevice"] in script
    assert GOLDEN["image"]["repository"] in script
    assert rule["type"] in script and rule["signedIdentity"]["type"] in script
    assert GOLDEN["devBypass"]["variable"] in script
    containerfile = (ROOT / "linux" / "image" / "Containerfile").read_text(encoding="utf-8")
    assert f"ARG {GOLDEN['devBypass']['variable']}=0" in containerfile, "a published build must default to no bypass"


def test_the_repository_carries_only_the_public_half_of_the_key():
    pub = (ROOT / GOLDEN["verification"]["publicKeyInRepository"]).read_text(encoding="utf-8")
    assert pub.startswith("-----BEGIN PUBLIC KEY-----")
    assert "PRIVATE" not in pub and "ENCRYPTED" not in pub
    assert not list((ROOT / "linux" / "image").glob("cosign.key"))


def _verify(ref, tmp_path, *, env=None, monkeypatch=None, key=True, policy=True, rc=0):
    keyfile = tmp_path / "herald-os.pub"
    if key:
        keyfile.write_text("-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n")
    policyfile = tmp_path / "policy.json"
    if policy:
        policyfile.write_text(json.dumps(POLICY_OK))
    journal = tmp_path / "trust.jsonl"
    argv = []

    def fake(command):
        argv.extend(command)
        return rc, "" if rc == 0 else "no matching signatures"

    if monkeypatch is not None:
        monkeypatch.delenv(GOLDEN["devBypass"]["variable"], raising=False)
        for name, value in (env or {}).items():
            monkeypatch.setenv(name, value)
    allowed = cli.verify_image(ref, key=keyfile, policy=policyfile, journal=journal, run=fake)
    lines = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()] if journal.exists() else []
    return allowed, argv, lines, keyfile


def test_the_verify_command_is_the_golden_one(tmp_path, monkeypatch):
    ref = f"{GOLDEN['image']['repository']}:stable"
    allowed, argv, lines, keyfile = _verify(ref, tmp_path, monkeypatch=monkeypatch)
    assert allowed is True
    template = GOLDEN["verification"]["verifyCommand"]
    expected = [str(keyfile) if part == "<publicKeyOnDevice>" else ref if part == "<ref>" else part for part in template]
    assert argv == expected
    assert [line["outcome"] for line in lines] == ["verified"]


def test_every_decision_is_a_valid_journal_line_and_carries_no_key(tmp_path, monkeypatch):
    repo, bypass = GOLDEN["image"]["repository"], GOLDEN["devBypass"]
    cases = [
        (f"{repo}:stable", {}, dict(rc=0)),  # verified
        (f"{repo}:stable", {}, dict(rc=1)),  # refused: bad signature
        (f"{repo}:stable", {}, dict(key=False)),  # refused: no key
        (f"{repo}:stable", {}, dict(policy=False)),  # refused: no policy rule
        (f"{repo}:beta", {}, dict()),  # refused: unknown channel
        ("localhost/herald-os:dev", {bypass["variable"]: bypass["enablingValue"]}, dict()),  # dev-unsigned
    ]
    seen = set()
    for number, (ref, env, options) in enumerate(cases):
        folder = tmp_path / f"case{number}"
        folder.mkdir()
        _, _, lines, _ = _verify(ref, folder, env=env, monkeypatch=monkeypatch, **options)
        assert len(lines) == 1, ref
        assert JOURNAL.is_valid(lines[0]), lines[0]
        assert "BEGIN" not in json.dumps(lines[0])
        seen.add(lines[0]["outcome"])
    assert seen == set(GOLDEN["journal"]["outcomes"])


def test_the_published_channels_have_no_bypass_and_only_local_builds_do(tmp_path, monkeypatch):
    repo, bypass = GOLDEN["image"]["repository"], GOLDEN["devBypass"]
    assert bypass["publishedChannelsBypass"] is False and bypass["unpublishedRefsOnly"] is True
    for channel in GOLDEN["image"]["publishedChannels"]:
        folder = tmp_path / channel
        folder.mkdir()
        allowed, argv, lines, _ = _verify(f"{repo}:{channel}", folder, env={bypass["variable"]: bypass["enablingValue"]}, monkeypatch=monkeypatch, key=False)
        assert allowed is False, f"{channel} must not be bypassable"
        assert lines[0]["outcome"] == "refused" and argv == []
    folder = tmp_path / "local"
    folder.mkdir()
    allowed, argv, lines, _ = _verify("localhost/herald-os:dev", folder, env={bypass["variable"]: bypass["enablingValue"]}, monkeypatch=monkeypatch, key=False)
    assert allowed is True and lines[0]["outcome"] == bypass["journalOutcome"] and argv == []
    folder = tmp_path / "local-no-flag"
    folder.mkdir()
    allowed, _, lines, _ = _verify("localhost/herald-os:dev", folder, monkeypatch=monkeypatch, key=False)
    assert allowed is False and lines[0]["outcome"] == "refused"


def test_an_empty_pin_refuses_the_installer(monkeypatch, capsys):
    assert GOLDEN["installerPin"]["emptyMeans"] == "refuse-install"
    monkeypatch.setattr(cli, "HERMES_INSTALLER_SHA256", "")
    calls = []
    monkeypatch.setattr(cli.subprocess, "call", lambda *a, **k: calls.append(a) or 0)
    assert cli.install_hermes() == 1
    assert calls == [], "nothing may be downloaded or run while the pin is empty"
