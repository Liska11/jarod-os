#!/usr/bin/env node
// Abaisse `jarod-core/tests/repo/rename-baseline.json` après une phase du renommage (docs/RENAME-PLAN-JAROD-OS.md).
// Refuse d'écrire si un fichier compte plus de lignes « herald » qu'avant, ou si un fichier nouveau en contient :
// le cliquet ne fait que baisser. `--allow <chemin>` autorise une hausse nommée (un document d'exception), une par option.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countByFile } from "./rename-inventory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(root, "jarod-core/tests/repo/rename-baseline.json");
const allow = new Set(process.argv.flatMap((a, i, all) => (a === "--allow" && all[i + 1] ? [all[i + 1]] : [])));

const before = JSON.parse(readFileSync(file, "utf8"));
const now = countByFile("herald", "-i");
delete now["jarod-core/tests/repo/rename-baseline.json"];
delete now["jarod-core/tests/repo/rename-guard.test.ts"];
delete now["scripts/rename-baseline.mjs"];

const raised = Object.entries(now).filter(([f, n]) => n > (before[f] ?? 0) && !allow.has(f));
if (raised.length) {
  console.error("Le cliquet ne fait que baisser ; ces fichiers montent :");
  for (const [f, n] of raised) console.error(`  ${f} : ${before[f] ?? 0} -> ${n}`);
  process.exit(1);
}
const sum = (m) => Object.values(m).reduce((s, n) => s + n, 0);
writeFileSync(file, `${JSON.stringify(now, null, 1)}\n`);
console.log(`baseline : ${Object.keys(before).length} fichiers / ${sum(before)} lignes -> ${Object.keys(now).length} fichiers / ${sum(now)} lignes`);
