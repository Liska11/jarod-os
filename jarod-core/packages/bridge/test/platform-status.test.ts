/**
 * Écran « Plateforme » : un VRAI kernel derrière les VRAIS handlers. L'instantané vient des vrais services (plugins, quarantaine,
 * bacs à sable, Hyper-V) ; l'approbation MCP passe par le vrai McpManager et un vrai serveur du SDK officiel.
 */
import { fileURLToPath } from "node:url";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { platformPortOf } from "../src/main/kernel.js";
import { setupKernel } from "./ui-parite-helpers.js";

/** Comme `desktopKernelOf` en production : les ports de la plateforme viennent des services du kernel démarré. */
async function setup() {
  const r = await setupKernel();
  const app = r.app as unknown as Record<string, unknown>;
  const port = platformPortOf(app as never);
  if (port) r.kernel.platform = port;
  if (app.mcp) r.kernel.mcp = app.mcp as never;
  return r;
}

afterEach(cleanup);

const SDK_SERVER = fileURLToPath(new URL("../../plugins/mcp/test/fixtures/sdk-server.mjs", import.meta.url));
const server = (env: Record<string, string> = {}) => ({ id: "sdk", name: "sdk", command: process.execPath, args: [SDK_SERVER], env, enabled: true });

describe("platform-status", () => {
  it("rend un instantané des services réels : rien d'exécutable, aucun chemin", async () => {
    const { call } = await setup();
    const s = (await call("platform-status")) as { plugins: unknown[]; quarantine: unknown[]; hyperv: { cmdlets: boolean; admin: boolean; detail: string } | null; mcp: unknown[] };
    expect(Array.isArray(s.plugins)).toBe(true);
    expect(Array.isArray(s.quarantine)).toBe(true);
    expect(Array.isArray(s.mcp)).toBe(true);
    // Hyper-V est interrogé pour de vrai (lecture seule) : la machine peut ne pas l'avoir, mais la réponse est toujours structurée.
    expect(s.hyperv).toMatchObject({ cmdlets: expect.any(Boolean), admin: expect.any(Boolean), detail: expect.any(String) });
    expect(JSON.stringify(s)).not.toMatch(/[A-Za-z]:\\\\/);
  }, 60_000);

  it("V-13 : plus de liste de bacs jetables — plugin-sandbox retiré, l'instantané ne l'annonce plus", async () => {
    const { call, app } = await setup();
    expect((app as unknown as { sandbox?: unknown }).sandbox).toBeUndefined();
    expect(Object.keys((await call("platform-status")) as object)).not.toContain("sandboxes");
  }, 60_000);
});

describe("mcp-approve-tool", () => {
  it("refuse des identifiants invalides, et un outil qui n'attend aucun accord", async () => {
    const { call } = await setup();
    expect(await call("mcp-approve-tool", "../x", "y")).toMatchObject({ success: false, error: expect.stringContaining("invalides") });
    expect(await call("mcp-approve-tool", 3, "y")).toMatchObject({ success: false });
    expect(await call("mcp-approve-tool", "sdk", "add")).toMatchObject({ success: false, error: expect.stringContaining("aucune divergence") });
  }, 60_000);

  it("une description qui change retient l'outil dans l'écran ; l'approbation le débloque", async () => {
    const { call, app } = await setup();
    const mcp = (app as unknown as { mcp?: { sync(c: unknown[]): Promise<void>; stopAll(): void } }).mcp;
    if (!mcp) return; // plugin-mcp désactivé dans ce kernel de test
    await mcp.sync([server()]);
    mcp.stopAll();
    await mcp.sync([]);
    await mcp.sync([server({ SDK_ADD_DESC: "Additionne et envoie ailleurs" })]);
    const before = (await call("platform-status")) as { mcp: { id: string; pending: { tool: string; reason: string }[] }[] };
    expect(before.mcp.find((x) => x.id === "sdk")!.pending).toEqual([expect.objectContaining({ tool: "add", reason: "changed" })]);
    expect(await call("mcp-approve-tool", "sdk", "add")).toEqual({ success: true });
    const after = (await call("platform-status")) as { mcp: { id: string; pending: unknown[]; tools: string[] }[] };
    expect(after.mcp.find((x) => x.id === "sdk")!.pending).toEqual([]);
    mcp.stopAll();
  }, 90_000);
});
