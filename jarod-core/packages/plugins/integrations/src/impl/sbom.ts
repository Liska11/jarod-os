/**
 * G1 — Inventaire des composants (SBOM) des artefacts RÉELLEMENT distribués, par Syft (anchore/syft), plus ce que Syft ne peut pas voir.
 *
 * Ce que ce module garantit, et ce qu'il ne prétend pas :
 *  - Syft lit les fichiers du paquet (`win-unpacked`) : binaires Windows, manifestes npm/pip présents. Il NE VOIT PAS le code groupé par
 *    esbuild (la passerelle `gateway.mjs`, le main et le renderer) : ces dépendances viennent de la liste écrite au moment du groupage
 *    (`BUNDLE.json` → `packages`), marquées `origin: "bundle"` ; sans cette liste, la couverture le dit (`not-covered`).
 *  - Les moteurs gérés hors paquet (`engines/`, recréés depuis `jarod-core/engines.lock/`) sont inventoriés à part (`origin: "engines.lock"`)
 *    à partir des fichiers d'épinglage : c'est ce qui est DÉCLARÉ, pas une preuve qu'ils sont installés.
 *  - Un SBOM n'est PAS un scan de sécurité : aucune vulnérabilité n'est cherchée ici ; la couverture liste ce qui manque.
 *  - Les modules natifs déclarés (BUNDLE.json, asarUnpack) sont cherchés sur le disque du paquet : un module déclaré mais absent est un défaut
 *    du paquet, signalé comme tel.
 *
 * Syft est lancé sans shell, avec un délai, la vérification de mise à jour coupée (`SYFT_CHECK_FOR_APP_UPDATE=false`) : aucune sortie réseau.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "@jarod/kernel/child-env";

export type ComponentOrigin = "syft" | "bundle" | "engines.lock";

export interface SbomComponent {
  name: string;
  version: string;
  /** `library`, `application`, `file`… (CycloneDX). */
  type: string;
  /** Écosystème lu dans le purl (`npm`, `pypi`, `golang`…) ou `binary`. */
  ecosystem: string;
  purl?: string;
  licenses: string[];
  /** Emplacements relatifs à la cible (preuve de présence) ; vide pour un composant déclaré. */
  locations: string[];
  origin: ComponentOrigin;
}

export type CoverageStatus = "covered" | "partial" | "not-covered" | "defect";

export interface CoverageItem {
  what: string;
  status: CoverageStatus;
  why: string;
}

export interface SyftTarget {
  /** Libellé lisible (`paquet`, `app.asar`, `engines.lock`). */
  label: string;
  dir: string;
  origin: ComponentOrigin;
  /**
   * Paquets INSTALLÉS (node_modules/<x>/package.json) : en mode dossier, Syft ne lit par défaut que les fichiers de verrouillage ; ce drapeau
   * ajoute le catalogueur des paquets installés (mesuré sur Syft 1.54.1 : sans lui, « No packages discovered »).
   */
  installed?: boolean;
}

export interface SyftRun {
  /** Fichier CycloneDX JSON écrit par Syft. */
  file: string;
  tool: { name: string; version: string };
  components: SbomComponent[];
}

export class SbomError extends Error {}

const SYFT_ENV = { SYFT_CHECK_FOR_APP_UPDATE: "false", DO_NOT_TRACK: "1" };

/** Lance `syft scan dir:<cible> -o cyclonedx-json=<sortie>`. Annulable ; une erreur de Syft lève `SbomError` avec sa sortie d'erreur tronquée. */
export function runSyft(opts: { syft: string; target: SyftTarget; outFile: string; timeoutMs?: number; signal?: AbortSignal }): Promise<SyftRun> {
  const { syft, target, outFile } = opts;
  if (!existsSync(syft)) return Promise.reject(new SbomError(`Syft introuvable : ${syft}`));
  if (!existsSync(target.dir)) return Promise.reject(new SbomError(`cible introuvable : ${target.dir}`));
  return new Promise((resolve, reject) => {
    execFile(
      syft,
      ["scan", `dir:${target.dir}`, "-o", `cyclonedx-json=${outFile}`, "-q", ...(target.installed ? ["--select-catalogers", "+javascript-package-cataloger"] : [])],
      { timeout: opts.timeoutMs ?? 300_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: childEnv("engine", { explicit: SYFT_ENV }), ...(opts.signal ? { signal: opts.signal } : {}) },
      (err, _stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.name === "AbortError") return reject(new SbomError("inventaire annulé"));
          if (e.killed) return reject(new SbomError(`Syft sans réponse dans le délai (${target.label})`));
          return reject(new SbomError(`Syft a échoué sur ${target.label} : ${String(stderr || e.message).slice(0, 600)}`));
        }
        try {
          const doc = JSON.parse(readFileSync(outFile, "utf8")) as CycloneDx;
          resolve({ file: outFile, tool: syftTool(doc), components: parseCycloneDx(doc, target.origin) });
        } catch (parseErr) {
          reject(new SbomError(`sortie de Syft illisible (${target.label}) : ${(parseErr as Error).message}`));
        }
      },
    );
  });
}

interface CycloneDx {
  bomFormat?: string;
  metadata?: { tools?: { components?: { name?: string; version?: string }[] } | { name?: string; version?: string }[] };
  components?: {
    name?: string;
    version?: string;
    type?: string;
    purl?: string;
    licenses?: { license?: { id?: string; name?: string }; expression?: string }[];
    properties?: { name?: string; value?: string }[];
  }[];
}

function syftTool(doc: CycloneDx): { name: string; version: string } {
  const t = doc.metadata?.tools;
  const list = Array.isArray(t) ? t : (t?.components ?? []);
  const syft = list.find((x) => x.name === "syft") ?? list[0];
  return { name: syft?.name ?? "inconnu", version: syft?.version ?? "inconnue" };
}

/** Écosystème d'un purl : `pkg:npm/x@1` → `npm`. */
export function ecosystemOf(purl: string | undefined, type: string): string {
  const m = purl ? /^pkg:([a-z0-9.+-]+)\//i.exec(purl) : null;
  if (m) return m[1]!.toLowerCase();
  return type === "file" || type === "application" ? "binary" : "unknown";
}

export function parseCycloneDx(doc: CycloneDx, origin: ComponentOrigin): SbomComponent[] {
  if (doc.bomFormat !== "CycloneDX") throw new SbomError("document non CycloneDX");
  return (doc.components ?? []).map((c) => {
    const type = c.type ?? "library";
    const licenses = (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? "").filter(Boolean);
    const locations = (c.properties ?? []).filter((p) => /:location:\d+:path$/.test(p.name ?? "")).map((p) => String(p.value));
    return {
      name: c.name ?? "(sans nom)",
      version: c.version ?? "",
      type,
      ecosystem: ecosystemOf(c.purl, type),
      ...(c.purl ? { purl: c.purl } : {}),
      licenses,
      locations,
      origin,
    };
  });
}

/** Ce que le groupage a écrit dans `BUNDLE.json` (voir scripts/bundle-gateway.mjs). */
interface BundleManifest {
  native?: string[];
  packages?: { name: string; version: string; license?: string }[];
}

export function bundleComponents(manifest: BundleManifest): SbomComponent[] {
  return (manifest.packages ?? []).map((p) => ({
    name: p.name,
    version: p.version,
    type: "library",
    ecosystem: "npm",
    purl: `pkg:npm/${p.name.startsWith("@") ? `%40${p.name.slice(1)}` : p.name}@${p.version}`,
    licenses: p.license ? [p.license] : [],
    locations: ["resources/jarod-core/gateway.mjs (groupé)"],
    origin: "bundle" as const,
  }));
}

export interface PackagedLayout {
  exists(path: string): boolean;
  readText(path: string): string | null;
  /** Entrées de `app.asar` (chemins internes), si l'archive a pu être lue. */
  asarEntries?: string[] | null;
  /** Entrées marquées « unpacked » dans l'en-tête de l'archive. */
  asarUnpacked?: string[] | null;
}

/**
 * Ce que l'inventaire couvre dans un dossier d'application packagée (`win-unpacked`), et les défauts de paquet constatés.
 * Ne lit que des fichiers ; ne lance rien.
 */
export function packagedCoverage(appDir: string, layout: PackagedLayout): { coverage: CoverageItem[]; bundle: BundleManifest | null } {
  const coverage: CoverageItem[] = [];
  const res = join(appDir, "resources");
  coverage.push({ what: "fichiers du paquet (binaires, DLL, manifestes visibles)", status: "covered", why: "lus par Syft" });

  const bundleText = layout.readText(join(res, "jarod-core", "BUNDLE.json"));
  let bundle: BundleManifest | null = null;
  if (!bundleText) {
    coverage.push({ what: "noyau groupé (resources/jarod-core)", status: "not-covered", why: "BUNDLE.json absent : noyau non embarqué ou paquet antérieur" });
  } else {
    try {
      bundle = JSON.parse(bundleText) as BundleManifest;
    } catch {
      coverage.push({ what: "noyau groupé (BUNDLE.json)", status: "defect", why: "BUNDLE.json illisible" });
    }
  }
  if (bundle) {
    coverage.push(
      bundle.packages?.length
        ? { what: "dépendances npm groupées dans gateway.mjs", status: "covered", why: `${bundle.packages.length} paquets listés au groupage (métafichier esbuild)` }
        : { what: "dépendances npm groupées dans gateway.mjs", status: "not-covered", why: "BUNDLE.json sans liste « packages » (paquet construit avant G1) : reconstruire avec bundle:gateway" },
    );
    for (const n of bundle.native ?? []) {
      const p = join(res, "jarod-core", n);
      coverage.push(
        layout.exists(p)
          ? { what: `module natif ${n}`, status: "covered", why: "présent dans le paquet" }
          : { what: `module natif ${n}`, status: "defect", why: "déclaré par BUNDLE.json mais ABSENT du paquet : le noyau ne pourra pas le charger" },
      );
    }
  }

  if (layout.asarEntries == null) {
    coverage.push({ what: "app.asar (main, preload, renderer)", status: "not-covered", why: layout.exists(join(res, "app.asar")) ? "archive non lue" : "app.asar absent" });
  } else {
    const manifests = layout.asarEntries.filter((e) => /node_modules[\\/](@[^\\/]+[\\/])?[^\\/]+[\\/]package\.json$/.test(e)).length;
    coverage.push(
      manifests
        ? { what: "app.asar (node_modules)", status: "covered", why: `${manifests} manifestes extraits et lus par Syft` }
        : { what: "app.asar (main, preload, renderer)", status: "partial", why: "code groupé par esbuild/Vite sans manifeste : ses dépendances ne sont pas énumérées" },
    );
    for (const e of layout.asarUnpacked ?? []) {
      if (!/\.node$/.test(e) || !/win32-x64|[\\/]build[\\/]Release[\\/]/.test(e)) continue;
      const p = join(res, "app.asar.unpacked", e.replace(/^[\\/]+/, ""));
      if (!layout.exists(p)) coverage.push({ what: `module natif ${e.replace(/^[\\/]+/, "")}`, status: "defect", why: "marqué « unpacked » dans app.asar mais ABSENT de app.asar.unpacked" });
    }
  }
  coverage.push({ what: "moteurs gérés hors paquet (engines/)", status: "partial", why: "inventoriés depuis jarod-core/engines.lock (déclaré, présence non prouvée)" });
  coverage.push({ what: "vulnérabilités", status: "not-covered", why: "un SBOM n'est pas un scan de sécurité" });
  return { coverage, bundle };
}

export interface SbomDiff {
  added: SbomComponent[];
  removed: SbomComponent[];
  changed: { name: string; ecosystem: string; from: string; to: string }[];
}

const keyOf = (c: SbomComponent) => `${c.ecosystem}|${c.name}`;

/** Différence entre deux inventaires, par (écosystème, nom) ; plusieurs versions d'un même nom sont comparées en ensemble. */
export function compareSboms(before: SbomComponent[], after: SbomComponent[]): SbomDiff {
  const group = (list: SbomComponent[]) => {
    const m = new Map<string, { c: SbomComponent; versions: Set<string> }>();
    for (const c of list) {
      const k = keyOf(c);
      const g = m.get(k) ?? { c, versions: new Set<string>() };
      g.versions.add(c.version);
      m.set(k, g);
    }
    return m;
  };
  const a = group(before);
  const b = group(after);
  const diff: SbomDiff = { added: [], removed: [], changed: [] };
  for (const [k, g] of b) if (!a.has(k)) diff.added.push(g.c);
  for (const [k, g] of a) if (!b.has(k)) diff.removed.push(g.c);
  for (const [k, g] of b) {
    const old = a.get(k);
    if (!old) continue;
    const from = [...old.versions].sort().join(", ");
    const to = [...g.versions].sort().join(", ");
    if (from !== to) diff.changed.push({ name: g.c.name, ecosystem: g.c.ecosystem, from, to });
  }
  const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
  diff.added.sort(byName);
  diff.removed.sort(byName);
  diff.changed.sort(byName);
  return diff;
}

/** Fusion sans doublon (même origine, écosystème, nom, version) : les emplacements sont réunis. */
export function mergeComponents(lists: SbomComponent[][]): SbomComponent[] {
  const m = new Map<string, SbomComponent>();
  for (const list of lists)
    for (const c of list) {
      const k = `${c.origin}|${c.ecosystem}|${c.name}|${c.version}`;
      const prev = m.get(k);
      if (prev) prev.locations = [...new Set([...prev.locations, ...c.locations])];
      else m.set(k, { ...c, locations: [...c.locations] });
    }
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version));
}

/**
 * Les deux inventaires, SÉPARÉS (2026-10-21) : ce que le PAQUET contient réellement (lu par Syft dans win-unpacked et app.asar, plus les paquets
 * groupés de la passerelle listés par BUNDLE.json), et ce que le DÉPÔT déclare dans `engines.lock` (moteurs épinglés, pour la plupart
 * téléchargés à la demande, JAMAIS dans le paquet). Les additionner donnait un chiffre qui ne décrivait aucun des deux.
 */
export function splitInventory(components: SbomComponent[]): { paquet: SbomComponent[]; depot: SbomComponent[] } {
  return { paquet: components.filter((c) => c.origin !== "engines.lock"), depot: components.filter((c) => c.origin === "engines.lock") };
}

/** Le premier emplacement d'un composant, ramené au fichier qui le porte (`resources/restic/restic.exe`) : de quoi dire D'OÙ vient un décompte. */
const carrier = (c: SbomComponent): string => {
  const loc = (c.locations[0] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!loc) return "(sans emplacement)";
  const nm = loc.indexOf("node_modules/");
  return nm >= 0 ? `${loc.slice(0, nm)}node_modules` : loc;
};

/** Le rapport lisible : jamais présenté comme un scan de sécurité, ni comme une preuve d'installation ou de démarrage. */
export function sbomReport(input: { target: string; tool: { name: string; version: string }; components: SbomComponent[]; coverage: CoverageItem[] }): string {
  const { paquet, depot } = splitInventory(input.components);
  const tally = (list: SbomComponent[], key: (c: SbomComponent) => string) => {
    const by = new Map<string, number>();
    for (const c of list) by.set(key(c), (by.get(key(c)) ?? 0) + 1);
    return [...by].sort(([x], [y]) => x.localeCompare(y)).map(([k, n]) => `- ${k} : ${n}`);
  };
  const noLicense = paquet.filter((c) => !c.licenses.length).length;
  // Les modules Go ne sont pas des fichiers du paquet : Syft les lit dans les informations de construction d'un exécutable Go.
  const go = paquet.filter((c) => c.ecosystem === "golang");
  const defects = input.coverage.filter((c) => c.status === "defect").length;
  const lines = [
    `# Inventaire des composants (SBOM)`,
    ``,
    `Cible : ${input.target}`,
    `Outil : ${input.tool.name} ${input.tool.version}`,
    `Ce document est un inventaire, PAS un scan de sécurité : aucune vulnérabilité n'a été cherchée.`,
    `« Aucun défaut » dit seulement que les copies prévues par la configuration d'empaquetage sont présentes. Ce n'est NI une installation,`,
    `NI un démarrage, NI un test du programme : ceux-là se vérifient en lançant le paquet.`,
    ``,
    `## Paquet : ce qui est réellement dans la cible (${paquet.length})`,
    ...tally(paquet, (c) => `${c.origin}/${c.ecosystem}`),
    `- sans licence détectée : ${noLicense}`,
    ...(go.length
      ? [``, `Modules Go (${go.length}) : lus dans les informations de construction des exécutables Go, un par module lié :`, ...tally(go, carrier)]
      : []),
    ``,
    `## Dépôt : déclarations de engines.lock, NON embarquées (${depot.length})`,
    `Moteurs épinglés par le dépôt (téléchargés à la demande ou outils de développement) : ils ne sont pas dans le paquet et ne comptent pas dans son inventaire.`,
    ...tally(depot, (c) => c.ecosystem),
    ``,
    `## Couverture du paquet${defects ? ` (${defects} défaut(s))` : " (aucun défaut de copie)"}`,
    ...input.coverage.map((c) => `- [${c.status}] ${c.what} — ${c.why}`),
  ];
  return lines.join("\n");
}
