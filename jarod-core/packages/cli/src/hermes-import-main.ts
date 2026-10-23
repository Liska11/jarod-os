// `JAROD_HOME=<racine du profil> tsx src/hermes-import-main.ts [--dry-run | --apply] [--hermes-home <dossier>] [--also-skills <dossier>]…`
// Sans `--apply` (ou avec `--dry-run`) : simulation, rien n'est écrit. Avec `--apply` : sauvegarde de `jarod.db`, puis copie des skills et
// ajout des serveurs MCP (désactivés), et depuis V-15 : mémoire (MEMORY.md → faits, USER.md → préférences, sans doublon), persona
// (SOUL.md, seulement si Jarod n'en a pas), tâches planifiées (désactivées) et listes d'accès des bots (passerelles éteintes, jetons jamais copiés). L'application Jarod-OS doit être FERMÉE (la base est partagée). Le compte rendu ne contient aucune valeur secrète.
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openCore } from "./context.js";
import { importFromHermes } from "./hermes-import.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

if (!process.env.JAROD_HOME) {
  console.error("JAROD_HOME manquant (la racine du profil de Jarod-OS : %LOCALAPPDATA%\\Jarod-OS\\profile).");
  process.exit(2);
}
const hermesHome = flag("--hermes-home") ?? process.env.HERMES_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hermes");
if (!existsSync(join(hermesHome, "config.yaml")) && !existsSync(join(hermesHome, "skills"))) {
  console.error(`Aucun dossier Hermes à ${hermesHome}.`);
  process.exit(2);
}
const apply = args.includes("--apply");
if (apply && args.includes("--dry-run")) {
  console.error("--apply et --dry-run s'excluent.");
  process.exit(2);
}

const { core, dataDir } = await openCore({ env: process.env });
try {
  if (apply) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = join(dataDir, `jarod.db${suffix}`);
      if (existsSync(file)) copyFileSync(file, `${file}.avant-import-hermes`);
    }
  }
  const target = {
    settings: core.settings,
    skills: core.skills,
    memory: core.memory,
    ...(core.persona ? { persona: core.persona } : {}),
    scheduler: core.scheduler,
    bots: { get: (k: "telegram" | "discord" | "slack") => core.settings.get(k), set: (k: "telegram" | "discord" | "slack", v: Record<string, unknown>) => core.settings.set(k, v as never) },
  };
  const result = await importFromHermes(target as never, { hermesHome, extraSkillRoots: all("--also-skills"), apply });
  const verb = apply ? "copiés" : "à copier";
  console.log(`${apply ? "IMPORT" : "SIMULATION"} depuis ${hermesHome} vers ${dataDir}`);
  console.log(`Skills ${verb} : ${apply ? result.skills.copied : result.skills.copy.length} (désactivés : ${apply ? result.skills.disabled : result.skills.copy.length}) ; déjà présents : ${result.skills.present.length} ; doublons ignorés : ${result.skills.duplicates.length}`);
  for (const d of result.skills.duplicates) console.log(`  doublon ${d.rel} (identifiant ${d.id} déjà pris par ${d.keptFrom})`);
  console.log(`Serveurs MCP ${verb} : ${result.mcp.servers.length} (tous désactivés) : ${result.mcp.servers.map((s) => s.name).join(", ") || "—"}`);
  for (const s of result.mcp.skipped) console.log(`  ignoré ${s.name} : ${s.reason}`);
  for (const n of result.mcp.notes) console.log(`  ${n}`);
  const done = (planned: number, made: number) => (apply ? made : planned);
  if (result.memory) console.log(`Mémoire ${verb} : ${done(result.memory.add.length, result.memory.added)} (faits ${result.memory.add.filter((m) => m.type === "fact").length}, préférences ${result.memory.add.filter((m) => m.type === "preference").length}) ; déjà présentes : ${result.memory.present}`);
  if (result.persona) console.log(result.persona.action === "write" ? `Persona ${apply ? "écrite" : "à écrire"} depuis SOUL.md (${result.persona.chars} caractères)` : `Persona : ${result.persona.reason}`);
  if (result.cron) {
    console.log(`Tâches planifiées ${verb} : ${done(result.cron.add.length, result.cron.created)} (toutes désactivées) : ${result.cron.add.map((c) => c.name).join(", ") || "—"}`);
    for (const s of result.cron.skipped) console.log(`  ignorée ${s.name} : ${s.reason}`);
    for (const n of result.cron.notes) console.log(`  ${n}`);
  }
  if (result.bots) {
    console.log(`Listes d'accès des bots ${verb} : ${result.bots.allow.map((a) => `${a.gateway} (${a.ids.length})`).join(", ") || "—"} (passerelles laissées éteintes)`);
    for (const n of result.bots.notes) console.log(`  ${n}`);
  }
  if (!apply) console.log("Rien n'a été écrit. Relancer avec --apply (application fermée) pour importer.");
} finally {
  await core.dispose();
}
