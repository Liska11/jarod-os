// Un serveur d'API qui accepte la connexion et ne répond jamais ne doit pas suspendre un envoi sans fin (Slack, Discord).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordGateway } from "../src/discord.js";
import { SlackGateway } from "../src/slack.js";

let server: Server | null = null;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** Accepte, lit, ne répond jamais. */
function mute(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(() => undefined).listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

describe("délai des appels d'API des passerelles", () => {
  it("Slack : send() échoue après le délai au lieu de rester suspendu", async () => {
    const base = await mute();
    const gw = new SlackGateway("xoxb-t", "xapp-t", () => [], async () => "", { apiBase: base, requestTimeoutMs: 150 });
    const started = Date.now();

    await expect(gw.send("C1", "bonjour")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("Slack : l'envoi d'un fichier (3 appels) est aussi borné", async () => {
    const base = await mute();
    const gw = new SlackGateway("xoxb-t", "xapp-t", () => [], async () => "", { apiBase: base, requestTimeoutMs: 150 });

    await expect(gw.sendFile("C1", "a.txt", Buffer.from("x"))).rejects.toThrow();
  });

  it("Discord : send() et sendFile() échouent après le délai", async () => {
    const base = await mute();
    const gw = new DiscordGateway("t", () => [], async () => "", { apiBase: base, requestTimeoutMs: 150 });

    await expect(gw.send("C1", "bonjour")).rejects.toThrow();
    await expect(gw.sendFile("C1", "a.txt", Buffer.from("x"))).rejects.toThrow();
  });
});
