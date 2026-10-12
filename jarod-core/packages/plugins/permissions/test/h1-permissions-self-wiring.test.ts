/**
 * H1 (audit v4 § 1) — les règles de permissions doivent être chargées PAR LE PLUGIN, jamais par l'hôte.
 *
 * Avant correctif, `initStorage` n'était appelé que par `packages/desktop/src/main/kernel.ts` : un hôte
 * qui ne l'appelle pas (CLI, `jarod serve`, `acp`, `headless`, e2e) obtenait un garde à ZÉRO règle, donc
 * un « deny run_shell » écrit dans le bureau était purement ignoré (« déclaré au registre → allow »).
 *
 * VRAI kernel (vrais plugins storage + permissions), vraie base, même dossier pour deux démarrages.
 */
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionsService } from "../src/index.js";

afterEach(cleanup);

/** Le registre minimal : `run_shell` y est DÉCLARÉ (donc « allow » si aucune règle ne le couvre). */
const gateOf = (p: PermissionsService) => p.gate((n) => n === "read_file" || n === "run_shell");

describe("H1 — le plugin se branche sur le storage lui-même (aucun hôte ne peut oublier)", () => {
  it("une règle « deny run_shell » écrite par le bureau est respectée par un hôte qui ne branche RIEN", async () => {
    const dir = tempDir();
    const keys = memoryKeyStore();

    // 1er démarrage : le bureau écrit la règle (c'est le seul chemin qui écrit `permissionsRules`).
    const desktop = await bootApp({ storage: { dataDir: dir, keyStores: [keys] }, permissions: {} });
    desktop.storage.settings.set("permissionsRules", [{ tool: "run_shell", decision: "deny" }]);
    await shutdown(desktop);

    // 2e démarrage : un AUTRE hôte, qui n'appelle jamais `initStorage`.
    const cli = await bootApp({ storage: { dataDir: dir, keyStores: [keys] }, permissions: {} });
    const permissions = cli.permissions as PermissionsService;

    expect(permissions.guard.getRules()).toEqual([{ tool: "run_shell", decision: "deny" }]);
    expect(gateOf(permissions).decide("run_shell")).toBe("deny");
    expect(gateOf(permissions).decide("read_file")).toBe("allow"); // rien ne couvre read_file : le registre décide
  });

  it("les règles de la config du plugin sont CONCATÉNÉES avec celles de l'utilisateur (config d'abord)", async () => {
    const app = await bootApp({
      storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] },
      permissions: { rules: [{ tool: "*", decision: "deny" }] },
    });
    const permissions = app.permissions as PermissionsService;

    // La config est seule en vigueur au démarrage.
    expect(permissions.guard.getRules()).toEqual([{ tool: "*", decision: "deny" }]);

    // Une règle utilisateur s'AJOUTE (elle ne remplace pas la politique de déploiement).
    app.storage.settings.set("permissionsRules", [{ tool: "read_file", decision: "allow" }]);
    expect(permissions.guard.getRules()).toEqual([
      { tool: "*", decision: "deny" },
      { tool: "read_file", decision: "allow" },
    ]);

    const gate = gateOf(permissions);
    expect(gate.decide("run_shell")).toBe("deny"); // plancher du déploiement intact
    expect(gate.decide("read_file")).toBe("deny"); // config d'abord : le « * deny » de la config couvre read_file
  });
});