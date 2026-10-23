// G1 contre Syft réel (engines/syft/syft.exe, 1.54.1, empreinte vérifiée) : un dossier FABRIQUÉ, deux versions, la comparaison, l'annulation.
// Aucun réseau : SYFT_CHECK_FOR_APP_UPDATE=false est passé par runSyft.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareSboms, runSyft, SbomError } from "../../src/impl/sbom.js";
import { ROOT } from "./helpers.js";

const SYFT = process.env.JAROD_SYFT ?? join(ROOT, "engines", "syft", "syft.exe");
const has = existsSync(SYFT);
if (!has) console.warn(`[moteurs] ${SYFT} absent : le test Syft réel est ignoré (voir engines.lock/README.md, ligne Syft)`);

const dir = mkdtempSync(join(tmpdir(), "jarod-syft-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeApp(name: string, pkgs: Record<string, string>): string {
  const app = join(dir, name);
  for (const [n, v] of Object.entries(pkgs)) {
    mkdirSync(join(app, "node_modules", n), { recursive: true });
    writeFileSync(join(app, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v, license: "MIT" }));
  }
  return app;
}

describe.skipIf(!has)("G1 contre Syft réel", () => {
  it("inventorie les paquets installés d'un dossier fabriqué, avec version, licence et emplacement", async () => {
    const app = fakeApp("v1", { "left-pad": "1.3.0", "is-odd": "3.0.1" });
    const run = await runSyft({ syft: SYFT, target: { label: "v1", dir: app, origin: "syft", installed: true }, outFile: join(dir, "v1.cdx.json") });
    expect(run.tool).toMatchObject({ name: "syft", version: "1.54.1" });
    const lp = run.components.find((c) => c.name === "left-pad");
    expect(lp).toMatchObject({ version: "1.3.0", ecosystem: "npm", licenses: ["MIT"] });
    expect(lp!.locations.join(" ")).toMatch(/left-pad[\\/]package\.json/);
  });

  it("sans le catalogueur des paquets installés, Syft ne voit rien (la raison du drapeau `installed`)", async () => {
    const app = fakeApp("bare", { "left-pad": "1.3.0" });
    const run = await runSyft({ syft: SYFT, target: { label: "bare", dir: app, origin: "syft" }, outFile: join(dir, "bare.cdx.json") });
    expect(run.components.filter((c) => c.ecosystem === "npm")).toEqual([]);
  });

  it("compare deux versions réelles : ajout, retrait, montée de version", async () => {
    const a = await runSyft({ syft: SYFT, target: { label: "a", dir: fakeApp("a", { "left-pad": "1.3.0", "is-odd": "3.0.1" }), origin: "syft", installed: true }, outFile: join(dir, "a.cdx.json") });
    const b = await runSyft({ syft: SYFT, target: { label: "b", dir: fakeApp("b", { "left-pad": "1.3.1", "is-even": "1.0.0" }), origin: "syft", installed: true }, outFile: join(dir, "b.cdx.json") });
    const d = compareSboms(a.components, b.components);
    expect(d.added.map((c) => c.name)).toContain("is-even");
    expect(d.removed.map((c) => c.name)).toContain("is-odd");
    expect(d.changed).toContainEqual({ name: "left-pad", ecosystem: "npm", from: "1.3.0", to: "1.3.1" });
  });

  it("annulation et cible absente : erreurs explicites, jamais un inventaire vide présenté comme réussi", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runSyft({ syft: SYFT, target: { label: "x", dir: fakeApp("c", { a: "1.0.0" }), origin: "syft" }, outFile: join(dir, "c.cdx.json"), signal: ctrl.signal })).rejects.toThrow(/annulé/);
    await expect(runSyft({ syft: SYFT, target: { label: "absent", dir: join(dir, "nope"), origin: "syft" }, outFile: join(dir, "n.cdx.json") })).rejects.toBeInstanceOf(SbomError);
  });
});
