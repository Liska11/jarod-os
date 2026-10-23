// G13 contre osquery réel (engines/osquery/osqueryi.exe, 5.23.1, sha256 = condensat GitHub, Authenticode « OSQUERY a Series of LF
// Projects, LLC » valide) : chaque requête prédéfinie tourne SANS élévation et rend des lignes ; rien d'écrit dans le profil.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRefused } from "../../src/impl/common.js";
import { OSQUERY_PRESETS, osqueryTool, runOsqueryPreset } from "../../src/impl/osquery.js";
import { ROOT } from "./helpers.js";

const BIN = process.env.JAROD_OSQUERYI ?? join(ROOT, "engines", "osquery", "osqueryi.exe");
const has = existsSync(BIN);
if (!has) console.warn(`[moteurs] ${BIN} absent : les tests osquery réels sont ignorés (voir engines.lock/README.md)`);

describe.skipIf(!has)("G13 contre osquery réel", () => {
  it.each(Object.keys(OSQUERY_PRESETS))("requête prédéfinie « %s » : aucune erreur, provenance et horodatage", async (preset) => {
    const r = await runOsqueryPreset({ bin: BIN, preset });
    expect(r.source).toMatch(/^osquery 5\.23\.1 /);
    expect(r.privileges).toBe("utilisateur (non élevé)");
    expect(Number.isNaN(Date.parse(r.collectedAt))).toBe(false);
    expect(Array.isArray(r.rows)).toBe(true);
    // Ce qui existe forcément sur une machine Windows en marche :
    if (["os", "hardware", "uptime", "disks", "top-memory"].includes(preset)) expect(r.rowCount, preset).toBeGreaterThan(0);
  }, 60_000);

  it("les données sensibles exclues ne sortent pas : ni chemin ni ligne de commande des processus", async () => {
    const r = await runOsqueryPreset({ bin: BIN, preset: "top-memory" });
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual(["name", "pid", "resident_size", "total_size"]);
  }, 60_000);

  it("refus : identifiant inconnu (jamais de SQL libre), prototype d'objet, annulation", async () => {
    await expect(runOsqueryPreset({ bin: BIN, preset: "select * from users" })).rejects.toBeInstanceOf(AdapterRefused);
    await expect(runOsqueryPreset({ bin: BIN, preset: "toString" })).rejects.toBeInstanceOf(AdapterRefused);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runOsqueryPreset({ bin: BIN, preset: "os", signal: ctrl.signal })).rejects.toThrow(/annulé/);
  });

  it("l'outil de l'agent rend un résumé daté ; sans moteur, il le dit", async () => {
    const out = await osqueryTool(() => BIN).run({ query: "disks" }, { sessionId: "s", workspace: null });
    expect(out).toMatch(/lecteurs, taille et espace libre — \d+ ligne/);
    expect(out).toMatch(/privilèges : utilisateur \(non élevé\)/);
    expect(await osqueryTool(() => null).run({ query: "disks" }, { sessionId: "s", workspace: null })).toMatch(/Indisponible/);
  }, 60_000);
});
