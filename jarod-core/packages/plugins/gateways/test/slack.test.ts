// Portage de packages/core/test/slack.test.ts (rév. 2e180305).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SlackGateway, toMrkdwn } from "../src/slack.js";

let server: Server | null = null;
afterEach(() => server?.close());

interface Call {
  method: string;
  auth: string;
  body: any;
}

/** Fake Slack Web API: records calls, answers from `routes` (default `{ ok: true }`). */
function fakeSlack(routes: Record<string, unknown> = {}): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const method = (req.url ?? "").slice(1);
        calls.push({
          method,
          auth: String(req.headers.authorization),
          body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(routes[method] ?? { ok: true }));
      });
    }).listen(0, () => resolve({ base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls }));
  });
}

describe("slack gateway", () => {
  it("answers DMs and mentions from allowed users, refuses others, ignores bots and chatter", async () => {
    const { base, calls } = await fakeSlack({
      "auth.test": { ok: true, user_id: "UBOT", user: "jarod" },
      "apps.connections.open": { ok: false, error: "invalid_auth" },
    });
    const seen: { text: string; threadTs?: string }[] = [];
    const gw = new SlackGateway(
      "xoxb-1",
      "xapp-1",
      () => ["U1"],
      async (msg) => {
        seen.push({ text: msg.text, ...(msg.threadTs ? { threadTs: msg.threadTs } : {}) });
        return `**écho** : ${msg.text}`;
      },
      { apiBase: base },
    );
    await gw.start();
    expect(gw.status.botName).toBe("jarod");

    await gw.handleEvent({ type: "message", channel_type: "im", channel: "D1", user: "U1", text: "salut", ts: "1.0" });
    await gw.handleEvent({ type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> quelle heure ?", ts: "2.0" });
    // Same channel message also delivered as `message`: must not be answered twice.
    await gw.handleEvent({
      type: "message",
      channel_type: "channel",
      channel: "C1",
      user: "U1",
      text: "<@UBOT> quelle heure ?",
      ts: "2.0",
    });
    await gw.handleEvent({
      type: "message",
      channel_type: "im",
      channel: "D1",
      bot_id: "B1",
      user: "UBOT",
      text: "moi-même",
    });
    await gw.handleEvent({
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      subtype: "message_changed",
      text: "édité",
    });
    await gw.handleEvent({ type: "message", channel_type: "im", channel: "D2", user: "U9", text: "intrus" });

    expect(seen).toEqual([{ text: "salut" }, { text: "quelle heure ?", threadTs: "2.0" }]);
    const posts = calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body);
    expect(posts).toEqual([
      { channel: "D1", text: "*écho* : salut" },
      { channel: "C1", text: "*écho* : quelle heure ?", thread_ts: "2.0" },
      { channel: "D2", text: expect.stringContaining("U9") },
    ]);
    expect(calls.find((c) => c.method === "chat.postMessage")?.auth).toBe("Bearer xoxb-1");
    gw.stop();
  });

  it("reports a bad bot token and a bad app token without looping", async () => {
    const bad = await fakeSlack({ "auth.test": { ok: false, error: "invalid_auth" } });
    const gw = new SlackGateway(
      "xoxb-bad",
      "xapp-1",
      () => [],
      async () => "",
      { apiBase: bad.base },
    );
    await gw.start();
    expect(gw.status).toMatchObject({ state: "error", error: expect.stringContaining("xoxb-") });
    server?.close();

    const badApp = await fakeSlack({
      "auth.test": { ok: true, user_id: "UBOT", user: "jarod" },
      "apps.connections.open": { ok: false, error: "not_allowed_token_type" },
    });
    const gw2 = new SlackGateway(
      "xoxb-1",
      "xoxb-1",
      () => [],
      async () => "",
      { apiBase: badApp.base },
    );
    await gw2.start();
    expect(gw2.status).toMatchObject({ state: "error", error: expect.stringContaining("xapp-") });
    expect(badApp.calls.find((c) => c.method === "apps.connections.open")?.auth).toBe("Bearer xoxb-1");
    gw2.stop();
  });

  it("converts Markdown to Slack mrkdwn without touching code", () => {
    expect(toMrkdwn("## Titre\n**gras** et ~~barré~~, [site](https://ex.com)")).toBe(
      "*Titre*\n*gras* et ~barré~, <https://ex.com|site>",
    );
    expect(toMrkdwn("voir `**x**` puis\n```ts\nconst a = **b**;\n```")).toBe(
      "voir `**x**` puis\n```\nconst a = **b**;\n```",
    );
  });
});
