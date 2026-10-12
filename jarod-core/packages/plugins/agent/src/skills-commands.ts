/**
 * Commandes `/curator` et `/hub` portées de `core.ts` `registerBuiltinCommands` (rév. 2e180305),
 * corps inchangés. Enregistrées avec le curator et le hub (plugin-agent).
 */
import type { CuratorService } from "@jarod/plugin-memory";
import { describeCuratorReport } from "@jarod/plugin-memory";
import { describeGuardReport } from "@jarod/plugin-permissions";
import type { SkillsHubService } from "@jarod/plugin-skills";
import { describeHubResults } from "@jarod/plugin-tools";
import type { CommandRegistry } from "./commands.js";
import type { AgentRuntime } from "./runtime.js";

type CommandHost = AgentRuntime & { curator: CuratorService; hub: SkillsHubService };

export function registerSkillCommands(core: CommandHost): void {
  // Prologue — core.ts:1794-1806
    const c = core.commands;
    const s = core.settings;
    const need = (id: string | null): string => {
      if (!id) throw new Error("Aucune conversation active");
      return id;
    };
    const add = (
      name: string,
      description: string,
      run: Parameters<CommandRegistry["register"]>[0]["run"],
      usage?: string,
    ) => c.register({ name, description, run, source: "builtin", ...(usage ? { usage } : {}) });

    // /curator — core.ts:1916-1946
    add(
      "curator",
      "Entretien des skills apprises : état, passe (`run`), simulation (`dry-run`), épingler (`pin <id>`, `unpin <id>`)",
      async (args) => {
        const [sub = "", id = ""] = args.trim().split(/\s+/);
        if (sub === "run" || sub === "dry-run") {
          return { text: describeCuratorReport(await core.curator.run({ dryRun: sub === "dry-run" })) };
        }
        if (sub === "pin" || sub === "unpin") {
          core.curator.setPinned(id, sub === "pin");
          return { text: `Skill ${id} ${sub === "pin" ? "épinglée" : "désépinglée"}.` };
        }
        const cfg = s.get("curator");
        const rows = core.curator.list().map((u) => {
          const last = u.lastUsedAt ? new Date(u.lastUsedAt).toLocaleDateString() : "jamais";
          const flags = [
            u.author === "agent" ? "apprise" : "",
            u.state === "stale" ? "périmée" : "",
            u.pinned ? "épinglée" : "",
          ]
            .filter(Boolean)
            .join(", ");
          return `- **${u.id}** — ${u.uses} usage(s), ${u.patches} correction(s), dernier usage : ${last}${flags ? ` _(${flags})_` : ""}`;
        });
        const lastRun = cfg.lastRunAt ? new Date(cfg.lastRunAt).toLocaleString() : "jamais";
        return {
          text: `**Curator :** ${cfg.enabled ? "actif" : "désactivé"} · dernière passe : ${lastRun} · périmée après ${cfg.staleAfterDays} j, archivée après ${cfg.archiveAfterDays} j\n${rows.join("\n") || "Aucune skill."}`,
        };
      },
      "/curator [run|dry-run|pin <id>|unpin <id>]",
    );
    // /hub — core.ts:1947-1997
    add(
      "hub",
      "Bibliothèque de skills publiques : `search <mots>`, `inspect <id>`, `install <id>`, `list`, `update [id]`, `remove <id>`",
      async (args) => {
        const [sub = "", ...rest] = args.trim().split(/\s+/);
        const arg = rest.join(" ");
        const need = () => {
          if (!arg) throw new Error("Argument manquant.");
          return arg;
        };
        switch (sub) {
          case "search":
            return { text: describeHubResults(await core.hub.search(need(), 15)) };
          case "inspect": {
            const { bundle, scan, id } = await core.hub.inspect(need());
            const origin = bundle.commit
              ? `${bundle.repo}@${bundle.commit.slice(0, 7)}`
              : (bundle.url ?? bundle.identifier);
            return {
              text: `**${bundle.name}** → \`${id}\` — ${bundle.description}\nOrigine : ${origin} · ${bundle.files.length} fichier(s)\n${describeGuardReport(scan)}`,
            };
          }
          case "install": {
            const r = await core.hub.install(need());
            return {
              text: `Skill ${r.updated ? "mise à jour" : "installée"} : **${r.id}**\n${describeGuardReport(r.scan)}`,
            };
          }
          case "update": {
            const rows = await core.hub.update(arg || undefined);
            return {
              text:
                rows.map((r) => `- ${r.id} : ${r.status}${r.detail ? ` (${r.detail})` : ""}`).join("\n") ||
                "Aucune skill installée depuis le hub.",
            };
          }
          case "remove":
            await core.hub.remove(need());
            return { text: `Skill ${arg} désinstallée (archivée).` };
          default: {
            const lock = await core.hub.lock();
            const rows = Object.entries(lock).map(
              ([id, e]) =>
                `- **${id}** ← \`${e.identifier}\`${e.commit ? ` @${e.commit.slice(0, 7)}` : ""} · ${e.verdict} · ${new Date(e.installedAt).toLocaleDateString()}`,
            );
            return { text: rows.join("\n") || "Aucune skill installée depuis le hub. Essaie `/hub search pdf`." };
          }
        }
      },
      "/hub [search|inspect|install|list|update|remove] …",
    );

    // Q19 : formes sans effet (voir builtin-commands.ts) ; `install`, `update`, `remove`, `run`, `pin` en ont un.
    // `/hub search` et `/hub inspect` interrogent le réseau : refusés depuis une passerelle par prudence.
    c.declareReadOnly("curator", (a) => ["", "dry-run"].includes(a.trim()));
    c.declareReadOnly("hub", (a) => ["", "list"].includes(a.trim()));
}
