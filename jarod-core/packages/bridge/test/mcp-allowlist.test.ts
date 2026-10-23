/**
 * V-14 — liste blanche MCP outil par outil, par les vrais handlers sur un VRAI kernel et un vrai serveur MCP (fixture stdio) :
 * lecture des outils avec leur place dans la liste, écriture, registre de l'agent qui suit, refus des entrées mal formées.
 */
import { fileURLToPath } from "node:url";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

const FAKE_MCP = fileURLToPath(new URL("../../plugins/mcp/test/fixtures/fake-mcp.mjs", import.meta.url));

type ToolsView = { success: boolean; error?: string; restricted?: boolean; allowed?: string[] | null; tools?: { name: string; allowed: boolean; pinState: string }[] };

async function setup() {
  const r = await setupKernel();
  const app = r.app as unknown as {
    agent: { settings: { get(k: "mcpServers"): { name: string; allowedTools?: string[] }[] }; tools: { get(n: string): unknown } };
    mcp: { list(): { name: string; tools: string[]; filtered: string[] }[]; stopAll(): void };
  };
  (r.kernel as { mcp?: unknown }).mcp = app.mcp;
  expect(await r.call("add-mcp-server", { name: "fake", type: "stdio", command: process.execPath, args: [FAKE_MCP] })).toEqual({ success: true });
  return { ...r, app };
}

describe("V-14 — liste blanche MCP (handlers)", () => {
  it("sans liste : tous les outils ; la liste écrite restreint le registre ; null rend tout", async () => {
    const { call, app } = await setup();
    let view = (await call("mcp-server-tools", "fake")) as ToolsView;
    expect(view).toMatchObject({ success: true, restricted: false, allowed: null });
    expect(view.tools!.map((t) => [t.name, t.allowed, t.pinState])).toEqual([
      ["echo", true, "approved"],
      ["boom", true, "approved"],
    ]);

    expect(await call("set-mcp-server-tools", "fake", ["echo", "echo"])).toEqual({ success: true });
    expect(app.agent.settings.get("mcpServers")[0]!.allowedTools).toEqual(["echo"]);
    expect(app.mcp.list()[0]).toMatchObject({ tools: ["mcp_fake_echo"], filtered: ["boom"] });
    expect(app.agent.tools.get("mcp_fake_boom")).toBeUndefined();
    expect(((await call("list-mcp-servers")) as { allowedTools?: string[] }[])[0]!.allowedTools).toEqual(["echo"]);
    view = (await call("mcp-server-tools", "fake")) as ToolsView;
    expect(view).toMatchObject({ restricted: true, allowed: ["echo"] });
    expect(view.tools!.find((t) => t.name === "boom")!.allowed).toBe(false);

    // Modifier le serveur garde sa liste.
    expect(await call("update-mcp-server", "fake", { name: "fake", type: "stdio", command: process.execPath, args: [FAKE_MCP] })).toEqual({ success: true });
    expect(app.agent.settings.get("mcpServers")[0]!.allowedTools).toEqual(["echo"]);
    expect(app.mcp.list()[0]).toMatchObject({ tools: ["mcp_fake_echo"] });

    expect(await call("set-mcp-server-tools", "fake", null)).toEqual({ success: true });
    expect(app.agent.settings.get("mcpServers")[0]!.allowedTools).toBeUndefined();
    expect(app.mcp.list()[0]).toMatchObject({ tools: ["mcp_fake_echo", "mcp_fake_boom"], filtered: [] });
    app.mcp.stopAll();
  }, 60_000);

  it("refus : serveur inconnu, liste mal formée — rien n'est écrit", async () => {
    const { call, app } = await setup();
    expect(await call("set-mcp-server-tools", "absent", [])).toMatchObject({ success: false });
    expect(await call("mcp-server-tools", "absent")).toMatchObject({ success: false });
    for (const bad of ["echo", [3], [""], ["a\u0007"], ["x".repeat(201)], Array.from({ length: 501 }, (_, i) => `t${i}`), undefined, { echo: true }])
      expect(await call("set-mcp-server-tools", "fake", bad), JSON.stringify(bad)?.slice(0, 40)).toMatchObject({ success: false });
    expect(app.agent.settings.get("mcpServers")[0]!.allowedTools).toBeUndefined();
    app.mcp.stopAll();
  }, 60_000);
});
