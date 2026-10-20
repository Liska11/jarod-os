#!/usr/bin/env node
// Cockpit, lots 3 et 5 : embarque des skills sous licence MIT dans le code, à un commit épinglé.
//
//   node scripts/import-bundled-skills.mjs mattpocock <clone de mattpocock/skills>
//   node scripts/import-bundled-skills.mjs diagram-design <clone de cathrynlavery/diagram-design>
//
// Le clone doit être au commit épinglé du lot : le script refuse sinon. Il écrit jarod-core/packages/plugins/skills/src/bundled/<lot>.ts :
// le texte d'origine des fichiers retenus, et une NOTE D'ADAPTATION Jarod en tête de chaque SKILL.md (outils de Jarod, aucune
// publication externe sans accord). Les scripts et fichiers propres à d'autres agents ne sont pas repris. Reproductible.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMON =
  "Note d'adaptation Jarod-OS : le texte ci-dessous est celui d'origine, en anglais. Dans Jarod, « Skill tool » = load_skill (et " +
  "read_skill_file pour les fichiers voisins) ; « sub-agents » = delegate_task ou spawn_subagent ; les commandes passent par run_shell, " +
  "avec l'accord prévu. Les règles du système de Jarod priment sur ce texte.";

const PACKS = {
  mattpocock: {
    constName: "MATTPOCOCK",
    repo: "mattpocock/skills",
    commit: "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    copyright: "© 2026 Matt Pocock",
    skills: {
      "diagnosing-bugs": { dir: "skills/engineering/diagnosing-bugs", note: "Le script hitl-loop du dépôt d'origine n'est pas repris : les boucles de reproduction passent par run_shell." },
      tdd: { dir: "skills/engineering/tdd" },
      "code-review": { dir: "skills/engineering/code-review", note: "Les deux relectures (Standards, Spec) peuvent être confiées à deux sous-agents en lecture seule (delegate_task) ou faites l'une après l'autre." },
      "codebase-design": { dir: "skills/engineering/codebase-design" },
      "to-spec": { dir: "skills/engineering/to-spec", note: "Dans Jarod, la spécification est écrite dans un FICHIER LOCAL du dossier de travail (write_file). Rien n'est publié dans un gestionnaire de tickets ni envoyé ailleurs sans l'accord explicite de l'utilisateur ; ignorer la mention de /setup-matt-pocock-skills." },
      handoff: { dir: "skills/productivity/handoff", note: "Dans Jarod, le document de passation est écrit avec write_file dans le dossier de travail (ou celui que l'utilisateur nomme) ; la section « suggested skills » nomme des skills à charger avec load_skill." },
    },
    include: (rel) => /^[^/]+\.md$/.test(rel),
  },
  "diagram-design": {
    constName: "DIAGRAM_DESIGN",
    repo: "cathrynlavery/diagram-design",
    commit: "47620270fc671a078fdbb06f91a4d7e7b9499333",
    copyright: "© 2025 Cathryn Lavery",
    skills: {
      "diagram-design": {
        dir: "skills/diagram-design",
        note:
          "Dans Jarod : écrire le diagramme (un seul fichier .html, SVG en ligne) dans le dossier de travail avec write_file, puis l'ENREGISTRER comme artefact avec artifact_register (kind=diagram, en gardant la source .html modifiable) — il s'affiche alors dans Réglages › Artefacts. " +
          "L'export SVG passe par diagram_export ; l'export PNG et les scripts Python du dépôt d'origine (self_check, verify-*, *_extract, export_*) ne sont pas disponibles ici : le dire si on le demande. " +
          "Un diagramme d'architecture se fonde sur ce qui a été LU dans le projet (list_dir, read_file, search_files) : une hypothèse est marquée comme telle, jamais dessinée comme un composant confirmé. L'onboarding depuis un site web demande web_fetch, avec l'accord prévu.",
      },
    },
    include: (rel) => rel === "SKILL.md" || /^references\/[^/]+\.md$/.test(rel) || /^assets\/(template[\w-]*|icons)\.html$/.test(rel),
  },
};

const [packId, cloneArg] = process.argv.slice(2);
const pack = PACKS[packId];
if (!pack || !cloneArg) {
  console.error(`usage : import-bundled-skills.mjs <${Object.keys(PACKS).join("|")}> <clone>`);
  process.exit(2);
}
const clone = resolve(cloneArg);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
if (head !== pack.commit) {
  console.error(`le clone est au commit ${head}, attendu ${pack.commit}`);
  process.exit(1);
}
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const license = readFileSync(join(clone, "LICENSE"), "utf8").replace(/\r\n/g, "\n");
const skills = {};
for (const [id, def] of Object.entries(pack.skills)) {
  const dir = join(clone, def.dir);
  const files = {};
  for (const abs of walk(dir).sort()) {
    const rel = relative(dir, abs).split("\\").join("/");
    if (!pack.include(rel)) continue;
    let text = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    if (rel === "SKILL.md") {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      if (!m) throw new Error(`${id} : pas d'en-tête`);
      const meta = m[1].replace(/^version:.*$/m, "").trimEnd();
      const note = [`${COMMON} (${pack.repo}, MIT, commit ${pack.commit.slice(0, 7)})`, def.note].filter(Boolean).join("\n\n");
      text = `---\n${meta}\nversion: 0.0.0+${pack.commit.slice(0, 7)}\n---\n> ${note.replace(/\n\n/g, "\n>\n> ")}\n\n${text.slice(m[0].length)}`;
    }
    files[rel] = text;
  }
  skills[id] = { origin: def.dir, files };
}
const out = resolve(dirname(fileURLToPath(import.meta.url)), `../jarod-core/packages/plugins/skills/src/bundled/${packId}.ts`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `// GÉNÉRÉ par scripts/import-bundled-skills.mjs — ne pas modifier à la main.\n` +
    `// ${pack.repo} (MIT, ${pack.copyright}) au commit ${pack.commit}, avec une note d'adaptation Jarod-OS en tête de chaque SKILL.md.\n` +
    `import type { BundledPack } from "./types.js";\n\n` +
    `export const ${pack.constName}: BundledPack = ${JSON.stringify({ pack: packId, repo: pack.repo, commit: pack.commit, license: "MIT", licenseText: license, skills }, null, 2)};\n`,
);
console.log(`${packId} : ${Object.keys(skills).length} skill(s), ${Object.values(skills).reduce((n, s) => n + Object.keys(s.files).length, 0)} fichiers → ${out}`);
