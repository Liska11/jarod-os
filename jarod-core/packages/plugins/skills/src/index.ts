/**
 * @jarod/plugin-skills — `ctx.skills` : registre des skills `<dataDir>/skills/<id>/SKILL.md`, à plat ou
 * rangées par catégorie comme Hermes (`skills/<catégorie>/<id>/`, Q2 : découverte récursive + cache
 * `.manifest.json`) ; dataDir identique à Jarod-One. Câblage `core.ts:359,656-660`.
 */
import { join } from "node:path";
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { SkillRegistry } from "./skills.js";
import { SkillsHubService } from "./skills-hub.js";

export * from "./skills.js";
export * from "./skills-hub.js";

declare module "cordis" {
  interface Context {
    skills: SkillRegistry;
    skillsHub: SkillsHubService;
  }
}

export const name = "skills";
// V-07 : la quarantaine (ordre 34, chargée avant) admet chaque fichier d'une skill publique ; absente = installation refusée.
export const inject = { storage: { required: true }, quarantine: { required: false } };

/** Asynchrone : le kernel n'est prêt qu'une fois les skills chargées (un effet async n'est pas attendu). */
export async function apply(ctx: Context, config: { seed?: boolean } = {}): Promise<void> {
  const { dataDir, settings, notifications } = ctx.storage;
  const skills = new SkillRegistry(join(dataDir, "skills"), settings, notifications);
  // `init()` : exemples au premier lancement, puis chargement (core.ts:657,660). Le CLI, qui
  // n'appelait pas `init()`, ne sème pas (`seed: false`) : il recharge seulement (cli main.ts:127).
  if (config?.seed !== false) await skills.seed();
  await skills.reload();
  ctx.provide("skills", skills);
  // SPECS-P5-DISABLED-SKILLS Q3/DS3 : l'écriture du réglage s'applique AU MÊME TICK (synchrone),
  // sans redémarrage ni rechargement de fichiers. L'abonnement vit avec le plugin.
  ctx.effect(() => settings.onChange("disabledSkills", () => skills.applyDisabled()), "skills:disabledSkills");
  // core.ts:574-577
  ctx.provide(
    "skillsHub",
    new SkillsHubService({
      skills,
      githubToken: () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
      admit: (data, label, provenance) => {
        const quarantine = ctx.get("quarantine") as unknown as { admitBytes?: (d: Buffer, l: string, p: { source: string; url?: string }) => { admitted: boolean; reason?: string } } | undefined;
        return quarantine?.admitBytes ? quarantine.admitBytes(data, label, provenance) : { admitted: false, reason: "la quarantaine n'est pas chargée" };
      },
    }),
  );
}
