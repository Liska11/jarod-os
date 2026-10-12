// Portage de packages/core/test/present.test.ts (rév. 2e180305).
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordGateway } from "../src/discord.js";
import { SlackGateway } from "../src/slack.js";
import { TelegramGateway } from "../src/telegram.js";
import { makeCore, tempDir } from "./helpers.js";

interface Seen {
  method: string;
  url: string;
  type: string;
  auth: string;
  body: string;
}

let server: Server | null = null;
afterEach(() => server?.close());

/** A local server that records every request and answers what each gateway expects. */
function api(answer: (url: string) => unknown): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          type: String(req.headers["content-type"] ?? ""),
          auth: String(req.headers.authorization ?? ""),
          body: Buffer.concat(chunks).toString("latin1"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(req.url ?? "")));
      });
    }).listen(0, () => resolve({ base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen }));
  });
}

describe("present", () => {
  async function setup() {
    const core = await makeCore();
    const ws = tempDir();
    core.settings.set("workspace", ws);
    writeFileSync(join(ws, "rapport.pdf"), "%PDF-1.4 contenu");
    return { core, ws, tool: core.tools.get("present")! };
  }

  it("lists the files in an app conversation, and logs the hand-over", async () => {
    const { core, ws, tool } = await setup();
    const s = core.sessions.create();
    const out = await tool.run({ paths: ["rapport.pdf"] }, { sessionId: s.id, workspace: ws });
    expect(out).toBe(`Fichiers remis :\n- ${join(ws, "rapport.pdf")} (16 o)`);
    expect(core.events.list({ stream: `session:${s.id}` }).at(-1)).toMatchObject({ type: "deliverable" });
  });

  it("sends the files to the messaging chat the conversation comes from", async () => {
    const { core, ws, tool } = await setup();
    const sendFile = vi.fn(async () => {});
    core.telegram = { sendFile, send: async () => {}, stop: () => {} } as never;
    const s = core.sessions.create();
    core.db.run("INSERT INTO gateway_chats (gateway, chat_id, session_id) VALUES ('telegram', '42', ?)", s.id);
    const out = await tool.run(
      { paths: ["rapport.pdf"], caption: "Le rapport du mois" },
      { sessionId: s.id, workspace: ws },
    );
    expect(out).toBe("Envoyés sur telegram : rapport.pdf");
    expect(sendFile).toHaveBeenCalledWith("42", "rapport.pdf", expect.any(Buffer), "Le rapport du mois");
  });

  it("only hands over existing files of the working folder, a few at a time", async () => {
    const { ws, tool } = await setup();
    const ctx = { sessionId: "s", workspace: ws };
    await expect(tool.run({ paths: ["absent.txt"] }, ctx)).rejects.toThrow(/introuvable/);
    await expect(tool.run({ paths: ["../../secret.txt"] }, ctx)).rejects.toThrow(/hors du dossier/);
    await expect(tool.run({ paths: ["a", "b", "c", "d", "e", "f"] }, ctx)).rejects.toThrow(/Au plus 5/);
  });
});

describe("gateway file uploads", () => {
  const data = Buffer.from("contenu du fichier");

  it("Telegram: sendDocument, multipart, with the caption", async () => {
    const { base, seen } = await api(() => ({ ok: true, result: {} }));
    await new TelegramGateway(
      "T0K",
      () => [],
      async () => "",
      base,
    ).sendFile("42", "a.csv", data, "Voici");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/botT0K/sendDocument" });
    expect(seen[0]!.type).toMatch(/^multipart\/form-data/);
    expect(seen[0]!.body).toContain('name="document"; filename="a.csv"');
    expect(seen[0]!.body).toContain("contenu du fichier");
    expect(seen[0]!.body).toContain("Voici");
  });

  it("Discord: one message with the attachment, authenticated as the bot", async () => {
    const { base, seen } = await api(() => ({ id: "m1" }));
    await new DiscordGateway(
      "D1",
      () => [],
      async () => "",
      { apiBase: base },
    ).sendFile("chan", "b.png", data);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/channels/chan/messages", auth: "Bot D1" });
    expect(seen[0]!.body).toContain('name="files[0]"; filename="b.png"');
    expect(seen[0]!.body).toContain('"attachments":[{"id":0,"filename":"b.png"}]');
  });

  it("Slack: upload URL, upload, then shared in the thread", async () => {
    let uploadUrl = "";
    const { base, seen } = await api((url) =>
      url.startsWith("/files.getUploadURLExternal") ? { ok: true, upload_url: uploadUrl, file_id: "F1" } : { ok: true },
    );
    uploadUrl = `${base}/upload/xyz`;
    await new SlackGateway(
      "xoxb",
      "xapp",
      () => [],
      async () => "",
      { apiBase: base },
    ).sendFile("C9", "c.pdf", data, "Le PDF", "171.5");
    expect(seen.map((s) => s.url)).toEqual([
      "/files.getUploadURLExternal",
      "/upload/xyz",
      "/files.completeUploadExternal",
    ]);
    expect(seen[0]!.body).toBe(`filename=c.pdf&length=${data.length}`);
    expect(seen[1]!.body).toBe("contenu du fichier");
    const done = new URLSearchParams(seen[2]!.body);
    expect(JSON.parse(done.get("files")!)).toEqual([{ id: "F1", title: "c.pdf" }]);
    expect([done.get("channel_id"), done.get("thread_ts"), done.get("initial_comment")]).toEqual([
      "C9",
      "171.5",
      "Le PDF",
    ]);
    expect(seen[2]!.auth).toBe("Bearer xoxb");
  });

  it("a Slack conversation in a thread is delivered to that thread", async () => {
    const core = await makeCore();
    const send = vi.fn(async () => {});
    core.slack = { send, stop: () => {} } as never;
    await core.deliver({ gateway: "slack", chatId: "C9:171.5" }, "bonjour");
    expect(send).toHaveBeenCalledWith("C9", "bonjour", "171.5");
  });
});
