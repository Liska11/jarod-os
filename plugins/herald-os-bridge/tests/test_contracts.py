"""The frozen contracts (``contracts/v1``), checked from the Python side.

Two kinds of test. The first walks ``contracts/v1/index.json`` and validates every fixture of every
contract against its schema; the TypeScript suites (``apps/desktop/electron/shell/contracts.test.ts``,
``jarod-core/packages/plugins/agent/test/contracts.test.ts``) read the very same files, so a schema and
a fixture can only drift apart in both languages at once. The second kind runs the real bridge code
(the control client, the audit journal, the policy parser, the child environment, the registration) and
checks what it produces against the schemas: that is what fails when the code and a contract diverge.

Needs ``jsonschema`` (``--with jsonschema`` in scripts/test-bridge.*, ``pip install jsonschema`` in CI).
"""

from __future__ import annotations

import importlib
import json
import re
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parents[3]
ROOT = REPO / "contracts" / "v1"
TIERS = ["read", "act", "mutate", "destructive"]
PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


def _read(*parts):
    return json.loads((ROOT.joinpath(*parts)).read_text(encoding="utf-8"))


INDEX = _read("index.json")
IDS = [c["id"] for c in INDEX["contracts"]]
VALIDATORS = {}
for _c in INDEX["contracts"]:
    _schema = _read(_c["schema"])
    Draft202012Validator.check_schema(_schema)
    VALIDATORS[_c["id"]] = Draft202012Validator(_schema)


def _fixtures(cid):
    folder = ROOT / "fixtures" / cid
    return [(f.name, f.name.startswith("valid-"), json.loads(f.read_text(encoding="utf-8"))) for f in sorted(folder.glob("*.json"))]


def _all_fixture_cases():
    return [(cid, name, valid, doc) for cid in IDS for name, valid, doc in _fixtures(cid)]


# ---------------------------------------------------------------------------------------------
# Every fixture, in the same files the TypeScript suites read.
# ---------------------------------------------------------------------------------------------


def test_index_lists_every_contract_with_both_kinds_of_fixture():
    assert len(IDS) >= 16
    assert INDEX["notFrozen"]
    for contract in INDEX["contracts"]:
        assert contract["status"] in ("frozen", "provisional")
        assert contract["source"] and contract["protectedBy"]
        cases = _fixtures(contract["id"])
        assert any(valid for _, valid, _ in cases), f"{contract['id']} has no valid fixture"
        assert any(not valid for _, valid, _ in cases), f"{contract['id']} has no invalid fixture"
        assert all(name.startswith(("valid-", "invalid-")) for name, _, _ in cases)


@pytest.mark.parametrize("cid,name,valid,doc", _all_fixture_cases(), ids=lambda v: v if isinstance(v, str) else "")
def test_fixture_verdict(cid, name, valid, doc):
    assert VALIDATORS[cid].is_valid(doc) is valid, f"{cid}/{name} should be {'accepted' if valid else 'rejected'}"


def test_one_tier_ladder_everywhere_it_is_named():
    ladders = []

    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for key, value in node.items():
                if key in ("enum", "const") and isinstance(value, list) and "read" in value and "destructive" in value:
                    ladders.append(value)
                else:
                    walk(value)

    for contract in INDEX["contracts"]:
        walk(_read(contract["schema"]))
    assert len(ladders) >= 4
    assert all(ladder == TIERS for ladder in ladders)


def test_journal_fixture_with_a_token_is_invalid():
    """The most important invalid fixture of the project: a journal line that carries a credential."""
    for cid in ("c3-control-audit-entry", "c3-bridge-audit-entry"):
        names = {name for name, valid, _ in _fixtures(cid) if not valid}
        assert any("token" in name for name in names), cid
        for name, valid, doc in _fixtures(cid):
            if "token" in name or "capability" in name or "nonce" in name:
                assert not valid
                assert not VALIDATORS[cid].is_valid(doc), f"{cid}/{name}"
    control = {name for name, valid, _ in _fixtures("c3-control-audit-entry") if not valid}
    assert {"invalid-contains-token-field.json", "invalid-contains-capability-field.json", "invalid-contains-nonce-field.json", "invalid-token-in-reason.json", "invalid-token-in-command.json"} <= control


def test_a_redacted_journal_line_is_valid_and_a_raw_one_is_not():
    """Mission 0b.1: the shell replaces a live secret by ``[REDACTED:<kind>]``; the line stays valid."""
    validator = VALIDATORS["c3-control-audit-entry"]
    redacted = {name: doc for name, valid, doc in _fixtures("c3-control-audit-entry") if name.startswith("valid-redacted-")}
    assert len(redacted) >= 2
    text = json.dumps(redacted)
    assert all(marker in text for marker in ("[REDACTED:token]", "[REDACTED:capability]", "[REDACTED:nonce]"))
    for name, doc in redacted.items():
        assert validator.is_valid(doc), name
        raw = {**doc, "reason": "unknown command " + "Ab3_" * 10}
        assert not validator.is_valid(raw), f"{name}: a raw token-shaped run must still be rejected"


# ---------------------------------------------------------------------------------------------
# C1: what the bridge puts on the wire, and the endpoints it accepts.
# ---------------------------------------------------------------------------------------------

PIPE = "pipe://herald-os-0123456789abcdef"
TOKEN = "Zk3Qm9vX1pL7wR4tY8uN2cB6hJ5aD0eF"


@pytest.fixture
def wire(plugin, monkeypatch):
    """A shell that is a function: every request body the bridge sends is captured, the reply is canned."""
    ui = _mod(plugin, "ui")
    sent: list[dict] = []
    reply = {"value": {"ok": True, "result": {"page": "memory"}}}

    def pipe_request(path, body, timeout):
        sent.append(json.loads(body))
        return (json.dumps(reply["value"]) + "\n").encode("utf-8")

    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", PIPE)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", TOKEN)
    # Loading the plugin already read (and memoised) the empty environment; read it again.
    _mod(plugin, "util").forget_control_env()
    monkeypatch.setattr(ui, "_pipe_request", pipe_request)
    return sent, reply


def test_every_request_the_client_builds_is_a_valid_control_request(plugin, wire):
    ui = _mod(plugin, "ui")
    sent, reply = wire
    reply["value"] = {"ok": True, "result": []}
    ui.run_command("page.open", {"name": "memory"}, request_id="bridge_0123456789abcdef")
    ui.run_command("memory.add", {"text": "x"}, source="agent")
    ui.list_commands(request_id="bridge_aaaaaaaaaaaaaaaa")
    ui.shell_state()
    assert [r["cmd"] for r in sent] == ["ui", "ui", "ui-list", "ui-state"]
    for request in sent:
        assert VALIDATORS["c1-control-request"].is_valid(request), request
        assert request["token"] == TOKEN
    assert sent[0]["requestId"] == "bridge_0123456789abcdef"
    assert "requestId" not in sent[1]


def test_the_capability_a_second_call_spends_is_a_string(plugin, wire):
    ui = _mod(plugin, "ui")
    sent, reply = wire
    answers = iter([{"ok": False, "code": "approval-granted", "capability": {"id": "cap_x"}}, {"ok": True, "result": {}}])

    def two_step(path, body, timeout):
        sent.append(json.loads(body))
        return (json.dumps(next(answers)) + "\n").encode("utf-8")

    ui._pipe_request = two_step
    ui.run_command("memory.add", {"text": "x"}, request_id="bridge_0123456789abcdef")
    assert len(sent) == 2
    assert sent[1]["capability"] == "cap_x"
    assert sent[1]["requestId"] == sent[0]["requestId"]
    for request in sent:
        assert VALIDATORS["c1-control-request"].is_valid(request), request


def test_the_client_accepts_what_the_host_announces_and_refuses_everything_else(plugin):
    ui = _mod(plugin, "ui")
    for name, valid, doc in _fixtures("c1-control-endpoint"):
        if valid and doc.startswith("pipe://"):
            assert ui.pipe_path_for(doc) is not None, name
        if not valid and doc.startswith(("tcp:", "http:")):
            assert ui.pipe_path_for(doc) is None, name
    assert ui.pipe_path_for("pipe://herald-os-0123456789abcdef") == "\\\\.\\pipe\\herald-os-0123456789abcdef"
    assert ui.pipe_path_for("pipe://") is None
    assert ui.pipe_path_for("pipe://a/b") is None


def test_a_tcp_endpoint_is_refused_by_the_client(plugin, monkeypatch):
    ui = _mod(plugin, "ui")
    for doc in [d for _, valid, d in _fixtures("c1-control-endpoint") if not valid and d.startswith(("tcp:", "http:"))]:
        monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", doc)
        monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", TOKEN)
        ui_util = _mod(plugin, "util")
        ui_util.forget_control_env()
        with pytest.raises(ui.ShellUnavailable):
            ui.control_endpoint()


# ---------------------------------------------------------------------------------------------
# C3: the bridge journal, end to end and line by line.
# ---------------------------------------------------------------------------------------------


def _journal(isolated_home):
    path = isolated_home / "herald-os" / "audit.jsonl"
    return path.read_text(encoding="utf-8").strip().splitlines() if path.exists() else []


def test_audit_lines_written_by_the_bridge_are_valid_and_carry_no_credential(plugin, isolated_home):
    audit = _mod(plugin, "audit")
    audit.record(tool="system_info", tier="read", action=None, args={}, decision="allowed", ok=True)
    audit.record(
        tool="system_network", tier="mutate", action="wifi_connect", args={"ssid": "home", "wifi_password": "hunter2", "Token": TOKEN, "psk": "abc", "passphrase": ""},
        decision="approved", ok=True, summary="a long summary. " * 60, error="a long error. " * 60, request_id="bridge_0123456789abcdef",
    )
    audit.record(tool="system_files", tier="mutate", action="move", args={"paths": ["a", "b"], "n": 3, "flag": True, "none": None, "big": "some words. " * 60}, decision="denied", ok=False, error="no")
    lines = _journal(isolated_home)
    assert len(lines) == 3
    for line in lines:
        assert VALIDATORS["c3-bridge-audit-entry"].is_valid(json.loads(line)), line
    text = "\n".join(lines)
    assert "hunter2" not in text and TOKEN not in text
    redacted = json.loads(lines[1])["args"]
    assert redacted["wifi_password"] == "[redacted]" and redacted["Token"] == "[redacted]" and redacted["psk"] == "[redacted]"
    assert redacted["passphrase"] == ""


def test_an_os_ui_attempt_is_one_valid_line_and_the_same_id_is_on_the_wire(plugin, wire, isolated_home):
    tools = _mod(plugin, "tools")
    sent, _ = wire
    result = json.loads(tools.handle_os_ui({"action": "state"}))
    assert result["success"] is True
    lines = [json.loads(line) for line in _journal(isolated_home)]
    assert len(lines) == 1 and VALIDATORS["c3-bridge-audit-entry"].is_valid(lines[0])
    assert lines[0]["requestId"] == sent[0]["requestId"], "the bridge and the shell must be able to join their journals"
    assert re.fullmatch(r"bridge_[0-9a-f]{16}", lines[0]["requestId"])
    assert TOKEN not in json.dumps(lines)


# ---------------------------------------------------------------------------------------------
# C7 (provisional): the bridge's result envelope.
# ---------------------------------------------------------------------------------------------


def test_the_result_envelope_of_the_helpers_and_of_a_real_failing_handler(plugin, isolated_home):
    util = _mod(plugin, "util")
    tools = _mod(plugin, "tools")
    valid = VALIDATORS["c7-bridge-tool-result"]
    assert valid.is_valid(json.loads(util.ok(cpu=4)))
    assert valid.is_valid(json.loads(util.ok()))
    assert valid.is_valid(json.loads(util.fail("nope", path="/etc")))
    # No shell is running here: the handler must answer with the failure envelope, not raise.
    for args in ({"action": "list"}, {"action": "state"}, {"action": "bogus"}, {"command": ""}):
        reply = json.loads(tools.handle_os_ui(args))
        assert valid.is_valid(reply), reply
        assert reply["success"] is False and reply["error"]


# ---------------------------------------------------------------------------------------------
# C4: the permissions policy.
# ---------------------------------------------------------------------------------------------


def test_the_default_policy_text_is_a_valid_policy(plugin):
    permissions = _mod(plugin, "permissions")
    assert VALIDATORS["c4-permissions-policy"].is_valid(yaml.safe_load(permissions.DEFAULT_POLICY_TEXT))


def test_the_tier_ladder_and_modes_of_the_code_are_the_contracts(plugin):
    permissions = _mod(plugin, "permissions")
    schema = _read("c4-permissions-policy.schema.json")
    assert [t.value for t in permissions.Tier] == TIERS
    assert list(schema["properties"]["tiers"]["properties"]) == TIERS
    for tier in TIERS:
        assert schema["properties"]["tiers"]["properties"][tier]["enum"] == list(permissions.VALID_MODES)


def test_a_valid_policy_is_honoured_and_destructive_is_never_pre_authorised(plugin):
    permissions = _mod(plugin, "permissions")
    for name, valid, doc in _fixtures("c4-permissions-policy"):
        if not valid:
            continue
        policy = permissions.parse_policy(doc)
        for tier_name, mode in (doc.get("tiers") or {}).items():
            tier = permissions.Tier(tier_name)
            expected = "confirm" if (tier is permissions.Tier.DESTRUCTIVE and mode == "allow") else mode
            assert policy.mode(tier) == expected, f"{name}: {tier_name}={mode}"
    destructive_allow = permissions.parse_policy({"tiers": {"destructive": "allow"}})
    assert destructive_allow.mode(permissions.Tier.DESTRUCTIVE) == "confirm"


def test_a_policy_the_schema_rejects_never_widens_access(plugin):
    permissions = _mod(plugin, "permissions")
    seen = 0
    for name, valid, doc in _fixtures("c4-permissions-policy"):
        if valid or not isinstance(doc.get("tiers"), dict):
            continue
        policy = permissions.parse_policy(doc)
        for tier_name, mode in doc["tiers"].items():
            if tier_name in TIERS and mode not in permissions.VALID_MODES:
                tier = permissions.Tier(tier_name)
                assert policy.tiers[tier] == permissions.DEFAULT_TIER_MODES[tier], name
                seen += 1
    assert seen >= 1, "no fixture exercises a bad mode"


def test_never_always_names_what_the_bridge_really_provides():
    golden = _read("fixtures", "c4-never-always", "valid-current.json")
    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    for tool in ("system_files", "system_kill_process"):
        assert tool in golden, f"{tool} moves or kills what the model names: it must never be 'always allow'"
        assert tool in manifest["provides_tools"]


# ---------------------------------------------------------------------------------------------
# C5: one list of environment names, three places that must agree.
# ---------------------------------------------------------------------------------------------


def test_control_env_names_are_the_schema_and_the_golden_file_exactly(plugin):
    util = _mod(plugin, "util")
    schema = _read("c5-control-env-names.schema.json")
    golden = _read("fixtures", "c5-control-env-names", "valid-current.json")
    assert set(util.CONTROL_ENV_NAMES) == set(schema["items"]["enum"]) == set(golden)
    assert len(util.CONTROL_ENV_NAMES) == schema["minItems"] == schema["maxItems"] == len(golden)


def test_no_child_inherits_any_named_variable(plugin, monkeypatch):
    util = _mod(plugin, "util")
    for name in _read("fixtures", "c5-control-env-names", "valid-current.json"):
        monkeypatch.setenv(name, "secret-value")
    monkeypatch.setenv("HARMLESS", "kept")
    env = util.child_env({"HERALD_OS_CONTROL_TOKEN": "smuggled", "EXTRA": "kept"})
    assert not set(env) & set(util.CONTROL_ENV_NAMES)
    assert env["HARMLESS"] == "kept" and env["EXTRA"] == "kept"


def test_every_authority_variable_the_shell_exports_is_in_the_list(plugin):
    util = _mod(plugin, "util")
    exported = set()
    for relative in ("apps/desktop/electron/backend/manager.ts", "apps/desktop/electron/backend/jarod-core.ts"):
        text = (REPO / relative).read_text(encoding="utf-8")
        exported |= set(re.findall(r"\b((?:HERALD_OS|HERMES_OS|JAROD|HERMES_DASHBOARD)_[A-Z_]*(?:TOKEN|SOCKET))\b", text))
    assert exported, "the shell exports no control variable? the pattern needs updating"
    assert exported <= set(util.CONTROL_ENV_NAMES), sorted(exported - set(util.CONTROL_ENV_NAMES))


# ---------------------------------------------------------------------------------------------
# C6: the manifest and the code that registers the tools.
# ---------------------------------------------------------------------------------------------


def test_the_real_manifest_is_valid_and_declares_exactly_what_register_registers(plugin):
    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    errors = sorted(Draft202012Validator(_read("c6-plugin-manifest.schema.json")).iter_errors(manifest), key=str)
    assert not errors, [e.message for e in errors]
    assert "run" not in manifest

    class Ctx:
        def __init__(self):
            self.tools = []

        def register_tool(self, **kwargs):
            self.tools.append(kwargs["name"])

    ctx = Ctx()
    plugin.register(ctx)
    assert sorted(ctx.tools) == sorted(manifest["provides_tools"])
