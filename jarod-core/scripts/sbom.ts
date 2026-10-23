/**
 * G1 — Inventaire des composants (SBOM) du paquet Windows, par Syft, et comparaison de deux inventaires.
 *
 *   pnpm run sbom:scan                          # paquet ../apps/desktop/release/win-unpacked → dist/sbom/<horodatage>/
 *   pnpm run sbom:scan -- --app <dossier win-unpacked> --out <dossier>
 *   pnpm run sbom:scan -- --compare <avant/sbom.json> <après/sbom.json> [--scope paquet|depot]
 *
 * Deux inventaires SÉPARÉS (2026-10-21) : `sbom.json` = le PAQUET (ce que Syft lit dans win-unpacked et app.asar, plus BUNDLE.json) ;
 * `depot.sbom.json` = les déclarations de `engines.lock` (moteurs épinglés par le dépôt, non embarqués). La comparaison porte sur le paquet
 * par défaut ; un ancien inventaire qui mélangeait les deux est filtré par origine.
 * (`pnpm sbom` est une commande intégrée de pnpm, d'où le nom du script.)
 *
 * Syft : JAROD_SYFT, sinon engines/syft/syft.exe (voir engines.lock/README.md). Aucun réseau : la vérification de mise à jour est coupée.
 * Ce n'est PAS un scan de sécurité : le rapport liste ce qui est couvert, partiel, non couvert, et les défauts de paquet constatés.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleComponents,
  compareSboms,
  mergeComponents,
  packagedCoverage,
  runSyft,
  type SbomComponent,
  sbomReport,
  splitInventory,
} from "../packages/plugins/integrations/src/impl/sbom.js";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(CORE, "..");
const argv = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface JarodSbom {
  schema: "jarod-sbom/1";
  target: string;
  generatedAt: string;
  /** Absent dans les inventaires d'avant le 2026-10-21, qui mélangeaient paquet et dépôt (filtrés par origine à la comparaison). */
  scope?: "paquet" | "depot";
  tool: { name: string; version: string };
  components: SbomComponent[];
  coverage: ReturnType<typeof packagedCoverage>["coverage"];
}

function compare(a: string, b: string, scope: "paquet" | "depot"): void {
  const read = (f: string) => {
    const j = JSON.parse(readFileSync(f, "utf8")) as JarodSbom;
    if (j.schema !== "jarod-sbom/1") throw new Error(`${f} : pas un inventaire Jarod (schema jarod-sbom/1)`);
    return j;
  };
  const pick = (j: JarodSbom) => splitInventory(j.components)[scope];
  const before = read(a);
  const after = read(b);
  const [x, y] = [pick(before), pick(after)];
  const d = compareSboms(x, y);
  console.log(`Inventaire comparé : ${scope === "paquet" ? "le PAQUET (contenu réel)" : "le DÉPÔT (déclarations engines.lock, non embarquées)"}`);
  console.log(`Avant : ${x.length} composants (${before.generatedAt}) ; après : ${y.length} (${after.generatedAt})`);
  console.log(`Ajoutés (${d.added.length}) :`);
  for (const c of d.added) console.log(`  + ${c.ecosystem}/${c.name} ${c.version}`);
  console.log(`Retirés (${d.removed.length}) :`);
  for (const c of d.removed) console.log(`  - ${c.ecosystem}/${c.name} ${c.version}`);
  console.log(`Versions changées (${d.changed.length}) :`);
  for (const c of d.changed) console.log(`  ~ ${c.ecosystem}/${c.name} ${c.from} → ${c.to}`);
}

async function main(): Promise<void> {
  const cmpAt = argv.indexOf("--compare");
  if (cmpAt >= 0) {
    const [a, b] = [argv[cmpAt + 1], argv[cmpAt + 2]];
    if (!a || !b) throw new Error("usage : pnpm run sbom:scan -- --compare <avant/sbom.json> <après/sbom.json> [--scope paquet|depot]");
    const scope = opt("--scope") ?? "paquet";
    if (scope !== "paquet" && scope !== "depot") throw new Error("--scope : paquet ou depot");
    return compare(a, b, scope);
  }
  const syft = process.env.JAROD_SYFT ?? join(ROOT, "engines", "syft", "syft.exe");
  if (!existsSync(syft)) throw new Error(`Syft introuvable (${syft}) : voir jarod-core/engines.lock/README.md, ligne Syft`);
  const app = resolve(opt("--app") ?? join(ROOT, "apps", "desktop", "release", "win-unpacked"));
  if (!existsSync(app)) throw new Error(`paquet introuvable : ${app} (construire avec npm run dist:win, ou passer --app)`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(opt("--out") ?? join(CORE, "dist", "sbom", stamp));
  mkdirSync(out, { recursive: true });

  // app.asar : en-tête lu par @electron/asar (dépendance de electron-builder) ; extrait dans un dossier temporaire SEULEMENT s'il contient des manifestes.
  const asarFile = join(app, "resources", "app.asar");
  let asarEntries: string[] | null = null;
  let asarUnpacked: string[] | null = null;
  let asarDir: string | null = null;
  type AsarApi = { listPackage(f: string): string[]; statFile(f: string, p: string): { unpacked?: boolean }; extractFile(f: string, p: string): Buffer };
  let asar: AsarApi | null = null;
  try {
    asar = createRequire(join(ROOT, "apps", "desktop", "package.json"))("@electron/asar") as AsarApi;
  } catch {
    asar = null;
  }
  if (asar && existsSync(asarFile)) {
    asarEntries = asar.listPackage(asarFile);
    asarUnpacked = asarEntries.filter((e) => {
      try {
        return asar!.statFile(asarFile, e.replace(/^[\\/]+/, "")).unpacked === true;
      } catch {
        return false;
      }
    });
    // Seuls les manifestes EMPAQUETÉS sont extraits (Syft n'a besoin que d'eux) : un fichier « unpacked » manquant ne bloque pas l'inventaire,
    // il est signalé par la couverture.
    const manifests = asarEntries.filter((e) => /node_modules[\\/](@[^\\/]+[\\/])?[^\\/]+[\\/]package\.json$/.test(e) && !asarUnpacked!.includes(e));
    if (manifests.length) {
      asarDir = mkdtempSync(join(tmpdir(), "jarod-sbom-asar-"));
      for (const e of manifests) {
        const rel = e.replace(/^[\\/]+/, "");
        mkdirSync(dirname(join(asarDir, rel)), { recursive: true });
        writeFileSync(join(asarDir, rel), asar.extractFile(asarFile, rel));
      }
    }
  }

  const { coverage, bundle } = packagedCoverage(app, {
    exists: existsSync,
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    asarEntries,
    asarUnpacked,
  });

  try {
    const runs = [await runSyft({ syft, target: { label: "paquet", dir: app, origin: "syft", installed: true }, outFile: join(out, "paquet.cdx.json") })];
    if (asarDir) {
      const run = await runSyft({ syft, target: { label: "app.asar", dir: asarDir, origin: "syft", installed: true }, outFile: join(out, "app-asar.cdx.json") });
      // Le dossier d'extraction est temporaire (nom tiré au hasard) : ramené à « app.asar », sinon un composant nommé par son chemin
      // apparaîtrait ajouté ET retiré à chaque comparaison de deux inventaires.
      const stable = (s: string) => s.replace(/^.*?jarod-sbom-asar-[A-Za-z0-9]+/i, "app.asar");
      runs.push({ ...run, components: run.components.map((c) => ({ ...c, name: stable(c.name), locations: c.locations.map(stable) })) });
    }
    runs.push(await runSyft({ syft, target: { label: "engines.lock", dir: join(CORE, "engines.lock"), origin: "engines.lock" }, outFile: join(out, "engines-lock.cdx.json") }));
    const components = mergeComponents([...runs.map((r) => r.components), bundle ? bundleComponents(bundle) : []]);
    const generatedAt = new Date().toISOString();
    const { paquet, depot } = splitInventory(components);
    const doc: JarodSbom = { schema: "jarod-sbom/1", target: app, generatedAt, scope: "paquet", tool: runs[0]!.tool, components: paquet, coverage };
    writeFileSync(join(out, "sbom.json"), JSON.stringify(doc, null, 2));
    writeFileSync(join(out, "depot.sbom.json"), JSON.stringify({ ...doc, target: join(CORE, "engines.lock"), scope: "depot", components: depot, coverage: [] }, null, 2));
    const report = sbomReport({ ...doc, components });
    writeFileSync(join(out, "RAPPORT.md"), `${report}\n`);
    console.log(report);
    console.log(`\nÉcrit : ${join(out, "sbom.json")}`);
    if (coverage.some((c) => c.status === "defect")) process.exitCode = 3;
  } finally {
    if (asarDir) rmSync(asarDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`sbom : ${(e as Error).message}`);
  process.exit(1);
});
