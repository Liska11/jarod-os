"""The Python bridge protects the same credential stores as the core and the shell (contracts/v1/credential-stores.reference.json)."""
import json
import pathlib

from bridge import permissions as perm

REFERENCE = json.loads((pathlib.Path(__file__).resolve().parents[3] / "contracts" / "v1" / "credential-stores.reference.json").read_text(encoding="utf8"))


def test_home_credential_stores_are_protected_on_every_platform():
    wanted = {f"~/{n}" for n in (*REFERENCE["homeDirs"], *REFERENCE["homeFiles"])}
    assert wanted <= set(perm.builtin_protected("win32"))
    assert wanted <= set(perm.builtin_protected("linux"))
    assert wanted <= set(perm.builtin_protected("darwin"))


def test_windows_credential_stores_are_protected():
    protected = set(perm.builtin_protected("win32"))
    for base, key in (("APPDATA", "roaming"), ("LOCALAPPDATA", "local"), ("PROGRAMDATA", "programData")):
        for rel in REFERENCE["windows"][key]:
            assert any(p.lower() == f"%{base}%/{rel}".lower() for p in protected), (base, rel)
