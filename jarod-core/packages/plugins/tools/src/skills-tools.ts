// Portage de packages/core/src/tools/skills.ts (rév. 2e180305).
import { MAX_SKILL_BODY, type SkillRegistry, skillId } from "@jarod/plugin-skills";
import type { ToolDef } from "./registry.js";

/** What the curator counts (optional: the tools work without it). */
export interface SkillUsageSink {
  recordUse(id: string): void;
  recordPatch(id: string): void;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Skills as procedural memory: `load_skill` reads one, `skill_manage` lets the agent write down a
 * procedure it just worked out (create), refine it after using it (update / patch) or retire it
 * (archive, never a deletion). `skill_manage` is `dangerous`: a skill lands in every future
 * system prompt, so writing one goes through the approval gate and is hidden in plan mode.
 */
export function skillTools(skills: SkillRegistry, usage?: SkillUsageSink): ToolDef[] {
  return [
    {
      name: "load_skill",
      description: "Charge les instructions complètes d'une skill (voir la liste des skills disponibles).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      source: "skill",
      run: async (args) => {
        const skill = skills.get(String(args.id));
        if (!skill?.enabled) throw new Error(`Skill introuvable ou désactivée : ${String(args.id)}`);
        usage?.recordUse(skill.id);
        const files = await skills.files(skill.id, 60);
        if (!files.length) return `# ${skill.name}\n\n${skill.body}`;
        return `# ${skill.name}\n\n${skill.body}\n\n---\n## Fichiers de la skill\nDossier : ${skills.folder(skill.id)}\n${files.map((f) => `- ${f}`).join("\n")}\n\nLis-les avec read_skill_file. Un script se lance avec run_shell en chemin absolu (depuis ce dossier).`;
      },
    },
    {
      name: "read_skill_file",
      description:
        "Lit un fichier joint d'une skill (script, référence, modèle) listé par load_skill. Lecture seule, limitée au dossier de la skill.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string", description: "Chemin relatif, ex. scripts/fill.py" },
        },
        required: ["id", "path"],
      },
      source: "skill",
      run: async (args) => {
        const skill = skills.get(String(args.id));
        if (!skill?.enabled) throw new Error(`Skill introuvable ou désactivée : ${String(args.id)}`);
        return skills.readFile(skill.id, String(args.path));
      },
    },
    {
      name: "skill_manage",
      description:
        "Gère ta mémoire procédurale (skills). `create` : enregistre une procédure réutilisable que tu viens de mettre au point (étapes, pièges, vérification). `update` : réécrit le nom, la description ou les instructions. `patch` : remplace un passage exact des instructions (old_text → new_text). `archive` : retire une skill obsolète (récupérable). Ne crée une skill que pour une méthode qui resservira, pas pour un fait ponctuel (utilise memory_save).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "patch", "archive"] },
          id: { type: "string", description: "Identifiant court en kebab-case, ex. deploy-vps" },
          name: { type: "string" },
          description: { type: "string", description: "Une phrase : quand utiliser cette skill." },
          body: {
            type: "string",
            description: `Instructions en Markdown (max ${MAX_SKILL_BODY} caractères) : quand l'utiliser, procédure, pièges, vérification.`,
          },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["action", "id"],
      },
      dangerous: true,
      source: "skill",
      run: async (args) => {
        const action = String(args.action);
        const id = skillId(String(args.id));
        if (!id) throw new Error("Identifiant de skill invalide.");
        switch (action) {
          case "create": {
            const body = str(args.body);
            const description = str(args.description);
            if (!body?.trim() || !description?.trim()) {
              throw new Error("create demande au moins `description` et `body`.");
            }
            const s = await skills.create(id, str(args.name) ?? id, description, body, {
              author: "agent",
              overwrite: false,
            });
            return `Skill créée : ${s.id} (v${s.version}). Elle apparaîtra dans la liste des skills des prochaines conversations.`;
          }
          case "update": {
            const patch = { name: str(args.name), description: str(args.description), body: str(args.body) };
            if (Object.values(patch).every((v) => v === undefined)) {
              throw new Error("update demande au moins un champ : name, description ou body.");
            }
            const s = await skills.update(
              id,
              Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
            );
            usage?.recordPatch(s.id);
            return `Skill mise à jour : ${s.id} (v${s.version}).`;
          }
          case "patch": {
            const s = await skills.patchBody(id, str(args.old_text) ?? "", str(args.new_text) ?? "");
            usage?.recordPatch(s.id);
            return `Skill corrigée : ${s.id} (v${s.version}).`;
          }
          case "archive":
            await skills.archive(id);
            return `Skill archivée : ${id} (récupérable dans le dossier des skills, sous .archive).`;
          default:
            throw new Error(`Action inconnue : ${action}`);
        }
      },
    },
  ];
}
