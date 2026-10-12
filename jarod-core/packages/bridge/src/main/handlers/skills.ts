/**
 * Skills installées, sur le `SkillRegistry` (plugin-skills, via `agent.skills`).
 * Sources : SANK-UI `src/main/skills.ts:76-116` (`{ name, category, description, path }`, `path` = dossier
 * de la skill, catégorie = dossier parent) et `:167-180` (`getSkillContent` : `<path>/SKILL.md` si le
 * fichier est une skill autorisée, "" sinon) — rév. 3aaadb0, MIT © github.com/fathah.
 *
 * `get-skill-content` ne lit JAMAIS un chemin fourni par le renderer : le chemin doit être celui d'une
 * skill du registre, et c'est le fichier du registre qui est lu.
 */
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { assertProfile, type HandlerContext } from "./context.js";

export function createSkillsHandlers(ctx: HandlerContext) {
  const skills = () => ctx.kernel().agent.skills;
  /** Catégorie Hermes = dossier(s) entre la racine des skills et le dossier de la skill ("" si à plat). */
  const categoryOf = (folder: string) => {
    const rel = relative(skills().dir, dirname(folder)).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : "";
  };

  return {
    "list-installed-skills": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return skills()
        .list()
        .map((s) => {
          const folder = dirname(s.path);
          // `id` + `enabled` : ADDITIFS (SPECS-P5-DISABLED-SKILLS DS5) — l'écran a besoin de
          // l'identifiant pour écrire `disabledSkills` et de l'état pour rendre le basculeur.
          return { id: s.id, name: s.name, category: categoryOf(folder), description: s.description, path: folder, enabled: s.enabled };
        });
    },
    "get-skill-content": async (skillPath: unknown): Promise<string> => {
      if (typeof skillPath !== "string" || !skillPath.trim()) return "";
      const wanted = resolve(skillPath);
      const skill = skills()
        .list()
        .find((s) => resolve(dirname(s.path)) === wanted);
      if (!skill) return "";
      try {
        return await readFile(skill.path, "utf8");
      } catch {
        return "";
      }
    },
    /**
     * D1(b) — `skills.ts:233-236` : skills livrées avec le dépôt Hermes (`<repo>/skills`), `[]` sans ce dossier.
     * Jarod pose ses skills livrées dans le dossier du profil au démarrage (graines, plugin-skills) : elles sont
     * déjà dans `list-installed-skills`. Même réponse que SANK-UI sans dépôt : `[]`.
     */
    "list-bundled-skills": (): never[] => [],
    /**
     * `registry.ts:208-234` (`listInstalledRegistry`) : noms des skills installées et des serveurs MCP (réglage
     * `mcpServers`) ; `workflows` vide — les workflows de Jarod (plugin-workflows, base) ne s'installent pas depuis
     * le registre.
     */
    "registry-list-installed": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return {
        skills: skills()
          .list()
          .map((s) => s.name),
        mcps: ctx
          .kernel()
          .agent.settings.get("mcpServers")
          .map((m) => m.name),
        workflows: [] as string[],
      };
    },
  };
}
