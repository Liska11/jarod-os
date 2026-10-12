// Portage de packages/core/test/whatsapp.test.ts (rév. 2e180305).
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WHATSAPP_CONFIG,
  normalizeNumber,
  verifySignature,
  WHATSAPP_APP_SECRET_KEY,
  WHATSAPP_TOKEN_KEY,
  type WhatsAppConfig,
  WhatsAppGateway,
  whatsappMime,
} from "../src/whatsapp.js";
import { makeCore } from "./helpers.js";

const APP_SECRET = "secret-d-application";
const VERIFY = "jeton-de-verification";

const servers: Server[] = [];
const gateways: WhatsAppGateway[] = [];
afterEach(() => {
  for (const g of gateways.splice(0)) g.stop();
  for (const s of servers.splice(0)) s.close();
});

interface Call {
  method: string;
  path: string;
  auth: string;
  body: any;
  raw: string;
}

/** Fake Graph API: records every call and answers from `routes` ("METHOD path" → JSON). */
function fakeGraph(routes: Record<string, unknown> = {}): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const path = (req.url ?? "").replace(/^\/v[\d.]+\//, "").replace(/^\//, "");
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {}
        calls.push({ method: req.method ?? "", path, auth: String(req.headers.authorization), body, raw });
        const key = `${req.method} ${path.split("?")[0]}`;
        if (key.startsWith("GET MEDIA")) {
          // Media lookup: Meta answers with a short-lived URL, here the binary route of this server.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ url: `http://${req.headers.host}/media.bin`, mime_type: "image/jpeg" }));
          return;
        }
        if (key === "GET media.bin") {
          res.writeHead(200, { "content-type": "image/jpeg" });
          res.end(Buffer.from("octets-de-photo"));
          return;
        }
        const answer = routes[key] ?? (req.method === "POST" ? { messages: [{ id: "wamid.out" }] } : {});
        const status = (answer as { error?: unknown }).error ? 400 : 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls }),
    );
  });
}

const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

/** A webhook body as Meta sends it for one incoming message. */
function webhook(message: Record<string, unknown>, opts: { phoneNumberId?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "33100000000", phone_number_id: opts.phoneNumberId ?? "PNID" },
              contacts: [{ wa_id: message.from, profile: { name: opts.name ?? "Alice" } }],
              messages: [{ timestamp: "1", ...message }],
            },
          },
        ],
      },
    ],
  });
}

const post = (port: number, raw: string, signature: string | null = sign(raw)) =>
  fetch(`http://127.0.0.1:${port}/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    body: raw,
  });

async function startGateway(
  base: string,
  over: Partial<WhatsAppConfig> = {},
  handler: (m: {
    from: string;
    name: string;
    text: string;
    files: { name: string; download(): Promise<Buffer> }[];
  }) => Promise<string> = async (m) => `écho : ${m.text}`,
) {
  const ignored: string[] = [];
  const cfg: WhatsAppConfig = {
    ...DEFAULT_WHATSAPP_CONFIG,
    enabled: true,
    phoneNumberId: "PNID",
    port: 0,
    allowedNumbers: ["+33 6 12 34 56 78"],
    ...over,
  };
  const gw = new WhatsAppGateway(
    () => cfg,
    { token: "EAAG-jeton", appSecret: APP_SECRET, verifyToken: VERIFY },
    handler,
    {
      apiBase: base,
      unknown: (from, name) => `Code pour ${name} (${from}) : ABC123`,
      onIgnored: (why) => ignored.push(why),
    },
  );
  gateways.push(gw);
  await gw.start();
  return { gw, ignored };
}

const sent = (calls: Call[]) => calls.filter((c) => c.path === "PNID/messages" && c.body.type === "text");

describe("utilitaires WhatsApp", () => {
  it("vérifie la signature HMAC du corps, et rien d'autre", () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifySignature(sign('{"a":1}'), raw, APP_SECRET)).toBe(true);
    expect(verifySignature(sign('{"a":2}'), raw, APP_SECRET)).toBe(false);
    expect(verifySignature(sign('{"a":1}', "autre"), raw, APP_SECRET)).toBe(false);
    expect(verifySignature("", raw, APP_SECRET)).toBe(false);
    expect(verifySignature("sha256=zz", raw, APP_SECRET)).toBe(false);
    expect(verifySignature(sign('{"a":1}'), raw, "")).toBe(false);
  });

  it("normalise les numéros et choisit un type MIME accepté par WhatsApp", () => {
    expect(normalizeNumber("+33 6 12-34.56 78")).toBe("33612345678");
    expect(whatsappMime("rapport.pdf")).toBe("application/pdf");
    expect(whatsappMime("tableau.xlsx")).toContain("spreadsheetml");
    expect(whatsappMime("notes.md")).toBe("text/plain");
    expect(whatsappMime("archive.zip")).toBeNull();
  });
});

describe("passerelle WhatsApp", () => {
  it("répond à la vérification de Meta seulement avec le bon jeton", async () => {
    const { base } = await fakeGraph({ "GET PNID": { verified_name: "Jarod", display_phone_number: "+33 1" } });
    const { gw } = await startGateway(base);
    expect(gw.status).toMatchObject({ state: "running", botName: "Jarod" });
    const ok = await fetch(
      `http://127.0.0.1:${gw.port}/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("4242");
    const ko = await fetch(
      `http://127.0.0.1:${gw.port}/whatsapp?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=1`,
    );
    expect(ko.status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${gw.port}/ailleurs`)).status).toBe(404);
  });

  it("refuse un message non signé ou mal signé sans le lire", async () => {
    const { base, calls } = await fakeGraph();
    const seen: string[] = [];
    const { gw, ignored } = await startGateway(base, {}, async (m) => {
      seen.push(m.text);
      return "non";
    });
    const raw = webhook({ id: "wamid.1", from: "33612345678", type: "text", text: { body: "salut" } });
    expect((await post(gw.port, raw, null)).status).toBe(401);
    expect((await post(gw.port, raw, sign(raw, "pas-le-bon"))).status).toBe(401);
    await gw.idle();
    expect(seen).toEqual([]);
    expect(sent(calls)).toEqual([]);
    expect(ignored.length).toBe(2);
  });

  it("répond à un numéro autorisé, une seule fois par message, et marque le message lu", async () => {
    const { base, calls } = await fakeGraph();
    const seen: { from: string; name: string; text: string }[] = [];
    const { gw } = await startGateway(base, {}, async (m) => {
      seen.push({ from: m.from, name: m.name, text: m.text });
      return `écho : ${m.text}`;
    });
    const raw = webhook({ id: "wamid.1", from: "33612345678", type: "text", text: { body: "quelle heure ?" } });
    expect((await post(gw.port, raw)).status).toBe(200);
    // Meta redelivers: the same message id must not start a second run.
    expect((await post(gw.port, raw)).status).toBe(200);
    await gw.idle();
    expect(seen).toEqual([{ from: "33612345678", name: "Alice", text: "quelle heure ?" }]);
    const out = sent(calls);
    expect(out).toHaveLength(1);
    expect(out[0]!.auth).toBe("Bearer EAAG-jeton");
    expect(out[0]!.body).toMatchObject({ to: "33612345678", text: { body: "écho : quelle heure ?" } });
    expect(calls.some((c) => c.body?.status === "read" && c.body.message_id === "wamid.1")).toBe(true);
  });

  it("donne un code d'appairage à un inconnu, et ignore les messages d'un autre numéro de l'app", async () => {
    const { base, calls } = await fakeGraph();
    const seen: string[] = [];
    const { gw } = await startGateway(base, {}, async (m) => {
      seen.push(m.text);
      return "?";
    });
    await post(
      gw.port,
      webhook({ id: "wamid.2", from: "4915112345678", type: "text", text: { body: "hello" } }, { name: "Bob" }),
    );
    await post(
      gw.port,
      webhook(
        { id: "wamid.3", from: "33612345678", type: "text", text: { body: "pas pour nous" } },
        { phoneNumberId: "AUTRE" },
      ),
    );
    await gw.idle();
    expect(seen).toEqual([]);
    const out = sent(calls);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toMatchObject({
      to: "4915112345678",
      text: { body: "Code pour Bob (4915112345678) : ABC123" },
    });
  });

  it("télécharge une photo reçue avec sa légende", async () => {
    const { base } = await fakeGraph();
    const photos: string[] = [];
    const { gw } = await startGateway(base, {}, async (m) => {
      photos.push(`${m.text}|${m.files[0]!.name}|${(await m.files[0]!.download()).toString()}`);
      return "jolie photo";
    });
    const image = { id: "MEDIA1", mime_type: "image/jpeg", caption: "regarde" };
    await post(gw.port, webhook({ id: "wamid.4", from: "33612345678", type: "image", image }));
    await gw.idle();
    expect(photos).toEqual(["regarde|image-MEDIA1.jpg|octets-de-photo"]);
  });

  it("envoie un fichier en document après l'avoir téléversé, et explique la fenêtre de 24 h", async () => {
    const { base, calls } = await fakeGraph({ "POST PNID/media": { id: "UPLOADED" } });
    const { gw } = await startGateway(base);
    await gw.sendFile("+33 6 12 34 56 78", "rapport.pdf", Buffer.from("%PDF"), "Le rapport");
    const upload = calls.find((c) => c.path === "PNID/media")!;
    expect(upload.raw).toContain("application/pdf");
    expect(upload.raw).toContain("rapport.pdf");
    const doc = calls.find((c) => c.body?.type === "document")!;
    expect(doc.body).toMatchObject({
      to: "33612345678",
      document: { id: "UPLOADED", filename: "rapport.pdf", caption: "Le rapport" },
    });
    await expect(gw.sendFile("33612345678", "a.zip", Buffer.from("x"))).rejects.toThrow(/n'accepte pas/);

    const closed = await fakeGraph({
      "POST PNID/messages": { error: { code: 131047, message: "Re-engagement message" } },
    });
    const { gw: late } = await startGateway(closed.base);
    await expect(late.send("33612345678", "rappel")).rejects.toThrow(/24 h/);
  });

  it("signale un jeton refusé sans fermer le webhook", async () => {
    const { base } = await fakeGraph({ "GET PNID": { error: { code: 190, message: "expired" } } });
    const { gw } = await startGateway(base);
    expect(gw.status).toMatchObject({ state: "error", error: "Jeton d'accès WhatsApp expiré ou invalide." });
    expect(gw.port).toBeGreaterThan(0);
  });
});

describe("WhatsApp dans le cœur", () => {
  it("démarre depuis les réglages, appaire un inconnu et livre une tâche planifiée", async () => {
    const { base, calls } = await fakeGraph({ "GET PNID": { verified_name: "Jarod" } });
    const core = await makeCore({ whatsappApiBase: base });
    core.settings.setSecret(WHATSAPP_TOKEN_KEY, "EAAG-jeton");
    core.settings.setSecret(WHATSAPP_APP_SECRET_KEY, APP_SECRET);
    core.settings.set("whatsapp", { enabled: true, phoneNumberId: "PNID", port: 0, allowedNumbers: [] });
    await core.syncWhatsApp();
    expect(core.gatewayStatus("whatsapp")).toMatchObject({ state: "running", botName: "Jarod" });
    const gw = core.whatsapp!;

    // The verify token is created once and served to Meta's check.
    const verify = core.whatsappVerifyToken();
    expect(verify).toBe(core.whatsappVerifyToken());
    const check = await fetch(
      `http://127.0.0.1:${gw.port}/whatsapp?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=ok`,
    );
    expect(await check.text()).toBe("ok");

    await post(gw.port, webhook({ id: "wamid.9", from: "33699999999", type: "text", text: { body: "bonjour" } }));
    await gw.idle();
    const [req] = core.pairing.list();
    expect(req).toMatchObject({ gateway: "whatsapp", subjectId: "33699999999", name: "Alice" });
    expect(sent(calls).at(-1)!.body.text.body).toContain(req!.code);

    await core.pairing.approve(req!.code);
    expect(core.settings.get("whatsapp").allowedNumbers).toEqual(["33699999999"]);
    expect(sent(calls).at(-1)!.body.text.body).toMatch(/Accès accordé/);

    await core.deliver({ gateway: "whatsapp", chatId: "33699999999" }, "⏰ Rappel");
    expect(sent(calls).at(-1)!.body).toMatchObject({ to: "33699999999", text: { body: "⏰ Rappel" } });

    core.settings.set("whatsapp", { ...core.settings.get("whatsapp"), enabled: false });
    await core.syncWhatsApp();
    expect(core.gatewayStatus("whatsapp").state).toBe("stopped");
    await expect(core.deliver({ gateway: "whatsapp", chatId: "1" }, "x")).rejects.toThrow(/pas connectée/);
  });
});
