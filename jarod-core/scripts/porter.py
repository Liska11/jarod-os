"""
Porteur mécanique Jarod-One → jarod-cordis (lecture seule sur la source).

    python scripts/porter.py <source relatif à packages/core/src> [...]

Copie chaque fichier vers le plugin cible (table MAP) et réécrit ses imports relatifs vers le
package qui héberge désormais le module importé. N'invente rien : un import dont la cible n'est
pas encore portée est signalé (UNRESOLVED) et laissé tel quel, pour correction à la main.
Chaque fichier reçoit un en-tête « Portage de <source> (rév. 2e180305) ».
"""
import os
import re
import sys

SRC = "S:/Jarod-one/packages/core/src/"
ROOT = "S:/store/projet/jarod-cordis/packages/"
REV = "2e180305"

# module source -> (package, fichier cible dans ce package ou None si module intégré à un autre)
MAP = {
    # contrats (déjà portés, modules d'agrégat)
    "types.ts": ("contracts", None),
    "providers/types.ts": ("contracts", None),
    "services/auto-improvement-config.ts": ("contracts", None),
    "util.ts": ("kernel/util", None),
    # storage
    "db.ts": ("plugins/storage", "db.ts"),
    "services/dbkey.ts": ("plugins/storage", "dbkey.ts"),
    "services/eventstore.ts": ("plugins/storage", "eventstore.ts"),
    "services/checkpoints.ts": ("plugins/storage", "checkpoints.ts"),
    "services/portability.ts": ("plugins/memory", "portability.ts"),
    "services/settings.ts": ("plugins/storage", "settings.ts"),
    "services/notifications.ts": ("plugins/storage", "notifications.ts"),
    # scheduler
    "services/cron.ts": ("plugins/scheduler", "cron.ts"),
    "services/jobs.ts": ("plugins/scheduler", "jobs.ts"),
    "services/scheduler.ts": ("plugins/scheduler", "scheduler.ts"),
    "services/webhooks.ts": ("plugins/scheduler", "webhooks.ts"),
    # permissions
    "services/shell-guard.ts": ("plugins/permissions", "shell-guard.ts"),
    "services/docker-sandbox.ts": ("plugins/permissions", "docker-sandbox.ts"),
    "services/skill-guard.ts": ("plugins/permissions", "skill-guard.ts"),
    # rag / memory / skills (partiels en P1)
    "services/attachments.ts": ("plugins/rag", "attachments.ts"),
    "services/vault.ts": ("plugins/rag", "vault.ts"),
    "services/memory.ts": ("plugins/memory", "memory.ts"),
    "services/user-profile.ts": ("plugins/memory", "user-profile.ts"),
    "services/skills.ts": ("plugins/skills", "skills.ts"),
    # llm
    "providers/catalog.ts": ("plugins/llm", "catalog.ts"),
    "providers/openai.ts": ("plugins/llm", "openai.ts"),
    "providers/anthropic.ts": ("plugins/llm", "anthropic.ts"),
    "providers/index.ts": ("plugins/llm", "providers.ts"),
    "services/routing.ts": ("plugins/llm", "routing.ts"),
    "services/router.ts": ("plugins/llm", "router.ts"),
    "services/local.ts": ("plugins/llm", "local.ts"),
    "services/runtimes.ts": ("plugins/llm", "runtimes.ts"),
    "services/llama-server.ts": ("plugins/llm", "llama-server.ts"),
    "services/engine.ts": ("plugins/llm", "engine.ts"),
    "services/huggingface.ts": ("plugins/llm", "huggingface.ts"),
    "services/openai-api.ts": ("plugins/llm", "openai-api.ts"),
    # tools
    "tools/registry.ts": ("plugins/tools", "registry.ts"),
    "tools/builtin.ts": ("plugins/tools", "builtin.ts"),
    "console-text.ts": ("plugins/tools", "console-text.ts"),
    "services/tool-search.ts": ("plugins/tools", "tool-search.ts"),
    "tools/tool-search.ts": ("plugins/tools", "tool-search-tools.ts"),
    "tools/execute-code.ts": ("plugins/tools", "execute-code.ts"),
    "tools/search.ts": ("plugins/tools", "search.ts"),
    "tools/present.ts": ("plugins/tools", "present.ts"),
    "services/terminal.ts": ("plugins/tools", "terminal.ts"),
    "services/ssh.ts": ("plugins/tools", "ssh.ts"),
    "services/ssh-hosts.ts": ("plugins/tools", "ssh-hosts.ts"),
    "tools/vault.ts": ("plugins/tools", "vault-tools.ts"),
    "tools/profile.ts": ("plugins/tools", "profile-tools.ts"),
    "tools/skills.ts": ("plugins/tools", "skills-tools.ts"),
    "tools/cron.ts": ("plugins/agent", "cron-tools.ts"),
    "services/commands.ts": ("plugins/agent", "commands.ts"),
    "services/references.ts": ("plugins/memory", "references.ts"),
    "services/zip.ts": ("plugins/rag", "zip.ts"),
    "services/rag.ts": ("plugins/rag", "rag.ts"),
    "tools/rag.ts": ("plugins/tools", "rag-tools.ts"),
    "services/vision.ts": ("plugins/vision", "vision.ts"),
    "services/profiles.ts": ("plugins/persona", "profiles.ts"),
    "services/mcp.ts": ("plugins/mcp", "mcp.ts"),
    "services/voice.ts": ("plugins/voice", "voice.ts"),
    "services/speech.ts": ("plugins/voice", "speech.ts"),
    "services/persona.ts": ("plugins/persona", "persona.ts"),
    "services/annotations.ts": ("plugins/memory", "annotations.ts"),
    "services/curator.ts": ("plugins/memory", "curator.ts"),
    "services/skills-hub.ts": ("plugins/skills", "skills-hub.ts"),
    "tools/annotations.ts": ("plugins/tools", "annotations-tools.ts"),
    "tools/skills-hub.ts": ("plugins/tools", "skills-hub-tools.ts"),
    "services/learning.ts": ("plugins/agent", "learning.ts"),
    # gateways (P3 W6)
    "services/telegram.ts": ("plugins/gateways", "telegram.ts"),
    "services/discord.ts": ("plugins/gateways", "discord.ts"),
    "services/slack.ts": ("plugins/gateways", "slack.ts"),
    "services/whatsapp.ts": ("plugins/gateways", "whatsapp.ts"),
    "services/email.ts": ("plugins/gateways", "email.ts"),
    "services/pairing.ts": ("plugins/gateways", "pairing.ts"),
    # phone bridge (P3 W9) : le secret d'appairage vient de RemoteHost (core.remoteHost())
    "remote/protocol.ts": ("plugins/gateways", "remote-protocol.ts"),
    "remote/host.ts": ("plugins/gateways", "remote-host.ts"),
    "services/mobile-page.ts": ("plugins/gateways", "mobile-page.ts"),
    "services/mobile.ts": ("plugins/gateways", "mobile.ts"),
    "services/android.ts": ("plugins/gateways", "android.ts"),
    "tools/android.ts": ("plugins/gateways", "android-tools.ts"),
    # agent
    "agent.ts": ("plugins/agent", "agent.ts"),
    "services/sessions.ts": ("plugins/agent", "sessions.ts"),
    "services/loop-guards.ts": ("plugins/agent", "loop-guards.ts"),
    "services/spill.ts": ("plugins/agent", "spill.ts"),
    "services/runtime-lock.ts": ("plugins/agent", "runtime-lock.ts"),
    "services/supervisor.ts": ("plugins/agent", "supervisor.ts"),
    "services/subagents.ts": ("plugins/agent", "subagents.ts"),
    "tools/delegate.ts": ("plugins/agent", "delegate.ts"),
    "tools/orchestration.ts": ("plugins/agent", "orchestration.ts"),
    "tools/sessions.ts": ("plugins/agent", "sessions-tools.ts"),
}


def spec_of(pkg):
    if pkg == "contracts":
        return "@jarod/contracts"
    if pkg == "kernel/util":
        return "@jarod/kernel/util"
    return "@jarod/plugin-" + pkg.split("/")[-1]


def port(rel):
    pkg, target = MAP[rel]
    if target is None:
        raise SystemExit(f"{rel} est un module d'agrégat, pas un fichier à porter")
    src_path = SRC + rel
    text = open(src_path, encoding="utf-8").read()
    unresolved = []

    def rewrite(m):
        spec = m.group(2)
        abs_src = os.path.normpath(os.path.join(os.path.dirname(rel), spec)).replace(os.sep, "/")
        if abs_src.endswith(".js"):
            abs_src = abs_src[:-3] + ".ts"
        hit = MAP.get(abs_src)
        if not hit:
            unresolved.append(abs_src)
            return m.group(0)
        tpkg, tfile = hit
        if tpkg == pkg and tfile:
            new = "./" + tfile[:-3] + ".js"
        else:
            new = spec_of(tpkg)
        return f'{m.group(1)}"{new}"'

    text = re.sub(r'(from\s+|import\s+)"(\.{1,2}/[^"]+)"', rewrite, text)
    text = re.sub(r'/// <reference path="[^"]*sqlite-driver\.d\.ts" />\n', "", text)
    out_dir = ROOT + pkg + "/src/"
    os.makedirs(out_dir, exist_ok=True)
    header = f"// Portage de packages/core/src/{rel} (rév. {REV}).\n"
    open(out_dir + target, "w", encoding="utf-8", newline="\n").write(header + text)
    print(f"{rel} -> {pkg}/src/{target}" + (f"  UNRESOLVED: {sorted(set(unresolved))}" if unresolved else ""))


if __name__ == "__main__":
    for r in sys.argv[1:]:
        port(r)
