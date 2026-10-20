// Portage de packages/core/src/tools/skills-hub.ts (rév. 2e180305).
import { describeGuardReport } from "@jarod/plugin-permissions";
import type { HubSearchResult, SkillsHubService } from "@jarod/plugin-skills";
import type { ToolDef } from "./registry.js";

export const describeHubResults = (results: HubSearchResult[]): string =>
  results.length
    ? results
        .map(
          (r) =>
            `- \`${r.identifier}\` — ${r.name}${r.description ? ` : ${r.description}` : ""}${r.installs !== undefined ? ` (${r.installs.toLocaleString("fr-FR")} installations)` : ""}`,
        )
        .join("\n")
    : "Aucune skill trouvée.";

/**
 * The hub, for the agent: searching and inspecting are read-only; installing downloads code and
 * instructions from the internet into every future prompt, so it is `dangerous` (approval gate).
 */
export function skillHubTools(hub: SkillsHubService): ToolDef[] {
  return [
    {
      name: "skill_hub_search",
      description:
        "Cherche des skills publiques (format Agent Skills : skills.sh, GitHub, index /.well-known d'un domaine). Avec `inspect`, télécharge une skill sans l'installer et montre sa description, ses fichiers et l'analyse de sécurité.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Mots-clés, ou un domaine pour lire son index de skills." },
          inspect: {
            type: "string",
            description: "Identifiant à examiner (propriétaire/dépôt/skill, well-known:domaine/skill ou URL).",
          },
          limit: { type: "integer" },
        },
      },
      source: "skill",
      async run(args) {
        if (typeof args.inspect === "string" && args.inspect.trim()) {
          const { bundle, scan, id } = await hub.inspect(args.inspect);
          const files = bundle.files.map((f) => `${f.path} (${f.data.length} o)`).join(", ");
          const origin = bundle.commit
            ? `${bundle.repo}@${bundle.commit.slice(0, 7)}/${bundle.path}`
            : (bundle.url ?? bundle.identifier);
          return `# ${bundle.name} → dossier « ${id} »\n${bundle.description}\n\nOrigine : ${origin}\nFichiers : ${files}\n\n${describeGuardReport(scan)}`;
        }
        const query = typeof args.query === "string" ? args.query : "";
        if (!query.trim()) throw new Error("Donne `query` ou `inspect`.");
        // Cockpit, lot 3 : les skills EMBARQUÉES (provenance épinglée, hors ligne) d'abord ; « embarquées » les liste toutes.
        const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const all = /embarqu|bundled/i.test(query);
        const local = (await hub.bundled()).filter((b) => all || words.some((w) => `${b.id} ${b.name} ${b.description}`.toLowerCase().includes(w)));
        const localText = local.length
          ? `Embarquées (hors ligne, ${local[0]!.repo}@${local[0]!.commit.slice(0, 7)}, ${local[0]!.license}) :\n${local.map((b) => `- \`${b.identifier}\` — ${b.description}${b.installed ? " (installée)" : ""}`).join("\n")}\n\n`
          : "";
        if (all) return localText || "Aucune skill embarquée.";
        let remote: string;
        try {
          remote = describeHubResults(await hub.search(query, typeof args.limit === "number" ? args.limit : 10));
        } catch (e) {
          if (!localText) throw e;
          remote = `Recherche publique impossible : ${(e as Error).message}`;
        }
        return localText + remote;
      },
    },
    {
      name: "skill_hub_install",
      description:
        "Installe (ou met à jour) une skill publique après analyse de sécurité ; une skill jugée dangereuse est refusée. Examine-la d'abord avec skill_hub_search (inspect).",
      parameters: { type: "object", properties: { identifier: { type: "string" } }, required: ["identifier"] },
      dangerous: true,
      source: "skill",
      async run(args) {
        const r = await hub.install(String(args.identifier));
        return `Skill ${r.updated ? "mise à jour" : "installée"} : ${r.id} (${r.bundle.files.length} fichier(s)).\n${describeGuardReport(r.scan)}`;
      },
    },
  ];
}
