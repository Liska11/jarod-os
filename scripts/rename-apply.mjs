#!/usr/bin/env node
// Applique UNE phase du renommage Herald -> Jarod (docs/RENAME-PLAN-JAROD-OS.md). Reproductible : la phase est décrite ici.
//
//   node scripts/rename-apply.mjs <phase>          essai à blanc : fichiers et nombre de remplacements, rien d'écrit
//   node scripts/rename-apply.mjs <phase> --write  écrit
//
// Ne touche jamais aux chemins de scripts/rename-history.json (attributions, historique, amont, outillage), ni aux fichiers
// qu'une phase traite à la main (`manual`). Préserve les fins de ligne (seuls les jetons changent). Fichiers suivis et à suivre.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const history = JSON.parse(readFileSync(resolve(root, "scripts/rename-history.json"), "utf8")).paths;

export const PHASES = {
  // Phase 2 (famille A). HERALD_OS_DEV_UNSIGNED est figé par le contrat c8 (renommer un nom de variable d'un contrat v1 est une v2) :
  // il garde son nom partout. Les fichiers `manual` gardent l'ancien nom À CÔTÉ du nouveau (listes de retrait, contrat c5, tests du repli).
  env: {
    // Appliquée au commit 767c73d ; les lignes de compatibilité ajoutées ensuite nomment volontairement l'ancien préfixe.
    applied: "767c73d",
    rules: [[/HERALD_OS_(?!DEV_UNSIGNED)/g, "JAROD_OS_"]],
    manual: [
      "contracts/v1/c5-control-env-names.schema.json",
      "contracts/v1/fixtures/c5-control-env-names/",
      "plugins/herald-os-bridge/bridge/util.py",
      "host-rust/crates/host-supervisor/tests/children.rs",
      "host-rust/crates/host-control/src/contracts.rs",
      "host-rust/crates/host-control/tests/contracts_env.rs",
      "apps/desktop/electron/legacy-env-adopt.ts",
      "jarod-core/packages/kernel/src/legacy-env-adopt.ts",
      "apps/desktop/shared/legacy-env.ts",
      "apps/desktop/shared/legacy-env.test.ts",
      "jarod-core/packages/kernel/src/legacy-env.ts",
      "jarod-core/packages/kernel/test/legacy-env.test.ts",
    ],
  },

  // Dernière phase, Windows : les identifiants internes du shell (pont preload `window.heraldOS`, types, fonctions, canaux IPC
  // `herald-os:*`). Identifiants EXACTS, jamais le mot « herald » : `herald-os` nu (commande Linux, dossier du socket c1, données),
  // `herald-os-bridge` (dossier partagé avec Linux), `herald_os` (boîte à outils), `herald-plugin`, `HERALD_OS_*`, `HERALD_EVENT`
  // et `HERALD_SANDBOX_BIN` (lectures de repli) ne sont pas touchés. Linux est hors périmètre : seuls ces dossiers sont parcourus.
  ids: {
    // Appliquée par le commit de la dernière phase (2026-10-20) ; ce qui reste ensuite est voulu (lectures de repli, Linux).
    applied: "dernière phase",
    only: ["apps/desktop/", "jarod-core/packages/", "packages/", "mobile/", "pinokio-runtime/", "plugins/herald-os-bridge/", "docs/", "README.md", "README-WINDOWS.md"],
    rules: [
      [/\b__heraldOS(Booted)?\b/g, (_m, booted) => `__jarodOS${booted ?? ""}`],
      [/\bheraldOS\b/g, "jarodOS"],
      [/\bHeraldOS(?=[A-Z]|\b)/g, "JarodOS"],
      [/\bheraldOs(?=[A-Z]|\b)/g, "jarodOs"],
      [/\bHeraldOs(?=[A-Z]|\b)/g, "JarodOs"],
      [/\b(run|shell)HeraldOs/g, (_m, head) => `${head}JarodOs`],
      [/\bHerald(EventName|Event|Logo|PipeSecurity|TokenSecurity|Panel)\b/g, (_m, tail) => `Jarod${tail}`],
      [/\bheraldActiveProvider\b/g, "jarodActiveProvider"],
      [/\bHERALD_(EVENT_NAMES|EVENTS|SKIN)\b/g, (_m, tail) => `JAROD_${tail}`],
      // Canaux IPC entre le processus principal et la fenêtre (même build) : `'herald-os:backend:rest'` → `'jarod-os:backend:rest'`.
      [/(['"`])herald-os:(?=[a-z])/g, (_m, quote) => `${quote}jarod-os:`],
      // Le composant du logo et l'icône de la marque (fichiers renommés à la main, avec git mv).
      [/\bherald-logo\b/g, "jarod-logo"],
      [/\bherald-icon\.png\b/g, "jarod-icon.png"],
    ],
    manual: ["apps/desktop/src/lib/legacy-storage.ts", "apps/desktop/src/lib/legacy-storage.test.ts"],
  },
};

const covered = (file, list) => list.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));

export function plan(phase) {
  const def = PHASES[phase];
  if (!def) throw new Error(`phase inconnue : ${phase} (connues : ${Object.keys(PHASES).join(", ")})`);
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter((f) => f && !covered(f, history) && !covered(f, def.manual ?? []) && (!def.only || covered(f, def.only)));
  const out = [];
  for (const f of files) {
    let text;
    try {
      const buf = readFileSync(resolve(root, f));
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    let count = 0;
    // `to` est une chaîne fixe ou une fonction (pour les règles à groupes) ; le compte suit chaque remplacement.
    const applyRaw = (s) => def.rules.reduce((t, [re, to]) => t.replace(re, (...m) => (count++, typeof to === "function" ? to(...m) : to)), s);
    // Portions protégées remplacées par des jetons opaques le temps des règles, puis remises à l'identique.
    const applyRules = (s) => {
      if (!def.protect) return applyRaw(s);
      const kept = [];
      const masked = def.protect.reduce((t, re) => t.replace(re, (m) => `\u0000${kept.push(m) - 1}\u0000`), s);
      return applyRaw(masked).replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
    };
    let next;
    if (def.skipLine) {
      // Lignes protégées (données de l'utilisateur, contrats figés, héritage) : laissées telles quelles, relevées si une règle y aurait joué.
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      next = text
        .split(eol)
        .map((line, i) => {
          if (!def.skipLine.test(line)) return applyRules(line);
          if (def.rules.some(([re]) => new RegExp(re.source, re.flags.replace("g", "")).test(line))) skipped.push(`${f}:${i + 1}: ${line.trim().slice(0, 150)}`);
          return line;
        })
        .join(eol);
    } else {
      next = applyRules(text);
    }
    if (count) out.push({ file: f, count, next });
  }
  return out;
}

/** Les lignes protégées où une règle aurait joué, relevées par le dernier `plan` : à relire à la main. */
export const skipped = [];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2];
  const write = process.argv.includes("--write");
  if (write && PHASES[phase]?.applied) {
    console.error(`la phase « ${phase} » est déjà appliquée (${PHASES[phase].applied}) : la relancer effacerait les lignes de compatibilité ajoutées depuis`);
    process.exit(1);
  }
  const changes = plan(phase);
  for (const c of changes) {
    if (write) writeFileSync(resolve(root, c.file), c.next);
    console.log(`${String(c.count).padStart(4)}  ${c.file}`);
  }
  console.log(`${write ? "écrit" : "à blanc"} : ${changes.length} fichiers, ${changes.reduce((s, c) => s + c.count, 0)} remplacements`);
  if (skipped.length && process.argv.includes("--skipped")) for (const s of skipped) console.log(`  protégée  ${s}`);
  if (skipped.length) console.log(`${skipped.length} ligne(s) protégée(s) où une règle aurait joué (--skipped pour les lister)`);
}
