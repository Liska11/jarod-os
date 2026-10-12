/**
 * AV2-008 — les règles de l'utilisateur vivent dans les RÉGLAGES (`permissionsRules`) et sont relues À CHAUD :
 * un portail distribué à l'agent AVANT l'écriture suit immédiatement, sans redémarrage, et la chaîne reste
 * fail-closed (outil absent du registre → deny) même si le storage ne répond pas.
 *
 * VRAI kernel (vrais plugins storage + permissions), vraie base sur un dossier temporaire.
 */
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore, type SettingsService } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionsService } from "../src/index.js";

afterEach(cleanup);

/** Un vrai kernel (storage + permissions) sur un dossier donné ; le magasin de clés est partagé par appelant. */
async function boot(dir = tempDir(), keys = memoryKeyStore()) {
  const app = await bootApp({ storage: { dataDir: dir, keyStores: [keys] }, permissions: {} });
  return { app, permissions: app.permissions as PermissionsService, settings: app.storage.settings };
}

const DECLARED = new Set(["read_file", "run_shell"]);
const gateOf = (permissions: PermissionsService) => permissions.gate((n) => DECLARED.has(n));

describe("AV2-008 — relecture à chaud des règles de permissions", () => {
  it("charge au branchement, puis relit à CHAQUE écriture : le portail déjà distribué suit", async () => {
    const { permissions, settings } = await boot();
    permissions.initStorage(settings);
    const gate = gateOf(permissions);
    expect(gate.decide("run_shell")).toBe("allow"); // aucune règle : le registre décide

    settings.set("permissionsRules", [{ tool: "run_shell", decision: "deny" }]);
    expect(gate.decide("run_shell")).toBe("deny");
    expect(gate.decide("read_file")).toBe("allow");
    expect(permissions.guard.getRules()).toEqual([{ tool: "run_shell", decision: "deny" }]);

    settings.patch({ permissionsRules: [{ tool: "run_shell", decision: "ask" }] });
    expect(gate.decide("run_shell")).toBe("ask"); // la relecture est SYNCHRONE (onChange de SettingsService)

    settings.patch({ permissionsRules: [] });
    expect(gate.decide("run_shell")).toBe("allow");
    expect(permissions.guard.getRules()).toEqual([]);
  });

  it("les règles DÉJÀ en base sont chargées au démarrage : une session qui REDÉMARRE les retrouve sans branchement d'hôte", async () => {
    const dir = tempDir();
    const keys = memoryKeyStore();
    const first = await boot(dir, keys);
    first.permissions.initStorage(first.settings);
    first.settings.set("permissionsRules", [{ tool: "run_shell", decision: "deny" }]);
    await shutdown(first.app);

    const second = await boot(dir, keys);
    // H1 : le plugin se branche LUI-MÊME — `initStorage` n'est plus requis (l'appel explicite ci-dessous
    // reste valide et idempotent, il est conservé pour couvrir ce chemin).
    expect(second.permissions.guard.getRules()).toEqual([{ tool: "run_shell", decision: "deny" }]);
    second.permissions.initStorage(second.settings);
    expect(gateOf(second.permissions).decide("run_shell")).toBe("deny");
  });

  it("un second `initStorage` REMPLACE l'abonnement, il ne s'y ajoute pas (une écriture = une relecture)", async () => {
    const { permissions, settings } = await boot();
    let refreshes = 0;
    const setRules = permissions.guard.setRules.bind(permissions.guard);
    permissions.guard.setRules = (rules) => {
      refreshes++;
      setRules(rules);
    };
    permissions.initStorage(settings);
    permissions.initStorage(settings);
    refreshes = 0; // le branchement lui-même relit une fois par appel : ce n'est pas ce qu'on mesure
    settings.set("permissionsRules", [{ tool: "run_shell", decision: "deny" }]);
    expect(refreshes).toBe(1);
    expect(permissions.guard.getRules()).toHaveLength(1);
  });

  it("storage illisible : AUCUNE règle, et la chaîne retombe sur le registre (jamais « tout ouvert »)", async () => {
    const { permissions } = await boot();
    const broken = {
      get: () => {
        throw new Error("base fermée");
      },
      onChange: () => () => {},
    } as unknown as SettingsService;
    permissions.initStorage(broken);
    const gate = gateOf(permissions);
    expect(permissions.guard.getRules()).toEqual([]);
    expect(gate.decide("read_file")).toBe("allow"); // déclaré au registre
    expect(gate.decide("outil_invente")).toBe("deny"); // ni déclaré ni autorisé par une règle
  });

  it("libérer le service retire l'abonnement : plus aucune relecture après `onDispose`", async () => {
    const { permissions, settings } = await boot();
    permissions.initStorage(settings);
    permissions.onDispose();
    settings.set("permissionsRules", [{ tool: "run_shell", decision: "deny" }]);
    expect(permissions.guard.getRules()).toEqual([]);
  });
});
