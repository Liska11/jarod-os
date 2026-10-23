"""Permission tiers, protected paths and the confirmation gate.

Tiers:
  read         runs immediately (audited)
  act          runs immediately (audited, surfaced): open an app, a URL, a path
  mutate       asks first; "session" / "always" answers are honoured (mkdir, move, rename)
  destructive  always asks; the rule key is unique per call so "always" cannot persist

Confirmation goes through upstream's ``tools.approval.request_tool_approval`` so Jarod-OS renders the
same approval card for a bridge action as for a shell command, and the operator's global approval
settings (yolo, ``approvals.mode``, smart approval) apply uniformly.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterable

from .util import data_dir, expand, hermes_home


class Tier(str, Enum):
    READ = "read"
    ACT = "act"
    MUTATE = "mutate"
    DESTRUCTIVE = "destructive"


VALID_MODES = ("allow", "confirm", "deny")

DEFAULT_TIER_MODES: dict[Tier, str] = {
    Tier.READ: "allow",
    Tier.ACT: "allow",
    Tier.MUTATE: "confirm",
    Tier.DESTRUCTIVE: "confirm",
}

# Credential stores under the home folder: the same set as contracts/v1/credential-stores.reference.json (test_credential_stores.py
# fails when they drift). The tools that need one (git, aws, kubectl, ssh, docker) still run it from the user's shell.
CREDENTIAL_HOME_PROTECTED = (
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.azure",
    "~/.kube",
    "~/.docker",
    "~/.config/gh",
    "~/.git-credentials",
    "~/.npmrc",
)

# Never read, moved, opened for editing, or deleted by the bridge, regardless of policy.
BUILTIN_PROTECTED = (
    *CREDENTIAL_HOME_PROTECTED,
    "~/Library/Keychains",
    "~/Library/Cookies",
    "$HERMES_HOME/.env",
    "$HERMES_HOME/auth.json",
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/etc",
    "/Library",
    "/private/var/db",
    "/var/db",
    # Linux system locations.
    "/boot",
    "/var/lib",
    "/lib",
    "/lib64",
    "/proc",
    "/sys",
)

# Windows: SSH and GnuPG keys, the Credential Manager / DPAPI / Vault stores, certificates, and the
# system and program folders. Environment variables are expanded where the policy is built.
WINDOWS_PROTECTED = (
    "%APPDATA%/gnupg",
    "%APPDATA%/Microsoft/Credentials",
    "%APPDATA%/Microsoft/Protect",
    "%APPDATA%/Microsoft/SystemCertificates",
    "%LOCALAPPDATA%/Microsoft/Credentials",
    "%LOCALAPPDATA%/Microsoft/Vault",
    "%PROGRAMDATA%/Microsoft/Crypto",
    "%SystemRoot%",
    "%ProgramFiles%",
    "%ProgramFiles(x86)%",
    "%ProgramData%",
)


def builtin_protected(platform: str = sys.platform) -> tuple[str, ...]:
    """The protected locations that apply on ``platform`` (the POSIX roots mean nothing on Windows)."""
    if platform.startswith("win"):
        return (*CREDENTIAL_HOME_PROTECTED, "$HERMES_HOME/.env", "$HERMES_HOME/auth.json", *WINDOWS_PROTECTED)
    return BUILTIN_PROTECTED


DEFAULT_POLICY_TEXT = """# Jarod-OS system bridge policy. See docs/SYSTEM-BRIDGE.md.
version: 1
tiers:
  read: allow
  act: allow
  mutate: confirm
  destructive: confirm
protected_paths: []
"""


@dataclass(frozen=True)
class Policy:
    tiers: dict[Tier, str]
    protected: tuple[Path, ...]

    def mode(self, tier: Tier) -> str:
        mode = self.tiers.get(tier, DEFAULT_TIER_MODES[tier])
        # Destructive actions can never be pre-authorised through the policy file.
        if tier is Tier.DESTRUCTIVE and mode == "allow":
            return "confirm"
        return mode


@dataclass(frozen=True)
class Decision:
    allowed: bool
    outcome: str      # allowed | approved | delegated | denied | blocked | protected | policy_denied
    message: str | None = None


def policy_path() -> Path:
    return data_dir() / "permissions.yaml"


def _expand_protected(raw: Iterable[str]) -> tuple[Path, ...]:
    home = str(hermes_home())
    out: list[Path] = []
    for entry in raw:
        text = str(entry).replace("$HERMES_HOME", home)
        out.append(expand(text))
    return tuple(out)


def parse_policy(data: Any, platform: str = sys.platform) -> Policy:
    """Build a Policy from parsed YAML (pure; unit-tested). Unknown keys are ignored, bad values fall
    back to defaults rather than failing open."""
    tiers = dict(DEFAULT_TIER_MODES)
    extra: list[str] = []
    if isinstance(data, dict):
        raw_tiers = data.get("tiers")
        if isinstance(raw_tiers, dict):
            for key, value in raw_tiers.items():
                try:
                    tier = Tier(str(key))
                except ValueError:
                    continue
                mode = str(value).strip().lower()
                if mode in VALID_MODES:
                    tiers[tier] = mode
        raw_protected = data.get("protected_paths")
        if isinstance(raw_protected, list):
            extra = [str(p) for p in raw_protected if p]
    return Policy(tiers=tiers, protected=_expand_protected((*builtin_protected(platform), *extra)))


_cache: tuple[float, Policy] | None = None


def load_policy() -> Policy:
    """Read the policy file (cached by mtime); a missing or malformed file yields the defaults."""
    global _cache
    path = policy_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = -1.0
    if _cache and _cache[0] == mtime:
        return _cache[1]
    data: Any = None
    if mtime >= 0:
        try:
            import yaml

            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - malformed policy falls back to defaults (fail closed for destructive anyway).
            data = None
    policy = parse_policy(data)
    _cache = (mtime, policy)
    return policy


def ensure_policy_file() -> None:
    path = policy_path()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_POLICY_TEXT, encoding="utf-8")


def protected_root(path: Path, policy: Policy) -> Path | None:
    """The protected root that contains ``path`` (or is ``path``), if any."""
    try:
        resolved = Path(os.path.realpath(path))
    except OSError:
        resolved = path
    for root in policy.protected:
        for candidate in (path, resolved):
            try:
                candidate.relative_to(root)
                return root
            except ValueError:
                continue
    return None


def _stable_rule_key(tool: str, action: str) -> str:
    return f"herald_os:{tool}:{action}"


def _confirm(tool: str, reason: str, rule_key: str) -> Decision:
    try:
        from tools.approval import request_tool_approval
    except Exception:  # noqa: BLE001 - outside the Hermes runtime there is nobody to ask: fail closed.
        return Decision(False, "blocked", "No approval channel is available; refusing without confirmation.")
    result = request_tool_approval(tool, reason, rule_key=rule_key)
    if result.get("approved"):
        return Decision(True, "approved")
    return Decision(False, "denied", result.get("message") or "The user did not approve this action.")


def authorize(
    tool: str,
    tier: Tier,
    action: str,
    summary: str,
    *,
    paths: Iterable[Path] = (),
    delegate_confirm: bool = False,
) -> Decision:
    """Decide whether ``tool``/``action`` may run. Protected paths are refused before anyone is asked.

    ``delegate_confirm`` is for the one caller whose execution is itself gated by the shell's host
    process (``os_ui``): the network of decisions is unchanged — a protected path is still refused, a
    ``deny`` policy still denies — but the *confirmation* is left to the executor, which asks the
    person once. Without it the bridge would ask a second time for the same call (R2.1).
    """
    policy = load_policy()
    for path in paths:
        root = protected_root(path, policy)
        if root is not None:
            return Decision(False, "protected", f"{path} is inside the protected location {root}; the system bridge never touches it.")
    mode = policy.mode(tier)
    if mode == "deny":
        return Decision(False, "policy_denied", f"The Jarod-OS permission policy denies {tier.value} actions ({tool}).")
    if mode == "allow":
        return Decision(True, "allowed")
    if delegate_confirm:
        # The shell holds the approval this call will need, and it is the authority for it: one
        # question, asked where the command is actually carried out.
        return Decision(True, "delegated", f"The shell asks the person for this {tier.value} action itself.")
    if tier is Tier.DESTRUCTIVE:
        # A fresh key per call: "always allow" can never stick to a destructive action.
        rule_key = f"herald_os:{tool}:{action}:{uuid.uuid4().hex[:8]}"
    else:
        rule_key = _stable_rule_key(tool, action)
    return _confirm(tool, summary, rule_key)


def fingerprint(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:10]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
