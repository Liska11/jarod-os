// Portage d'extraits de packages/core/test (rév. 2e180305) — plages fichier:lignes ci-dessous.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ChatRequest, type ChatResult, type ProviderClient, type StreamHandlers, TELEGRAM_TOKEN_KEY } from "@jarod/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { makeCore, type TestCore as JarodCore, tempDir, testKeys } from "./helpers.js";

// round4.test.ts:17-33
type Step = Partial<ChatResult> | ((req: ChatRequest, h: StreamHandlers) => Promise<ChatResult>);

function fakeProvider(core: JarodCore, steps: Step[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const step = steps.shift();
      if (typeof step === "function") return step(req, h);
      return { text: "", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 10, outputTokens: 5, ...step };
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

// round4.test.ts:48-61
let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler).listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`),
    );
  });
}


// round4.test.ts:360-422
describe("gateway files", () => {
  it("passes Telegram photos to the agent and reports voice messages it cannot transcribe", async () => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const sent: string[] = [];
    const queue = [
      [
        {
          update_id: 1,
          message: {
            chat: { id: 42 },
            caption: "Qu'est-ce que c'est ?",
            photo: [{ file_id: "small" }, { file_id: "big" }],
            from: { first_name: "Ana" },
          },
        },
      ],
      [
        {
          update_id: 2,
          message: { chat: { id: 42 }, voice: { file_id: "v1", mime_type: "audio/ogg" }, from: { first_name: "Ana" } },
        },
      ],
    ];
    const api = await listen((req, res) => {
      if (req.url!.includes("/file/bot")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(req.url!.endsWith("big.jpg") ? photo : Buffer.from("ogg"));
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const method = req.url!.split("/").pop();
        const json = body ? JSON.parse(body) : {};
        let result: unknown = true;
        if (method === "getMe") result = { username: "jarod_bot" };
        if (method === "getFile") result = { file_path: `photos/${json.file_id}.jpg` };
        if (method === "getUpdates") {
          const next = queue.shift();
          if (!next) await new Promise((r) => setTimeout(r, 200));
          result = next ?? [];
        }
        if (method === "sendMessage") sent.push(json.text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    const core = await makeCore({ dataDir: tempDir(), telegramApiBase: api, keyStores: [testKeys] });
    const reqs = fakeProvider(core, [{ text: "Un chat." }, { text: "Compris." }]);
    core.settings.patch({ telegram: { enabled: true, allowedChatIds: ["42"] } });
    core.settings.setSecret(TELEGRAM_TOKEN_KEY, "123:abc");
    await core.syncTelegram();
    for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const session = core.sessions.list()[0]!;
    const users = core.messages.list(session.id).filter((m) => m.role === "user");
    await core.dispose();

    expect(sent).toEqual(["Un chat.", "Compris."]);
    expect(users[0]!.content).toBe("Qu'est-ce que c'est ?");
    expect(users[0]!.attachments?.[0]).toMatchObject({ name: "photo.jpg", mime: "image/jpeg", size: 4 });
    expect(reqs[0]!.messages[0]!.attachments?.[0]?.kind).toBe("image");
    expect(users[1]!.content).toMatch(/Message vocal non transcrit/);
  });
});
