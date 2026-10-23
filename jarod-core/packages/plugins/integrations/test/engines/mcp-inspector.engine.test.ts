// G9 contre MCP Inspector réel (engines/mcp-inspector, 2.9.0) et le serveur MCP du SDK officiel (fixture de plugin-mcp).
// Bouclage, jeton obligatoire, jeton absent de l'URL et de la sortie, port occupé jamais libéré de force, arrêt de SA seule instance.
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRefused } from "../../src/impl/common.js";
import { inspectorList, portFree, startInspector } from "../../src/impl/mcp-inspector.js";
import { ROOT } from "./helpers.js";

const ENGINE = join(ROOT, "engines", "mcp-inspector");
const has = existsSync(join(ENGINE, "node_modules", "@modelcontextprotocol", "inspector", "package.json"));
if (!has) console.warn(`[moteurs] ${ENGINE} absent : les tests MCP Inspector réels sont ignorés (voir engines.lock/README.md)`);
const FIXTURE = join(ROOT, "jarod-core", "packages", "plugins", "mcp", "test", "fixtures", "sdk-server.mjs");
const server = { name: "sdk-fixture", command: process.execPath, args: [FIXTURE] };

/** Une adresse IPv4 de la machine qui n'est pas le bouclage (pour prouver que rien n'y écoute). */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe.skipIf(!has)("G9 contre MCP Inspector réel", () => {
  it("lit le catalogue d'outils d'un vrai serveur MCP (mode ligne de commande), sans méthode d'appel", async () => {
    const out = (await inspectorList({ engineDir: ENGINE, server, method: "tools/list" })) as { tools: { name: string }[] };
    expect(out.tools.map((t) => t.name).sort()).toEqual(["add", "fail"]);
    await expect(inspectorList({ engineDir: ENGINE, server, method: "tools/call" as never })).rejects.toBeInstanceOf(AdapterRefused);
  }, 60_000);

  it("interface web : bouclage seul, jeton exigé, jeton absent de l'URL et de la sortie ; arrêt et port libéré", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("jarod-mcp-inspector-")).length;
    const inst = await startInspector({ engineDir: ENGINE, server, port: 26274 });
    try {
      expect(inst.url).toBe("http://127.0.0.1:26274/");
      expect(inst.url).not.toContain(inst.token);
      const anon = await fetch(`${inst.url}api/config`);
      expect(anon.status).toBe(401);
      const authed = await fetch(`${inst.url}api/servers`, { headers: { "x-mcp-remote-auth": `Bearer ${inst.token}` } });
      expect(authed.status).toBe(200);
      expect(Object.keys(((await authed.json()) as { mcpServers: object }).mcpServers)).toEqual(["sdk-fixture"]);
      const wrong = await fetch(`${inst.url}api/config`, { headers: { "x-mcp-remote-auth": "Bearer faux" } });
      expect(wrong.status).toBe(401);
      if (lanAddress) await expect(fetch(`http://${lanAddress}:26274/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      expect(inst.output()).toContain("[jeton]");
      expect(inst.output()).not.toContain(inst.token);
    } finally {
      await inst.stop();
    }
    expect(await portFree(26274)).toBe(true);
    expect(await portFree(26275)).toBe(true);
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith("jarod-mcp-inspector-")).length).toBeLessThanOrEqual(before);
  }, 90_000);

  it("port déjà pris par un AUTRE programme : refus, et ce programme reste en marche", async () => {
    const other: Server = createServer();
    await new Promise<void>((r) => other.listen({ host: "127.0.0.1", port: 26284 }, () => r()));
    try {
      await expect(startInspector({ engineDir: ENGINE, port: 26284 })).rejects.toThrow(/déjà utilisé par un autre programme/);
      expect(other.listening).toBe(true);
    } finally {
      await new Promise((r) => other.close(r));
    }
  });

  it("moteur absent : indisponible, avec la raison", async () => {
    await expect(startInspector({ engineDir: join(ROOT, "engines", "nope") })).rejects.toThrow(/introuvable/);
  });
});
