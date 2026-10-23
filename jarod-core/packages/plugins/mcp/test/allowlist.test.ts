// V-14 : liste blanche MCP outil par outil — seuls les outils choisis rejoignent le registre ; les autres n'existent pas pour l'agent.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type McpAuditEvent, McpManager, MemoryPinStore, toolAllowed } from "../src/mcp.js";
import { makeCore } from "./helpers.js";

const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url));
const cfg = (extra: { allowedTools?: string[]; env?: Record<string, string> } = {}) => ({
  id: "f",
  name: "fake",
  command: process.execPath,
  args: [FAKE_MCP],
  env: extra.env ?? {},
  enabled: true,
  ...(extra.allowedTools ? { allowedTools: extra.allowedTools } : {}),
});

async function manager(pins = new MemoryPinStore()) {
  const core = await makeCore();
  const events: McpAuditEvent[] = [];
  const mcp = new McpManager(core.tools, { pins, audit: (e) => events.push(e) });
  return { mcp, pins, events, tools: core.tools };
}

describe("V-14 — liste blanche MCP par outil", () => {
  it("sans liste : tous les outils (comportement d'avant)", async () => {
    const { mcp, tools } = await manager();
    await mcp.sync([cfg()]);
    expect(mcp.list()[0]).toMatchObject({ state: "running", tools: ["mcp_fake_echo", "mcp_fake_boom"], filtered: [] });
    expect(tools.get("mcp_fake_boom")).toBeDefined();
    mcp.stopAll();
  });

  it("avec liste : seul l'outil choisi est enregistré, l'autre est dit filtré et journalisé (nombre seulement)", async () => {
    const { mcp, tools, events } = await manager();
    await mcp.sync([cfg({ allowedTools: ["echo"] })]);
    expect(mcp.list()[0]).toMatchObject({ state: "running", tools: ["mcp_fake_echo"], pending: [], filtered: ["boom"] });
    expect(tools.get("mcp_fake_echo")).toBeDefined();
    expect(tools.get("mcp_fake_boom")).toBeUndefined();
    expect(events.find((e) => e.kind === "filtered")).toEqual({ kind: "filtered", server: "f", count: 1 });
    mcp.stopAll();
  });

  it("liste vide : le serveur tourne mais n'expose rien", async () => {
    const { mcp, tools } = await manager();
    await mcp.sync([cfg({ allowedTools: [] })]);
    expect(mcp.list()[0]).toMatchObject({ state: "running", tools: [], filtered: ["echo", "boom"] });
    expect(tools.get("mcp_fake_echo")).toBeUndefined();
    mcp.stopAll();
  });

  it("un outil apparu plus tard reste dehors : ni enregistré, ni proposé à l'accord", async () => {
    const pins = new MemoryPinStore();
    const first = await manager(pins);
    await first.mcp.sync([cfg({ allowedTools: ["echo"] })]);
    first.mcp.stopAll();
    const again = await manager(pins);
    await again.mcp.sync([cfg({ allowedTools: ["echo"], env: { FAKE_EXTRA_TOOL: "1" } })]);
    expect(again.mcp.list()[0]).toMatchObject({ tools: ["mcp_fake_echo"], pending: [], filtered: ["boom", "extra"] });
    expect(again.tools.get("mcp_fake_extra")).toBeUndefined();
    expect(() => again.mcp.approve("f", "extra")).toThrow();
    again.mcp.stopAll();
  });

  it("un outil ajouté à la liste mais nouveau pour les épingles attend toujours l'accord (les deux gardes s'additionnent)", async () => {
    const pins = new MemoryPinStore();
    const first = await manager(pins);
    await first.mcp.sync([cfg()]);
    first.mcp.stopAll();
    const again = await manager(pins);
    await again.mcp.sync([cfg({ allowedTools: ["echo", "extra"], env: { FAKE_EXTRA_TOOL: "1" } })]);
    expect(again.mcp.list()[0]).toMatchObject({ tools: ["mcp_fake_echo"], filtered: ["boom"], pending: [{ tool: "extra", reason: "new" }] });
    again.mcp.stopAll();
  });

  it("preview : chaque outil dit s'il passe la liste, sans rien enregistrer", async () => {
    const { mcp, tools } = await manager();
    const rows = await mcp.preview(cfg({ allowedTools: ["boom"] }));
    expect(rows.map((r) => [r.name, r.allowed])).toEqual([
      ["echo", false],
      ["boom", true],
    ]);
    expect(tools.get("mcp_fake_boom")).toBeUndefined();
  });

  it("toolAllowed : sans liste tout passe ; avec liste, le nom exact seulement", () => {
    expect(toolAllowed({}, "x")).toBe(true);
    expect(toolAllowed({ allowedTools: ["x"] }, "x")).toBe(true);
    expect(toolAllowed({ allowedTools: ["x"] }, "X")).toBe(false);
    expect(toolAllowed({ allowedTools: [] }, "x")).toBe(false);
  });
});
