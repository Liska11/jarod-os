// G1 — contrat de l'inventaire (SBOM) : lecture CycloneDX, couverture d'un paquet, comparaison. Aucun Syft ici (voir engines/syft.engine.test.ts).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleComponents, compareSboms, ecosystemOf, mergeComponents, packagedCoverage, parseCycloneDx, type SbomComponent, SbomError, sbomReport, splitInventory } from "../src/impl/sbom.js";

const comp = (name: string, version: string, ecosystem = "npm"): SbomComponent => ({ name, version, type: "library", ecosystem, licenses: [], locations: [], origin: "syft" });

describe("G1 — lecture CycloneDX", () => {
  it("lit nom, version, écosystème, licences et emplacements", () => {
    const out = parseCycloneDx(
      {
        bomFormat: "CycloneDX",
        components: [
          { name: "left-pad", version: "1.3.0", type: "library", purl: "pkg:npm/left-pad@1.3.0", licenses: [{ license: { id: "WTFPL" } }], properties: [{ name: "syft:location:0:path", value: "/node_modules/left-pad/package.json" }] },
          { name: "d3dcompiler", version: "10.0", type: "file" },
        ],
      },
      "syft",
    );
    expect(out[0]).toMatchObject({ name: "left-pad", ecosystem: "npm", licenses: ["WTFPL"], locations: ["/node_modules/left-pad/package.json"] });
    expect(out[1]).toMatchObject({ ecosystem: "binary", licenses: [] });
  });
  it("refuse un document qui n'est pas CycloneDX", () => {
    expect(() => parseCycloneDx({ bomFormat: "SPDX" }, "syft")).toThrow(SbomError);
  });
  it("écosystème lu dans le purl, binaire sinon", () => {
    expect(ecosystemOf("pkg:pypi/requests@2", "library")).toBe("pypi");
    expect(ecosystemOf(undefined, "application")).toBe("binary");
    expect(ecosystemOf(undefined, "library")).toBe("unknown");
  });
  it("les paquets groupés deviennent des composants d'origine « bundle » avec un purl encodé", () => {
    const [c] = bundleComponents({ packages: [{ name: "@scope/x", version: "1.0.0", license: "MIT" }] });
    expect(c).toMatchObject({ origin: "bundle", purl: "pkg:npm/%40scope/x@1.0.0", licenses: ["MIT"] });
  });
});

describe("G1 — couverture d'un paquet", () => {
  const app = join("C:", "pkg");
  const res = join(app, "resources");
  const layout = (files: Record<string, string | true>, asar?: { entries: string[]; unpacked: string[] } | null) => ({
    exists: (p: string) => p in files,
    readText: (p: string) => (typeof files[p] === "string" ? (files[p] as string) : null),
    asarEntries: asar === undefined ? null : asar && asar.entries,
    asarUnpacked: asar === undefined ? null : asar && asar.unpacked,
  });

  it("un module natif déclaré mais absent est un DÉFAUT du paquet", () => {
    const bundle = JSON.stringify({ native: ["node_modules\\sqlite\\x.node"], packages: [{ name: "a", version: "1" }] });
    const { coverage } = packagedCoverage(app, layout({ [join(res, "jarod-core", "BUNDLE.json")]: bundle }));
    expect(coverage.find((c) => c.what.includes("sqlite"))).toMatchObject({ status: "defect" });
    expect(coverage.find((c) => c.what.includes("gateway.mjs"))).toMatchObject({ status: "covered" });
  });
  it("le même module présent est couvert", () => {
    const bundle = JSON.stringify({ native: ["node_modules\\sqlite\\x.node"] });
    const { coverage } = packagedCoverage(app, layout({ [join(res, "jarod-core", "BUNDLE.json")]: bundle, [join(res, "jarod-core", "node_modules\\sqlite\\x.node")]: true }));
    expect(coverage.find((c) => c.what.includes("sqlite"))).toMatchObject({ status: "covered" });
    // Sans liste « packages », le code groupé n'est pas couvert (paquet antérieur) : dit, jamais présumé.
    expect(coverage.find((c) => c.what.includes("gateway.mjs"))).toMatchObject({ status: "not-covered" });
  });
  it("un module natif « unpacked » absent de app.asar.unpacked est un défaut ; présent, il ne l'est pas", () => {
    const e = "\\node_modules\\node-pty\\prebuilds\\win32-x64\\pty.node";
    const missing = packagedCoverage(app, layout({}, { entries: [e], unpacked: [e] })).coverage;
    expect(missing.some((c) => c.status === "defect" && c.what.includes("pty.node"))).toBe(true);
    const present = packagedCoverage(app, layout({ [join(res, "app.asar.unpacked", "node_modules\\node-pty\\prebuilds\\win32-x64\\pty.node")]: true }, { entries: [e], unpacked: [e] })).coverage;
    expect(present.some((c) => c.status === "defect")).toBe(false);
  });
  it("une archive sans manifeste est « partielle » ; une archive non lue n'est pas couverte", () => {
    expect(packagedCoverage(app, layout({}, { entries: ["\\dist\\main.mjs"], unpacked: [] })).coverage.find((c) => c.what.startsWith("app.asar"))).toMatchObject({ status: "partial" });
    expect(packagedCoverage(app, layout({})).coverage.find((c) => c.what.startsWith("app.asar"))).toMatchObject({ status: "not-covered" });
  });
  it("le rapport dit toujours que ce n'est pas un scan de sécurité", () => {
    const { coverage } = packagedCoverage(app, layout({}));
    const text = sbomReport({ target: app, tool: { name: "syft", version: "1.54.1" }, components: [comp("a", "1")], coverage });
    expect(text).toMatch(/PAS un scan de sécurité/);
    expect(coverage.find((c) => c.what === "vulnérabilités")).toMatchObject({ status: "not-covered" });
  });
});

describe("G1 — comparaison de deux inventaires", () => {
  it("ajoutés, retirés, versions changées", () => {
    const d = compareSboms([comp("a", "1"), comp("b", "1"), comp("c", "2")], [comp("a", "1"), comp("c", "3"), comp("d", "1")]);
    expect(d.added.map((c) => c.name)).toEqual(["d"]);
    expect(d.removed.map((c) => c.name)).toEqual(["b"]);
    expect(d.changed).toEqual([{ name: "c", ecosystem: "npm", from: "2", to: "3" }]);
  });
  it("même nom dans deux écosystèmes : deux composants distincts", () => {
    const d = compareSboms([comp("six", "1", "pypi")], [comp("six", "1", "npm")]);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });
  it("plusieurs versions d'un nom sont comparées en ensemble", () => {
    const d = compareSboms([comp("x", "1"), comp("x", "2")], [comp("x", "2"), comp("x", "1")]);
    expect(d.changed).toEqual([]);
  });
  it("la fusion réunit les emplacements sans doublon", () => {
    const a = { ...comp("a", "1"), locations: ["/p1"] };
    const b = { ...comp("a", "1"), locations: ["/p2", "/p1"] };
    expect(mergeComponents([[a], [b]])).toEqual([{ ...a, locations: ["/p1", "/p2"] }]);
  });
});

describe("G1 — paquet et dépôt séparés (2026-10-21)", () => {
  const lock = (name: string, ecosystem = "pypi"): SbomComponent => ({ ...comp(name, "1", ecosystem), origin: "engines.lock" });
  const goIn = (name: string, file: string): SbomComponent => ({ ...comp(name, "1", "golang"), locations: [file] });

  it("le paquet ne compte que ce qui est dans la cible ; les déclarations de engines.lock forment l'inventaire du dépôt", () => {
    const all = [comp("a", "1"), { ...comp("b", "1"), origin: "bundle" as const }, lock("torch"), lock("x", "npm")];
    const { paquet, depot } = splitInventory(all);
    expect(paquet.map((c) => c.name)).toEqual(["a", "b"]);
    expect(depot.map((c) => c.name)).toEqual(["torch", "x"]);
  });

  it("le rapport sépare les deux, dit d'où viennent les modules Go, et ne présente pas « aucun défaut » comme un démarrage", () => {
    const text = sbomReport({
      target: "C:\\app",
      tool: { name: "syft", version: "1.54.1" },
      components: [comp("a", "1"), goIn("stdlib", "\\resources\\restic\\restic.exe"), goIn("github.com/x/y", "\\resources\\restic\\restic.exe"), lock("torch")],
      coverage: [],
    });
    expect(text).toMatch(/## Paquet : ce qui est réellement dans la cible \(3\)/);
    expect(text).toMatch(/## Dépôt : déclarations de engines.lock, NON embarquées \(1\)/);
    expect(text).toMatch(/resources\/restic\/restic\.exe : 2/);
    expect(text).toMatch(/NI une installation/);
    expect(text).toMatch(/NI un démarrage/);
  });
});
