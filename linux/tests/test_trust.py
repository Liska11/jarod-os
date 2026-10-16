"""Trust at install and update time: the Hermes installer (R5) and the image signature (R6).

The CLI is loaded as a module. On Windows the module reads ``os.getuid`` at import, which does not
exist there, so the loader supplies it for the duration of the load only. The logic under test
never touches the real system: the network, cosign and bootc are replaced by fakes, and the key,
the policy and the journal live in a temporary directory.
"""

import importlib.machinery
import importlib.util
import json
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
CLI_SOURCE = ROOT / "linux" / "bin" / "herald-os"


def _load_cli():
    added = not hasattr(os, "getuid")
    if added:
        os.getuid = lambda: 1000  # type: ignore[attr-defined]
    try:
        loader = importlib.machinery.SourceFileLoader("herald_os_cli_trust", str(CLI_SOURCE))
        spec = importlib.util.spec_from_loader("herald_os_cli_trust", loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module
    finally:
        if added:
            del os.getuid  # type: ignore[attr-defined]


cli = _load_cli()

REF_STABLE = "ghcr.io/iamlukethedev/herald-os:stable"
REF_EDGE = "ghcr.io/iamlukethedev/herald-os:edge"
POLICY_WITH_KEY = {
    "transports": {
        "docker": {
            "ghcr.io/iamlukethedev/herald-os": [
                {"type": "sigstoreSigned", "keyPath": "/etc/pki/containers/herald-os.pub", "signedIdentity": {"type": "matchRepository"}}
            ]
        }
    }
}


# --------------------------------------------------------------------------------------------
# R5 : the Hermes installer is downloaded, checked against a pinned SHA-256, then run.


class FakeProcess:
    """Stands in for subprocess.call: curl writes ``body`` to the path after -o, bash just succeeds."""

    def __init__(self, body: bytes, curl_rc: int = 0):
        self.body, self.curl_rc = body, curl_rc
        self.calls: list[list[str]] = []

    def __call__(self, argv, *args, **kwargs):
        self.calls.append(list(argv))
        if argv[0] == "curl":
            if self.curl_rc == 0:
                Path(argv[argv.index("-o") + 1]).write_bytes(self.body)
            return self.curl_rc
        return 0


def _sha(body: bytes) -> str:
    import hashlib

    return hashlib.sha256(body).hexdigest()


def test_install_refused_without_a_pin(monkeypatch):
    fake = FakeProcess(b"echo hi\n")
    monkeypatch.setattr(cli, "HERMES_INSTALLER_SHA256", "")
    monkeypatch.setattr(cli.subprocess, "call", fake)
    assert cli.install_hermes() != 0
    assert fake.calls == []  # not even downloaded


def test_install_runs_the_script_when_the_checksum_matches(monkeypatch):
    body = b"echo installed\n"
    fake = FakeProcess(body)
    monkeypatch.setattr(cli, "HERMES_INSTALLER_SHA256", _sha(body))
    monkeypatch.setattr(cli.subprocess, "call", fake)
    assert cli.install_hermes() == 0
    assert [call[0] for call in fake.calls] == ["curl", "bash"]


def test_install_refused_on_a_checksum_mismatch(monkeypatch):
    fake = FakeProcess(b"tampered\n")
    monkeypatch.setattr(cli, "HERMES_INSTALLER_SHA256", _sha(b"the reviewed script\n"))
    monkeypatch.setattr(cli.subprocess, "call", fake)
    assert cli.install_hermes() != 0
    assert [call[0] for call in fake.calls] == ["curl"]  # downloaded, never executed


def test_install_refused_when_the_download_fails(monkeypatch):
    fake = FakeProcess(b"", curl_rc=6)
    monkeypatch.setattr(cli, "HERMES_INSTALLER_SHA256", _sha(b""))
    monkeypatch.setattr(cli.subprocess, "call", fake)
    assert cli.install_hermes() != 0
    assert [call[0] for call in fake.calls] == ["curl"]


def test_the_cli_never_pipes_a_download_into_a_shell():
    source = CLI_SOURCE.read_text(encoding="utf-8")
    assert not re.search(r"curl[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b", source)


# --------------------------------------------------------------------------------------------
# R6 : an image is installed or switched to only when its signature verifies, fail-closed.


@pytest.fixture
def trust(tmp_path, monkeypatch):
    monkeypatch.delenv("HERALD_OS_DEV_UNSIGNED", raising=False)
    key = tmp_path / "herald-os.pub"
    key.write_text("-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n", encoding="utf-8")
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(POLICY_WITH_KEY), encoding="utf-8")
    return SimpleNamespace(key=key, policy=policy, journal=tmp_path / "trust.jsonl", tmp=tmp_path)


class Verifier:
    """Replaces cosign: returns (exit code, stderr) and remembers each call."""

    def __init__(self, rc: int = 0, stderr: str = ""):
        self.rc, self.stderr = rc, stderr
        self.calls: list[list[str]] = []

    def __call__(self, argv):
        self.calls.append(list(argv))
        return self.rc, self.stderr


def _journal(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []


def test_a_signed_image_is_accepted(trust):
    run = Verifier(0)
    assert cli.verify_image(REF_STABLE, key=trust.key, policy=trust.policy, journal=trust.journal, run=run) is True
    assert run.calls == [["cosign", "verify", "--key", str(trust.key), REF_STABLE]]


def test_no_key_refuses_and_says_why(trust):
    run = Verifier(0)
    missing = trust.tmp / "absent.pub"
    assert cli.verify_image(REF_STABLE, key=missing, policy=trust.policy, journal=trust.journal, run=run) is False
    assert run.calls == []
    entry = _journal(trust.journal)[-1]
    assert entry["outcome"] == "refused" and "no signing key" in entry["reason"]


def test_a_wrong_key_is_refused(trust):
    run = Verifier(1, "no matching signatures")
    assert cli.verify_image(REF_STABLE, key=trust.key, policy=trust.policy, journal=trust.journal, run=run) is False
    assert _journal(trust.journal)[-1]["outcome"] == "refused"


def test_an_altered_manifest_is_refused(trust):
    run = Verifier(1, "signature verification failed: digest mismatch")
    assert cli.verify_image(REF_STABLE, key=trust.key, policy=trust.policy, journal=trust.journal, run=run) is False
    assert "digest mismatch" in _journal(trust.journal)[-1]["reason"]


def test_an_unknown_channel_is_refused_before_any_check(trust):
    run = Verifier(0)
    assert cli.verify_image("ghcr.io/iamlukethedev/herald-os:nightly", key=trust.key, policy=trust.policy, journal=trust.journal, run=run) is False
    assert run.calls == []


def test_a_missing_policy_entry_is_refused(trust):
    trust.policy.write_text("{}", encoding="utf-8")
    run = Verifier(0)
    assert cli.verify_image(REF_STABLE, key=trust.key, policy=trust.policy, journal=trust.journal, run=run) is False
    assert run.calls == []
    assert "policy" in _journal(trust.journal)[-1]["reason"]


def test_the_dev_bypass_never_applies_to_a_published_channel(trust, monkeypatch):
    monkeypatch.setenv("HERALD_OS_DEV_UNSIGNED", "1")
    run = Verifier(1)
    assert cli.verify_image(REF_EDGE, key=trust.tmp / "absent.pub", policy=trust.policy, journal=trust.journal, run=run) is False


def test_the_dev_bypass_is_for_local_builds_only_and_is_journaled(trust, monkeypatch):
    monkeypatch.setenv("HERALD_OS_DEV_UNSIGNED", "1")
    run = Verifier(1)
    assert cli.verify_image("localhost/herald-os:dev", key=trust.tmp / "absent.pub", policy=trust.policy, journal=trust.journal, run=run) is True
    assert run.calls == []
    assert _journal(trust.journal)[-1]["outcome"] == "dev-unsigned"


def test_without_the_variable_a_local_build_is_refused(trust):
    assert cli.verify_image("localhost/herald-os:dev", key=trust.tmp / "absent.pub", policy=trust.policy, journal=trust.journal, run=Verifier(1)) is False


def _fake_bootc(monkeypatch, edge_as_current=True):
    current = REF_EDGE if edge_as_current else REF_STABLE
    monkeypatch.setattr(cli, "sh", lambda argv, timeout=None: SimpleNamespace(returncode=0, stdout=json.dumps({"spec": {"image": {"image": current}}})))
    calls: list[list[str]] = []

    def call(argv, *args, **kwargs):
        calls.append(list(argv))
        return 0

    monkeypatch.setattr(cli.subprocess, "call", call)
    return calls


def test_an_unverified_image_is_never_switched_to(monkeypatch):
    calls = _fake_bootc(monkeypatch)
    monkeypatch.setattr(cli, "verify_image", lambda ref, **kwargs: False)
    assert cli.image_switch("stable") != 0
    assert not any("switch" in call for call in calls)


def test_a_verified_image_is_switched_to_after_the_check(monkeypatch):
    calls = _fake_bootc(monkeypatch)
    checked: list[str] = []
    monkeypatch.setattr(cli, "verify_image", lambda ref, **kwargs: checked.append(ref) or True)
    assert cli.image_switch("stable") == 0
    assert checked == [REF_STABLE]
    assert ["sudo", "bootc", "switch", REF_STABLE] in calls
