#!/usr/bin/env node
/**
 * Collecte des licences d'un ajout de dépendances (consigne B9/B10/B11 : « licences collectées, aucun
 * postinstall exécuté »). Compare deux lockfiles pnpm, et pour chaque paquet AJOUTÉ lit, dans le store
 * lié (`node_modules/.pnpm`), son `package.json` (licence, scripts d'installation) et son texte de licence.
 *
 *   node scripts/licenses.mjs --tag B9 --before .work/lock-before-b9.yaml
 *
 * Écrit `licenses/<tag>.md` (tableau + textes) et échoue (code 1) si un paquet ajouté déclare un script
 * `preinstall`/`install`/`postinstall` qui n'est pas explicitement listé dans `--allow-scripts a,b`
 * (pnpm n'exécute de toute façon que `allowBuilds` ; ici on le PROUVE et on le consigne).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split(/\s*--/)
    .filter(Boolean)
    .map((a) => {
      const [k, ...v] = a.split(" ");
      return [k, v.join(" ")];
    }),
);
if (!args.tag || !args.before) {
  console.error("usage : node scripts/licenses.mjs --tag <B9> --before <lockfile avant> [--allow-scripts a,b]");
  process.exit(2);
}

/**
 * Clés de la section `packages:` d'un lockfile pnpm 9+ : `nom@version` (sans suffixe de pairs). pnpm 12
 * écrit deux documents YAML (le premier pour ses propres dépendances de configuration) : le dernier compte.
 */
function lockPackages(file) {
  const text = readFileSync(file, "utf8");
  const start = text.lastIndexOf("\npackages:\n");
  const end = text.indexOf("\nsnapshots:\n", start);
  const out = new Set();
  for (const m of text.slice(start, end > 0 ? end : undefined).matchAll(/^ {2}'?((?:@[^/\s]+\/)?[^@\s']+)@([^\s'(:]+)'?:$/gm)) out.add(`${m[1]}@${m[2]}`);
  return out;
}

const before = lockPackages(join(ROOT, args.before));
const after = lockPackages(join(ROOT, "pnpm-lock.yaml"));
const added = [...after].filter((k) => !before.has(k)).sort();
const allowed = new Set((args["allow-scripts"] ?? "").split(",").filter(Boolean));

const store = join(ROOT, "node_modules", ".pnpm");
const storeDirs = readdirSync(store);
const INSTALL = ["preinstall", "install", "postinstall"];
const rows = [];
const texts = [];
const problems = [];
for (const key of added) {
  const at = key.lastIndexOf("@");
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  const prefix = `${name.replace("/", "+")}@${version}`;
  // Nom long : pnpm tronque et hache le dossier (`@babel+helper-module-transf_<hash>`) → on vérifie le
  // `package.json` (nom ET version) des dossiers candidats.
  const exact = storeDirs.find((d) => d === prefix || d.startsWith(`${prefix}_`));
  const stem = name.replace("/", "+").slice(0, 26);
  const pkgAt = (d) => join(store, d, "node_modules", name);
  const matches = (d) => {
    try {
      const p = JSON.parse(readFileSync(join(pkgAt(d), "package.json"), "utf8"));
      return p.name === name && p.version === version;
    } catch {
      return false;
    }
  };
  const dir = exact ?? storeDirs.find((d) => d.startsWith(stem) && /_[0-9a-f]{32}$/.test(d) && matches(d));
  const pkgDir = dir && pkgAt(dir);
  if (!pkgDir || !existsSync(join(pkgDir, "package.json"))) {
    // Paquet d'une autre plateforme (optionnel non installé ici) : consigné tel quel.
    rows.push({ name, version, license: "?", scripts: "?", note: "non installé sur cette machine" });
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(" OR ")) || "?";
  const scripts = INSTALL.filter((s) => pkg.scripts?.[s]);
  if (scripts.length && !allowed.has(name)) problems.push(`${key} : ${scripts.map((s) => `${s}=${pkg.scripts[s]}`).join(" ; ")}`);
  const file = readdirSync(pkgDir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  rows.push({ name, version, license, scripts: scripts.join(", ") || "aucun", note: file ?? "pas de fichier de licence" });
  if (file) texts.push(`### ${key}\n\n\`\`\`\n${readFileSync(join(pkgDir, file), "utf8").trim()}\n\`\`\`\n`);
}

const byLicense = rows.reduce((m, r) => ((m[r.license] = (m[r.license] ?? 0) + 1), m), {});
const md = [
  `# Licences — ajout ${args.tag}`,
  "",
  `Généré par \`scripts/licenses.mjs\` (lockfile avant : \`${args.before}\`). ${rows.length} paquets ajoutés : ${Object.entries(byLicense)
    .map(([l, n]) => `${l} × ${n}`)
    .join(", ")}.`,
  "Scripts d'installation : colonne « scripts » (aucun n'est exécuté : `--ignore-scripts`, et pnpm ne construit que `allowBuilds`).",
  "",
  "| Paquet | Version | Licence | Scripts d'installation | Fichier |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| \`${r.name}\` | ${r.version} | ${r.license} | ${r.scripts} | ${r.note} |`),
  "",
  "## Textes",
  "",
  ...texts,
].join("\n");
mkdirSync(join(ROOT, "licenses"), { recursive: true });
writeFileSync(join(ROOT, "licenses", `${args.tag}.md`), md);
console.log(`${rows.length} paquets ajoutés → licenses/${args.tag}.md ; ${JSON.stringify(byLicense)}`);
if (problems.length) {
  console.error(`scripts d'installation non autorisés :\n${problems.join("\n")}`);
  process.exit(1);
}
