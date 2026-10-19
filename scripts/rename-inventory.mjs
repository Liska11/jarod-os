#!/usr/bin/env node
// Inventaire du renommage Herald → Jarod (docs/RENAME-PLAN-JAROD-OS.md, phase 0). Lecture seule.
//
//   node scripts/rename-inventory.mjs            tableau par famille
//   node scripts/rename-inventory.mjs --json     même chose en JSON (sortie stable, triée)
//   node scripts/rename-inventory.mjs --files    occurrences de « herald » par fichier, triées par chemin
//
// Compte les fichiers suivis et à suivre (non ignorés), hors binaires (`git grep -I`). Les fichiers qui gardent
// volontairement le nom (attributions, historique, amont) sont comptés aussi : c'est `jarod-core/tests/repo/rename-baseline.json`
// qui dit ce qui reste permis, et `rename-guard.test.ts` qui l'impose.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** L'outillage du renommage nomme forcément l'ancien nom : il n'est jamais compté. */
export const TOOLING = ["scripts/rename-inventory.mjs", "scripts/rename-baseline.mjs", "jarod-core/tests/repo/rename-baseline.json", "jarod-core/tests/repo/rename-guard.test.ts"];

export const FAMILIES = [
  ["herald (toutes casses)", "-i", "herald"],
  ["herald-os", "", "herald-os"],
  ["HERALD_OS_* (variables)", "", "HERALD_OS_"],
  ["HERALD_* (hors HERALD_OS_)", "", "HERALD_[A-NP-Z]|HERALD_O[^S]"],
  ["heraldOS / HeraldOS (pont, types)", "", "[hH]eraldO[Ss]"],
  ["« Herald OS » (texte)", "", "Herald OS"],
  ["@herald-os/* (paquets)", "", "@herald-os/"],
  ["herald-os-bridge / herald_os (plugin Hermes)", "", "herald-os-bridge|herald_os"],
  ["herald-host-* / herald-supervise (Rust)", "", "herald-host-|herald-supervise"],
  ["persist:herald-* (partitions, gardées)", "", "persist:herald-"],
];

/** `git grep -c` (lecture seule) : { fichier: nombre de lignes }, {} si rien. */
export function countByFile(pattern, flags = "") {
  const args = ["grep", "-c", "-I", "--untracked", "-E", ...(flags ? [flags] : []), "-e", pattern, "--", ".", ...TOOLING.map((f) => `:(exclude)${f}`)];
  let out = "";
  try {
    out = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    if (e.status === 1) return {};
    throw e;
  }
  const map = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.lastIndexOf(":");
    if (i > 0) map[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function inventory() {
  return FAMILIES.map(([label, flags, pattern]) => {
    const files = countByFile(pattern, flags);
    return { family: label, lines: Object.values(files).reduce((s, n) => s + n, 0), files: Object.keys(files).length };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--files")) {
    for (const [f, n] of Object.entries(countByFile("herald", "-i"))) console.log(`${n}\t${f}`);
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(inventory(), null, 2));
  } else {
    for (const r of inventory()) console.log(`${String(r.lines).padStart(6)} lignes  ${String(r.files).padStart(4)} fichiers  ${r.family}`);
  }
}
