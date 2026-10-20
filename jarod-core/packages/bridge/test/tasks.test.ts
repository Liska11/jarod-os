/**
 * Cockpit, lot 2 : écran « Tâches » et règles par cible / temporaires, sur un VRAI kernel derrière les VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

describe("tasks-list / task-cancel", () => {
  it("liste les tâches du registre de l'agent ; annule une tâche vivante par son identifiant, refuse le reste", async () => {
    const { call, app } = await setupKernel();
    expect(await call("tasks-list")).toEqual([]);
    const live = app.agent.tasks.begin({ sessionId: "s", tool: "system_open", summary: "Lancer Paint", target: "Paint" });
    const rows = (await call("tasks-list")) as { id: string; status: string; target?: string }[];
    expect(rows[0]).toMatchObject({ id: live.id, status: "running", target: "Paint" });
    expect(await call("task-cancel", "../x")).toEqual({ success: false, error: "identifiant invalide" });
    expect(await call("task-cancel", live.id)).toEqual({ success: true });
    expect(live.signal.aborted).toBe(true);
    expect(await call("task-cancel", live.id)).toMatchObject({ success: false });
    expect(((await call("tasks-list")) as { status: string }[])[0]!.status).toBe("cancelled");
  });
});

describe("permissionsRules : cible et échéance (cockpit, lot 2)", () => {
  it("une règle ciblée s'écrit et le portail de l'agent la suit pour sa cible seulement", async () => {
    const { call, app, confirms } = await setupKernel();
    await call("set-jarod-settings", { permissionsRules: [{ tool: "system_open", target: "*steam*", decision: "deny" }] });
    expect(app.agent.gate!.decide("system_open", "Steam")).toBe("deny");
    expect(app.agent.gate!.decide("system_open", "Paint")).toBe("allow");
    expect(confirms).toHaveLength(0); // un refus ciblé durcit : aucune boîte
  });

  it("une autorisation temporaire ciblée est un affaiblissement : la boîte native la nomme", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [true]);
    await call("set-jarod-settings", { permissionsRules: [{ tool: "*", decision: "deny" }] });
    const until = Date.now() + 3_600_000;
    await call("set-jarod-settings", { permissionsRules: [{ tool: "write_file", target: "notes/*", decision: "allow", expiresAt: until }, { tool: "*", decision: "deny" }] });
    expect(confirms.at(-1)!.detail).toMatch(/write_file.*notes\/\*/);
    expect(app.agent.settings.get("permissionsRules")[0]).toEqual({ tool: "write_file", target: "notes/*", decision: "allow", expiresAt: until });
  });

  it("validation : échéance passée ou à plus de 30 jours, cible avec espace autour, doublon outil + cible", async () => {
    const { call } = await setupKernel();
    const refused: [unknown, RegExp][] = [
      [[{ tool: "a", decision: "allow", expiresAt: Date.now() - 1 }], /expiresAt/],
      [[{ tool: "a", decision: "allow", expiresAt: Date.now() + 31 * 24 * 3_600_000 }], /expiresAt/],
      [[{ tool: "a", decision: "deny", target: " x" }], /target/],
      [[{ tool: "a", decision: "deny", target: "x" }, { tool: "a", decision: "allow", target: "x" }], /en double/],
    ];
    for (const [v, why] of refused) await expect(Promise.resolve().then(() => call("set-jarod-settings", { permissionsRules: v }))).rejects.toThrow(why);
    // Même outil, cibles différentes : permis.
    await call("set-jarod-settings", { permissionsRules: [{ tool: "a", decision: "deny", target: "x" }, { tool: "a", decision: "deny", target: "y" }] });
  });
});
