/**
 * Commande `/pair` portée de `core.ts` `registerBuiltinCommands` (rév. 2e180305), corps inchangé.
 * Enregistrée avec le service d'appairage (plugin-gateways), sur le registre de plugin-agent.
 */
import type { CommandRegistry } from "@jarod/plugin-agent";
import type { SettingsService } from "@jarod/plugin-storage";
import type { PairingService } from "./pairing.js";

type CommandHost = { commands: CommandRegistry; settings: SettingsService; pairing: PairingService };

export function registerPairCommand(core: CommandHost): void {
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

    // /pair — core.ts:2025-2045
    add(
      "pair",
      "Demandes d'accès aux messageries : liste, `approve <code>`, `deny <code>` (uniquement dans l'application)",
      async (args) => {
        const [sub = "", code = ""] = args.trim().split(/\s+/);
        if (sub === "approve") {
          const r = await core.pairing.approve(code);
          return { text: `Accès accordé sur ${r.gateway} à ${r.name} (${r.subjectId}).` };
        }
        if (sub === "deny") {
          return { text: core.pairing.deny(code) ? "Demande refusée." : "Code inconnu ou expiré." };
        }
        const rows = core.pairing.list();
        return {
          text: rows.length
            ? rows.map((r) => `- **${r.code}** · ${r.gateway} · ${r.name} (${r.subjectId})`).join("\n")
            : "Aucune demande d'accès en attente.",
        };
      },
      "/pair [approve <code> | deny <code>]",
    );
}
