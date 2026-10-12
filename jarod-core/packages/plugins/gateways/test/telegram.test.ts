// Portage d'extraits de packages/core/test (rév. 2e180305) — plages fichier:lignes ci-dessous.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ChatRequest, type ChatResult, type ProviderClient, TELEGRAM_TOKEN_KEY } from "@jarod/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { splitMessage, TelegramGateway } from "../src/telegram.js";
import { makeCore, type TestCore as JarodCore, tempDir } from "./helpers.js";

// features.test.ts:15-40
type Reply = Partial<ChatResult> | ((req: ChatRequest) => Partial<ChatResult>);

/** Scripted provider; each chat() call consumes the next reply. */
function script(core: JarodCore, replies: Reply[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => [],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const next = replies.shift() ?? { text: "(fin du script)" };
      const r = {
        text: "",
        thinking: "",
        toolCalls: [],
        stopReason: "end",
        inputTokens: 1,
        outputTokens: 1,
        ...(typeof next === "function" ? next(req) : next),
      };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  return requests;
}

// features.test.ts:303-355
describe("telegram gateway", () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  it("splits long messages", () => {
    const parts = splitMessage(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(parts.map((p) => p.length)).toEqual([3000, 3000]);
    expect(splitMessage("x".repeat(9000)).length).toBe(3);
  });

  it("answers allowed chats through the agent and refuses others", async () => {
    const sent: { chat_id: string; text: string }[] = [];
    const queue = [
      [{ update_id: 1, message: { chat: { id: 42 }, text: "Bonjour", from: { first_name: "Ana" } } }],
      [{ update_id: 2, message: { chat: { id: 99 }, text: "Salut", from: { first_name: "Intrus" } } }],
    ];
    const api = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          const method = req.url!.split("/").pop();
          const json = body ? JSON.parse(body) : {};
          let result: unknown = true;
          if (method === "getMe") result = { username: "jarod_bot" };
          if (method === "getUpdates") {
            const next = queue.shift();
            if (!next) await new Promise((r) => setTimeout(r, 200));
            result = next ?? [];
          }
          if (method === "sendMessage") sent.push({ chat_id: String(json.chat_id), text: json.text });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        });
      }).listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });

    const core = await makeCore({ dataDir: tempDir(), telegramApiBase: api });
    script(core, [{ text: "Bonjour Ana !" }]);
    core.settings.patch({ telegram: { enabled: true, allowedChatIds: ["42"] }, autoTitle: false });
    core.settings.setSecret(TELEGRAM_TOKEN_KEY, "123:abc");
    const statuses: string[] = [];
    core.on("gateway", (s) => statuses.push(s.state));
    await core.syncTelegram();
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await core.dispose();

    expect(statuses).toContain("running");
    expect(sent.find((m) => m.chat_id === "42")?.text).toBe("Bonjour Ana !");
    // An unknown chat is not answered by the agent: it gets a pairing code for the owner to approve.
    expect(sent.find((m) => m.chat_id === "99")?.text).toMatch(/code d'appairage : [A-Z2-9]{6}/);
  });

  it("B3 : une erreur qui cite l'URL de l'API ne publie jamais le jeton (statut masqué)", async () => {
    const token = "000000:jarod-test-fake-token";
    // URL invalide : le message d'erreur de fetch cite l'URL entière, donc le jeton.
    const gw = new TelegramGateway(token, () => [], async () => "", "http://[::1");
    const statuses: { state: string; error?: string }[] = [];
    gw.on("status", (st) => statuses.push(st));
    await gw.start();
    gw.stop();
    expect(statuses[0]).toMatchObject({ state: "error" });
    expect(statuses[0]!.error).toMatch(/<jeton>/);
    expect(JSON.stringify(statuses)).not.toContain(token);
  });

  it("ne confirme l'offset à Telegram qu'après la fin du traitement (un incident rejoue le message)", async () => {
    const offsets: number[] = [];
    const sent: string[] = [];
    const queue: unknown[] = [[{ update_id: 7, message: { chat: { id: 42 }, text: "Bonjour" } }]];
    let inFlight = 0;
    let confirmedInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const api = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          const method = req.url!.split("/").pop();
          const json = body ? JSON.parse(body) : {};
          let result: unknown = true;
          if (method === "getMe") result = { username: "jarod_bot" };
          if (method === "getUpdates") {
            offsets.push(json.offset);
            // Telegram tient une mise à jour pour acquise dès qu'un getUpdates cite un offset plus
            // grand (au-delà de son `update_id`) : c'est cette confirmation pendant le traitement qui
            // perdait le message.
            if (inFlight > 0 && json.offset > 0) confirmedInFlight++;
            const next = queue.shift();
            if (!next) await new Promise((r) => setTimeout(r, 200));
            result = next ?? [];
          }
          if (method === "sendMessage") sent.push(json.text);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        });
      }).listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });

    const gw = new TelegramGateway(
      "123:abc",
      () => ["42"],
      async () => {
        inFlight = 1;
        entered();
        await gate;
        inFlight = 0;
        return "Bonjour Bob !";
      },
      api,
    );
    await gw.start();
    await started; // le message est en cours de traitement
    // Laisse le temps à la boucle de reprendre si elle ne patiente pas après le traitement.
    for (let i = 0; i < 25 && !confirmedInFlight; i++) await new Promise((r) => setTimeout(r, 20));
    expect(confirmedInFlight).toBe(0); // la mutation (offset avancé avant, `void this.handle`) donne 1
    expect(offsets).toEqual([0]);
    expect(sent).toEqual([]); // rien n'est répondu avant la fin du traitement

    release();
    for (let i = 0; i < 50 && !(sent.length && offsets.includes(8)); i++) await new Promise((r) => setTimeout(r, 20));
    gw.stop();
    expect(sent).toEqual(["Bonjour Bob !"]);
    // L'offset n'est avancé qu'après la réponse, et il ne repart jamais de zéro (aucun doublon).
    expect(offsets.every((o) => o === 0 || o === 8)).toBe(true);
    expect(offsets).toContain(8);
  });
});
