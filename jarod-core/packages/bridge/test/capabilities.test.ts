/**
 * Écran « Capacités » (cockpit, lot 1) : un VRAI kernel, le vrai plugin-integrations, les vrais handlers. Les sondes tournent sur la
 * machine : le test vérifie la forme et les refus, pas l'état (qui dépend de ce qui est installé).
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

const STATES = ["unknown", "not-installed", "installed-unconfigured", "available", "degraded", "blocked-permission", "error"];

async function setup() {
  const r = await setupKernel();
  const app = r.app as unknown as { integrations?: { capabilities: never }; tools?: { registry: { get(n: string): unknown } } };
  if (app.integrations) r.kernel.capabilities = app.integrations.capabilities;
  return { ...r, app };
}

describe("capabilities-list / capabilities-check", () => {
  it("le plugin branche l'outil `capabilities` au registre existant et sert le registre vivant", async () => {
    const { call, app } = await setup();
    expect(app.tools?.registry.get("capabilities")).toBeTruthy();
    const rows = (await call("capabilities-list")) as { id: string; state: string; provenance?: { repo: string } }[];
    const own = rows.filter((r) => !r.id.startsWith("tool."));
    expect(own).toHaveLength(10);
    for (const r of rows) expect(STATES, r.id).toContain(r.state);
    expect(own.find((r) => r.id === "strix.app-security")?.provenance?.repo).toBe("usestrix/strix");
    expect(rows.some((r) => r.id === "tool.capabilities")).toBe(true);
  }, 60_000);

  it("check : un identifiant mal formé est refusé, un inconnu est dit inconnu", async () => {
    const { call } = await setup();
    expect(await call("capabilities-check", "../x")).toBeNull();
    expect(await call("capabilities-check", 3)).toBeNull();
    expect(((await call("capabilities-check", "jarvis.everything")) as { state: string }).state).toBe("unknown");
  }, 60_000);
});
