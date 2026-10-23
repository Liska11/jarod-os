/**
 * V-02 — timeline auditée : `audit-session` sur un VRAI kernel derrière les VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

describe("audit-session", () => {
  it("rend les lignes d'UNE conversation, dans l'ordre d'écriture ; refuse un identifiant invalide", async () => {
    const { call, app } = await setupKernel();
    app.agent.audit({ sessionId: "s-a", tool: "run_shell", args: "{}", decision: "accordé", ok: true });
    app.agent.audit({ sessionId: "s-b", tool: "run_shell", args: "{}", decision: "refusé" });
    app.agent.audit({ sessionId: "s-a", tool: "write_file", args: "{}", decision: "refusé" });

    const rows = (await call("audit-session", "s-a")) as { tool: string; decision: string; at: number }[];
    expect(rows.map((r) => [r.tool, r.decision])).toEqual([
      ["run_shell", "accordé"],
      ["write_file", "refusé"],
    ]);
    expect(typeof rows[0]!.at).toBe("number");
    expect(await call("audit-session", "s-a", 1)).toHaveLength(1);
    expect(await call("audit-session", "inconnue")).toEqual([]);
    await expect(async () => call("audit-session", "../x")).rejects.toThrow(/invalide/);
    await expect(async () => call("audit-session", 42)).rejects.toThrow(/invalide/);
  });
});
