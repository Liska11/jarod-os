/**
 * V-02 — timeline auditée : `audit-session` sur un VRAI kernel derrière les VRAIS handlers.
 * V-03 — `audit-recent` : la part du noyau dans la vue unique des journaux.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { tailLines } from "../src/main/handlers/audit.js";
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

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");

describe("audit-recent (V-03)", () => {
  it("rend les dernières lignes de l'agent, toutes conversations, et celles de mcp-server.log de la même racine", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "jarod-audit-"));
    writeFileSync(join(dataRoot, "mcp-server.log"), lines("2026-10-23T10:00:00.000Z memory_search args=12o résultat=345o ok", "2026-10-23T10:00:01.000Z sessions_list args=2o résultat=0o erreur"));
    const { call, app } = await setupKernel(undefined, [], { dataRoot });
    app.agent.audit({ sessionId: "s-a", tool: "run_shell", args: "{}", decision: "accordé", ok: true });
    app.agent.audit({ sessionId: "s-b", tool: "read_file", args: "{}", decision: "automatique", ok: true });

    const all = (await call("audit-recent")) as { agent: { tool: string; at: number }[]; mcpServer: string[] };
    // La plus récente d'abord (`auditLog`) ; la vue du shell retrie de toute façon toutes les sources par date.
    expect(all.agent.map((r) => r.tool)).toEqual(["read_file", "run_shell"]);
    expect(typeof all.agent[0]!.at).toBe("number");
    expect(all.mcpServer).toHaveLength(2);
    expect(all.mcpServer[1]).toMatch(/sessions_list .* erreur$/);

    const one = (await call("audit-recent", 1)) as { agent: unknown[]; mcpServer: string[] };
    expect(one.agent).toHaveLength(1);
    expect(one.mcpServer).toEqual([all.mcpServer[1]]);
  });

  it("sans mcp-server.log (jarod mcp jamais lancé) : aucune ligne, pas d'erreur", async () => {
    const { call } = await setupKernel(undefined, [], { dataRoot: mkdtempSync(join(tmpdir(), "jarod-audit-")) });
    expect(((await call("audit-recent")) as { mcpServer: string[] }).mcpServer).toEqual([]);
  });
});

describe("tailLines", () => {
  it("lit la fin sans tout lire, écarte la ligne coupée, complète par la génération tournée", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-tail-"));
    const file = join(dir, "x.log");
    writeFileSync(`${file}.1`, lines("ancienne-1", "ancienne-2"));
    writeFileSync(file, `a\r\nb\n`);
    expect(tailLines(file, 2)).toEqual(["a", "b"]);
    expect(tailLines(file, 3)).toEqual(["ancienne-2", "a", "b"]);
    expect(tailLines(join(dir, "absent.log"), 5)).toEqual([]);

    // Plus long que la fenêtre de lecture : la première ligne, coupée, n'est jamais rendue à moitié.
    const big = join(dir, "big.log");
    writeFileSync(big, lines("y".repeat(300 * 1024), "fin"));
    expect(tailLines(big, 5)).toEqual(["fin"]);
  });
});
