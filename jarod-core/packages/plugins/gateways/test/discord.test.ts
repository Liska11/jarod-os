// Portage d'extraits de packages/core/test (rév. 2e180305) — plages fichier:lignes ci-dessous.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordGateway } from "../src/discord.js";
import { makeCore, type TestCore as JarodCore, tempDir } from "./helpers.js";

// round3.test.ts:15-60
let server: Server | null = null;
afterEach(() => server?.close());

type Handler = (
  req: IncomingMessage,
  body: Buffer,
) => { status?: number; json?: unknown; text?: string; lines?: unknown[] };

function serve(handler: Handler): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const r = handler(req, Buffer.concat(chunks));
        res.writeHead(r.status ?? 200, { "content-type": r.lines ? "application/x-ndjson" : "application/json" });
        if (r.lines) res.end(`${r.lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
        else res.end(r.text ?? JSON.stringify(r.json ?? {}));
      });
    }).listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

function script(core: JarodCore, replies: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => [],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r = {
        text: "",
        thinking: "",
        toolCalls: [],
        stopReason: "end",
        inputTokens: 1,
        outputTokens: 1,
        ...(replies.shift() ?? { text: "fin" }),
      };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

// round3.test.ts:234-309
describe("discord gateway", () => {
  it("answers DMs and mentions from allowed users, refuses others, ignores bots and chatter", async () => {
    const sent: { channel: string; content: string }[] = [];
    const api = await serve((req, body) => {
      if (req.url === "/users/@me") return { json: { id: "BOT", username: "jarod" } };
      const m = /\/channels\/(\w+)\/messages/.exec(req.url ?? "");
      if (m) sent.push({ channel: m[1]!, content: JSON.parse(body.toString()).content });
      return { status: 204, text: "" };
    });
    const seen: string[] = [];
    const gw = new DiscordGateway(
      "tok",
      () => ["U1"],
      async (msg) => {
        seen.push(msg.text);
        return `écho : ${msg.text}`;
      },
      { apiBase: api },
    );
    await gw.handleDispatch("READY", { user: { id: "BOT", username: "jarod" } });
    expect(gw.status).toMatchObject({ state: "running", botName: "jarod" });

    await gw.handleDispatch("MESSAGE_CREATE", {
      channel_id: "C1",
      content: "salut",
      author: { id: "U1", username: "ana" },
    });
    await gw.handleDispatch("MESSAGE_CREATE", {
      channel_id: "C2",
      guild_id: "G",
      content: "<@BOT> quelle heure ?",
      mentions: [{ id: "BOT" }],
      author: { id: "U1", username: "ana" },
    });
    await gw.handleDispatch("MESSAGE_CREATE", {
      channel_id: "C2",
      guild_id: "G",
      content: "discussion sans mention",
      mentions: [],
      author: { id: "U1", username: "ana" },
    });
    await gw.handleDispatch("MESSAGE_CREATE", {
      channel_id: "C3",
      content: "hack",
      author: { id: "U9", username: "intrus" },
    });
    await gw.handleDispatch("MESSAGE_CREATE", {
      channel_id: "C1",
      content: "je suis un bot",
      author: { id: "B2", username: "b", bot: true },
    });

    expect(seen).toEqual(["salut", "quelle heure ?"]);
    expect(sent).toEqual([
      { channel: "C1", content: "écho : salut" },
      { channel: "C2", content: "écho : quelle heure ?" },
      { channel: "C3", content: expect.stringMatching(/Accès refusé.*U9/) },
    ]);
  });

  it("routes Discord messages to per-channel conversations through the core", async () => {
    const core = await makeCore({ dataDir: tempDir() });
    script(core, [{ text: "réponse 1" }, { text: "réponse 2" }]);
    expect(await core.handleGatewayMessage("discord", "C1", "bonjour", "ana")).toBe("réponse 1");
    expect(await core.handleGatewayMessage("discord", "C1", "encore", "ana")).toBe("réponse 2");
    const sessions = core.sessions.list();
    expect(sessions).toHaveLength(1);
    expect(
      core.messages
        .list(sessions[0]!.id)
        .filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["bonjour", "encore"]);
    await core.dispose();
  });
});
