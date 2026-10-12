/**
 * Décompte des skills d'un dossier tel que Jarod le charge (Q2) — ligne de STATE.md, promesse de
 * compatibilité Hermes. Usage : `node_modules/.bin/tsx scripts/skills-count.ts <dossier skills>`.
 *
 * Le registre réel (`SkillRegistry`) tourne sur une COPIE temporaire des seuls `SKILL.md` : la découverte
 * ne dépend que des dossiers et de ces fichiers, et le dossier compté n'est jamais écrit (pas de
 * `.manifest.json` déposé chez Hermes).
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { NotificationService, SettingsService } from "@jarod/plugin-storage";
import { SkillRegistry } from "../packages/plugins/skills/src/skills.js";

const source = process.argv[2];
if (!source) {
  console.error("usage : tsx scripts/skills-count.ts <dossier skills>");
  process.exit(2);
}
const root = resolve(source);
const copy = mkdtempSync(join(tmpdir(), "skills-count-"));
let files = 0;
const walk = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name === "SKILL.md") {
      const dest = join(copy, relative(root, full));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(full, dest);
      files++;
    }
  }
};
try {
  walk(root);
  const values: Record<string, unknown> = { disabledSkills: [], skillVersions: {} };
  const settings = { get: (k: string) => values[k], set: (k: string, v: unknown) => void (values[k] = v) };
  const notifications = { add: () => undefined };
  const registry = new SkillRegistry(
    copy,
    settings as unknown as SettingsService,
    notifications as unknown as NotificationService,
  );
  const skills = await registry.reload();
  const byCategory = new Map<string, number>();
  let flat = 0;
  let deep = 0;
  for (const s of skills) {
    const parts = relative(copy, dirname(s.path)).split(/[\\/]/);
    if (parts.length === 1) flat++;
    else byCategory.set(parts[0]!, (byCategory.get(parts[0]!) ?? 0) + 1);
    if (parts.length > 2) deep++;
  }
  const filed = skills.length - flat;
  const cats = [...byCategory].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, n]) => `${c} ${n}`);
  const clashes = registry.collisions();
  console.log(
    `${flat} plates + ${filed} rangées dans ${byCategory.size} catégories (${cats.join(", ")} ; dont ${deep} en sous-catégorie)` +
      ` = ${skills.length} chargées ; collisions ${clashes.length} ; SKILL.md non chargés ${files - skills.length}` +
      ` (dossiers « . », imbriqués ou en double) sur ${files}`,
  );
  for (const c of clashes) console.log(`  collision ${c.id} : ${c.kept} gardée, ${c.ignored.join(", ")} ignorée(s)`);
} finally {
  rmSync(copy, { recursive: true, force: true });
}
