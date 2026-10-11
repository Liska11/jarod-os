"""Jarod-OS system bridge.

Registers the ``herald_os`` toolset: a narrow set of explicit, permission-tiered tools that let
Hermes act on the computer it is running on. Execution goes through a per-platform
``HostAdapter`` (macOS, Linux and Windows; the Windows one runs PowerShell), permissions through
``bridge.permissions`` (tiers, protected paths, the upstream approval gate), and every call is
recorded by ``bridge.audit``. ``system_os`` (registered from the same ``TOOL_SPECS`` table) drives
Jarod-OS Linux's ``herald-os`` CLI and answers with a clear failure on other platforms.

Out-of-tree by design: the plugin uses only public plugin APIs (``register``,
``ctx.register_tool``, ``ctx.register_skill``, ``tools.approval.request_tool_approval``) so Herald
OS never patches the Hermes core.
"""

from __future__ import annotations

from pathlib import Path

from .bridge import tools as _tools
from .bridge.host import host_available

_SKILLS_DIR = Path(__file__).parent / "skills"
# Skill name -> one-line description for the skills index.
SKILLS: dict[str, str] = {
    "herald-os": "How Hermes acts as the operating environment on this computer.",
    "diagnose-crash": "Explain why a program crashed from its crash report or core dump, and whether it is worth reporting.",
    "herald-os-tailor": "Change Jarod-OS itself: Jarod-OS widgets (menu bar, Overview, their own window), themes, fonts, the wallpaper, the menu bar, control-menu entries, branding, keybindings, settings and routines.",
}


def _check_available() -> bool:
    """Reachability gate: the host adapter must exist for this platform and the bridge must not
    be disabled in config. Cached process-wide by the registry."""
    return host_available() and _tools.bridge_enabled()


def register(ctx) -> None:
    for spec in _tools.TOOL_SPECS:
        ctx.register_tool(
            name=spec.name,
            toolset="herald_os",
            schema=spec.schema,
            handler=spec.handler,
            check_fn=_check_available,
            emoji=spec.emoji,
            description=spec.schema["description"],
        )
    if not hasattr(ctx, "register_skill"):
        return
    for name, description in SKILLS.items():
        skill_md = _SKILLS_DIR / name / "SKILL.md"
        if skill_md.exists():
            ctx.register_skill(name, skill_md, description=description)
