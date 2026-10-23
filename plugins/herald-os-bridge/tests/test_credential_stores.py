"""The Python bridge protects the same credential stores as the core and the shell (contracts/v1/credential-stores.reference.json)."""
import importlib
import json
import pathlib

REFERENCE = json.loads((pathlib.Path(__file__).resolve().parents[3] / "contracts" / "v1" / "credential-stores.reference.json").read_text(encoding="utf8"))


def _perm(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.permissions")


def test_home_credential_stores_are_protected_on_every_platform(plugin):
    perm = _perm(plugin)
    wanted = {f"~/{n}" for n in (*REFERENCE["homeDirs"], *REFERENCE["homeFiles"])}
    assert wanted <= set(perm.builtin_protected("win32"))
    assert wanted <= set(perm.builtin_protected("linux"))
    assert wanted <= set(perm.builtin_protected("darwin"))


def test_windows_credential_stores_are_protected(plugin):
    perm = _perm(plugin)
    protected = set(perm.builtin_protected("win32"))
    for base, key in (("APPDATA", "roaming"), ("LOCALAPPDATA", "local"), ("PROGRAMDATA", "programData")):
        for rel in REFERENCE["windows"][key]:
            assert any(p.lower() == f"%{base}%/{rel}".lower() for p in protected), (base, rel)
