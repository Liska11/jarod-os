// Portage de packages/core/src/tools/profile.ts (rév. 2e180305).
import { PROFILE_SECTIONS, type UserProfileService } from "@jarod/plugin-memory";
import type { ToolDef } from "./registry.js";

/**
 * `user_profile`: the agent keeps USER.md, its short portrait of the user, up to date. It is read
 * back at the start of every conversation; single facts still go to memory_save.
 */
export function profileTools(profile: UserProfileService): ToolDef[] {
  return [
    {
      name: "user_profile",
      description: `Ton portrait de l'utilisateur (USER.md), relu au début de chaque conversation. \`view\` : l'afficher. \`add\` : ajouter une ligne durable à une section (${PROFILE_SECTIONS.join(", ")}, ou une autre). \`set_section\` : réécrire une section (lines), pour condenser ou corriger. \`remove\` : retirer les lignes contenant un texte. N'y mets que ce qui restera vrai et utile ; les faits ponctuels vont dans memory_save.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["view", "add", "set_section", "remove"] },
          section: { type: "string" },
          line: { type: "string" },
          lines: { type: "array", items: { type: "string" } },
          text: { type: "string" },
        },
        required: ["action"],
      },
      source: "builtin",
      async run(args) {
        const action = String(args.action);
        if (action === "view") return profile.read() || "Profil vide.";
        if (action === "add") {
          const added = profile.add(String(args.section ?? ""), String(args.line ?? ""));
          return added ? "Ajouté au profil." : "Déjà dans le profil.";
        }
        if (action === "set_section") {
          const lines = Array.isArray(args.lines) ? args.lines.map(String) : [];
          profile.setSection(String(args.section ?? ""), lines);
          return lines.length ? "Section réécrite." : "Section retirée.";
        }
        if (action === "remove") return `${profile.remove(String(args.text ?? ""))} ligne(s) retirée(s).`;
        throw new Error(`Action inconnue : ${action}`);
      },
    },
  ];
}
