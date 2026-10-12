// Portage de packages/core/test/extensions.test.ts:104-138 (rév. 2e180305), bloc « MCP ».
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp.js";
import { makeCore } from "./helpers.js";

const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url));

describe("MCP", () => {
  it("talks to a stdio server: initialize, list and call tools", async () => {
    const client = new McpClient({ command: process.execPath, args: [FAKE_MCP], env: {} }, 10_000);
    await client.start();
    expect(client.serverInfo.name).toBe("fake");
    expect((await client.listTools()).map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(await client.callTool("echo", { text: "salut" })).toEqual({ text: "echo: salut", isError: false });
    expect((await client.callTool("boom", {})).isError).toBe(true);
    client.stop();
  });

  it("registers server tools with the agent and unregisters them on stop", async () => {
    const core = await makeCore();
    await core.mcp.sync([
      { id: "f", name: "fake", command: process.execPath, args: [FAKE_MCP], env: {}, enabled: true },
    ]);
    expect(core.mcp.list()[0]).toMatchObject({ state: "running", tools: ["mcp_fake_echo", "mcp_fake_boom"] });
    const echo = core.tools.get("mcp_fake_echo")!;
    expect(echo.dangerous).toBe(true);
    expect(await echo.run({ text: "x" }, { sessionId: "s", workspace: null })).toBe("echo: x");
    await expect(core.tools.get("mcp_fake_boom")!.run({}, { sessionId: "s", workspace: null })).rejects.toThrow(
      "kaboum",
    );
    await core.mcp.sync([]);
    expect(core.tools.get("mcp_fake_echo")).toBeUndefined();
  });

  it("probe : connexion temporaire, outils listés, rien d'enregistré (Jarod-cordis, test-mcp-server)", async () => {
    const core = await makeCore();
    const cfg = { id: "f", name: "fake", command: process.execPath, args: [FAKE_MCP], env: {}, enabled: false };
    expect((await core.mcp.probe(cfg)).map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(core.tools.get("mcp_fake_echo")).toBeUndefined();
    expect(core.mcp.list()).toEqual([]);
    await expect(core.mcp.probe({ ...cfg, command: "definitely-not-a-command-xyz" })).rejects.toThrow();
  });

  it("reports a server that fails to start", async () => {
    const core = await makeCore();
    await core.mcp.sync([
      { id: "x", name: "nope", command: "definitely-not-a-command-xyz", args: [], env: {}, enabled: true },
    ]);
    expect(core.mcp.list()[0]!.state).toBe("error");
  });
});
