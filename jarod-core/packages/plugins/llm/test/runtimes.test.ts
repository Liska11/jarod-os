// Portage de packages/core/test/runtimes.test.ts (rév. 2e180305).
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { RuntimeProbeService } from "../src/runtimes.js";

function listen(status: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 401 ? { error: "unauthorized" } : { data: [] }));
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Un port que rien n'écoute : le système en attribue un, puis on le libère. */
async function freePort(): Promise<number> {
  const { port, close } = await listen(200);
  await close();
  return port;
}

describe("sondage des serveurs locaux", () => {
  it("trouve le serveur qui écoute sur un port, même hors des ports connus", async () => {
    const server = await listen(200);
    const probe = new RuntimeProbeService({
      ports: () => [{ id: "maison", label: "Serveur maison", port: server.port }],
      timeoutMs: 500,
    });
    const found = await probe.reachable();
    expect(found).toHaveLength(1);
    expect(found.at(0)?.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    expect(found.at(0)?.alive).toBe(true);
    await server.close();
  });

  it("un serveur qui refuse est un serveur présent : 401 veut dire « j'écoute »", async () => {
    const server = await listen(401);
    const probe = new RuntimeProbeService({
      ports: () => [{ id: "porte", label: "Serveur protégé", port: server.port }],
    });
    const found = await probe.reachable();
    expect(found.map((r) => r.id)).toEqual(["porte"]);
    await server.close();
  });

  it("un port muet n'est pas une erreur, c'est une absence", async () => {
    const port = await freePort();
    const probe = new RuntimeProbeService({ ports: () => [{ id: "vide", label: "Rien", port }] });
    const scan = await probe.scan();
    expect(scan).toHaveLength(1);
    expect(scan.at(0)?.alive).toBe(false);
    expect(await probe.reachable()).toHaveLength(0);
  });

  it("sonde tous les serveurs connus en parallèle et rend un verdict par port", async () => {
    const server = await listen(200);
    const probe = new RuntimeProbeService({
      ports: () => [
        { id: "vivant", label: "Vivant", port: server.port },
        { id: "mort", label: "Mort", port: 1 },
      ],
    });
    const scan = await probe.scan();
    expect(scan.map((r) => `${r.id}:${r.alive}`)).toEqual(["vivant:true", "mort:false"]);
    await server.close();
  });
});
