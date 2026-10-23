// The Android app's door: the end-to-end protocol (`jarod-relay/1`) carried directly by the mobile
// bridge (`/m1/*`), over the LAN or Tailscale. Real server, real requests, real handshake.
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, isPrivateAddress, MobileBridge } from "../src/mobile.js";
import {
  b64uDecode,
  clientHandshake,
  type CryptoKeyPair,
  generateKeyPair,
  type SecureChannel,
} from "../src/remote-protocol.js";
import { makeCore } from "./helpers.js";

type Core = Awaited<ReturnType<typeof makeCore>>;

interface Rig {
  core: Core;
  bridge: MobileBridge;
  base: string;
  stop: () => Promise<unknown>;
}

async function started(): Promise<Rig> {
  const core = await makeCore();
  const bridge = new MobileBridge(core);
  await bridge.start(0);
  return { core, bridge, base: `http://127.0.0.1:${bridge.status().port}`, stop: () => bridge.stop() };
}

/** What the QR code says, read the way the app reads it. */
function parseAppLink(link: string): { hostKey: Uint8Array; secret: Uint8Array; hostId: string; urls: string[] } {
  expect(link.startsWith("jarod://pair#")).toBe(true);
  const p = new URLSearchParams(link.slice(link.indexOf("#") + 1));
  expect(p.get("v")).toBe("2");
  return {
    hostKey: b64uDecode(p.get("k")!),
    secret: b64uDecode(p.get("p")!),
    hostId: p.get("h")!,
    urls: (p.get("u") ?? "").split(",").filter(Boolean),
  };
}

interface Phone {
  denied?: string;
  cid: string;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<{ result?: unknown; error?: string }>;
  /** Pushed messages (`{ event, data }`), in the order they arrived. */
  events: { event: string; data: Record<string, unknown> }[];
  waitFor: (pred: (e: { event: string; data: Record<string, unknown> }) => boolean, ms?: number) => Promise<void>;
  /** Resolves when the PC closes the stream. */
  closed: Promise<void>;
  sendRaw: (frame: string) => Promise<Response>;
  hangUp: () => void;
}

/** A minimal phone: the same steps as `mobile/src/lib/channel.ts`, without the UI. */
async function connect(
  base: string,
  hostKey: Uint8Array,
  keys: CryptoKeyPair,
  opts: { pairingSecret?: Uint8Array; name?: string } = {},
): Promise<Phone> {
  const opened = await fetch(`${base}/m1/open`, { method: "POST" });
  expect(opened.status).toBe(200);
  const { cid } = (await opened.json()) as { cid: string };
  const controller = new AbortController();
  const down = await fetch(`${base}/m1/down?cid=${encodeURIComponent(cid)}`, { signal: controller.signal });
  expect(down.headers.get("content-type")).toContain("text/event-stream");
  const reader = down.body!.getReader();
  const sendRaw = (frame: string) =>
    fetch(`${base}/m1/up?cid=${encodeURIComponent(cid)}`, { method: "POST", body: frame });

  const frames: string[] = [];
  const waiting: ((f: string | null) => void)[] = [];
  let ended = false;
  let buffer = "";
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (markClosed = r));
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        while (buffer.includes("\n\n")) {
          const raw = buffer.slice(0, buffer.indexOf("\n\n"));
          buffer = buffer.slice(buffer.indexOf("\n\n") + 2);
          if (!raw.startsWith("data: ")) continue;
          const f = raw.slice(6);
          const w = waiting.shift();
          if (w) w(f);
          else frames.push(f);
        }
      }
    } catch {
      // aborted
    }
    ended = true;
    for (const w of waiting.splice(0)) w(null);
    markClosed();
  })();
  const next = () =>
    new Promise<string | null>((resolve) => {
      if (frames.length) return resolve(frames.shift()!);
      if (ended) return resolve(null);
      waiting.push(resolve);
    });

  const hs = await clientHandshake(keys, hostKey, { ...opts, name: opts.name ?? "Pixel de test" });
  expect((await sendRaw(JSON.stringify(hs.init))).status).toBe(204);
  const first = await next();
  const answer = JSON.parse(first ?? "{}") as { type: string; reason?: string };
  const phone: Phone = {
    cid,
    rpc: async () => ({ error: "not connected" }),
    events: [],
    waitFor: async () => {},
    closed,
    sendRaw,
    hangUp: () => controller.abort(),
  };
  if (answer.type !== "accept") return { ...phone, denied: answer.reason ?? "?" };

  const channel: SecureChannel = await hs.finish(answer as never);
  const replies = new Map<number, (r: { result?: unknown; error?: string }) => void>();
  const listeners = new Set<() => void>();
  void (async () => {
    for (;;) {
      const f = await next();
      if (f === null) return;
      const msg = (await channel.open(f)) as { id?: number; event?: string; data?: Record<string, unknown> };
      if (typeof msg.id === "number") replies.get(msg.id)?.(msg as never);
      else if (msg.event) {
        phone.events.push({ event: msg.event, data: msg.data ?? {} });
        for (const l of listeners) l();
      }
    }
  })();
  let ids = 0;
  // Frames go up one at a time: their counters must arrive in order.
  let queue: Promise<unknown> = Promise.resolve();
  phone.rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++ids;
      replies.set(id, resolve);
      queue = queue.then(async () => sendRaw(await channel.seal({ id, method, params })));
    });
  phone.waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (phone.events.some(pred)) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`no such event; got ${JSON.stringify(phone.events.map((e) => e.event))}`));
      }, ms);
      listeners.add(check);
      check();
    });
  return phone;
}

/** Pairs a new phone with a fresh QR code; returns its keys and the host key it pinned. */
async function pairPhone(r: Rig, name = "Pixel de test") {
  const { appLink } = await r.bridge.appPairing();
  const info = parseAppLink(appLink);
  const keys = await generateKeyPair();
  const phone = await connect(r.base, info.hostKey, keys, { pairingSecret: info.secret, name });
  expect(phone.denied).toBeUndefined();
  return { keys, info, phone };
}

describe("mobile bridge — who may knock", () => {
  it("answers this computer, the local networks and the tailnet, nobody else", () => {
    for (const a of [
      "127.0.0.1",
      "::1",
      "::ffff:192.168.1.20",
      "10.0.0.4",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.3.3",
      "100.64.0.1",
      "100.101.102.103",
      "100.127.255.255",
      "fd7a:115c:a1e0::1",
      "fe80::1",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "2001:db8::1", "", "nimporte"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it("opens the app's origin on /m1 only, and the page keeps no cross-origin door", async () => {
    const r = await started();
    try {
      const pre = await fetch(`${r.base}/m1/open`, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
      expect((await fetch(`${r.base}/`)).headers.get("access-control-allow-origin")).toBeNull();
      expect((await fetch(`${r.base}/m1/nimporte`)).status).toBe(404);
      expect((await fetch(`${r.base}/m1/down?cid=inconnu`)).status).toBe(404);
      expect((await fetch(`${r.base}/m1/up?cid=inconnu`, { method: "POST", body: "x" })).status).toBe(404);
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — pairing the app", () => {
  it("pairs with the QR code, pins the host key, lists the phone as an app", async () => {
    const r = await started();
    try {
      const { appLink, url, expiresAt } = await r.bridge.appPairing();
      const info = parseAppLink(appLink);
      expect(info.hostKey.length).toBe(32);
      expect(info.secret.length).toBe(32);
      expect(expiresAt).toBeGreaterThan(Date.now());
      // Every address in the link is one the bridge itself would accept.
      for (const u of info.urls) expect(isPrivateAddress(new URL(u).hostname)).toBe(true);
      // The browser link is the same one-time code: either door, once.
      if (url) expect(url.endsWith(new URLSearchParams(appLink.slice(appLink.indexOf("#") + 1)).get("p")!)).toBe(true);

      const keys = await generateKeyPair();
      const phone = await connect(r.base, info.hostKey, keys, { pairingSecret: info.secret, name: "Pixel de Léa" });
      expect(phone.denied).toBeUndefined();
      expect((await phone.rpc("hello")).result).toMatchObject({ app: "Jarod-One", device: "Pixel de Léa" });

      const devices = r.bridge.status().devices;
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ name: "Pixel de Léa", kind: "app" });
      // Nothing secret was written down: the device is its public key.
      const stored = r.core.settings.getAll().remote.devices[0]!;
      expect(Object.keys(stored).sort()).toEqual(["id", "lastSeen", "name", "pairedAt", "publicKey"]);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("spends the code once, for the app and the browser alike", async () => {
    const r = await started();
    try {
      const { appLink } = await r.bridge.appPairing();
      const info = parseAppLink(appLink);
      const first = await connect(r.base, info.hostKey, await generateKeyPair(), { pairingSecret: info.secret });
      expect(first.denied).toBeUndefined();
      const second = await connect(r.base, info.hostKey, await generateKeyPair(), { pairingSecret: info.secret });
      expect(second.denied).toContain("invalide");
      const p = new URLSearchParams(appLink.slice(appLink.indexOf("#") + 1)).get("p");
      const browser = await fetch(`${r.base}/api/pair`, { method: "POST", body: JSON.stringify({ secret: p }) });
      expect(browser.status).toBe(401);
      expect(r.core.settings.getAll().remote.devices).toHaveLength(1);
      expect(r.core.settings.getAll().mobile.devices).toHaveLength(0);
      first.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("refuses an unknown phone that has no code, and closes its channel", async () => {
    const r = await started();
    try {
      const { appLink } = await r.bridge.appPairing();
      const info = parseAppLink(appLink);
      const stranger = await connect(r.base, info.hostKey, await generateKeyPair());
      expect(stranger.denied).toContain("inconnu");
      await stranger.closed;
      expect(r.core.settings.getAll().remote.devices).toEqual([]);
    } finally {
      await r.stop();
    }
  });

  it("lets a phone tell an impostor: a PC without the pinned key cannot finish the handshake", async () => {
    const r = await started();
    try {
      const { appLink } = await r.bridge.appPairing();
      const info = parseAppLink(appLink);
      const wrongKey = new Uint8Array(32).fill(7);
      await expect(connect(r.base, wrongKey, await generateKeyPair(), { pairingSecret: info.secret })).rejects.toThrow(
        /authentifié/,
      );
    } finally {
      await r.stop();
    }
  });

  it("comes back later with its key alone, no code", async () => {
    const r = await started();
    try {
      const { keys, info, phone } = await pairPhone(r);
      phone.hangUp();
      await phone.closed;
      const again = await connect(r.base, info.hostKey, keys);
      expect(again.denied).toBeUndefined();
      expect((await again.rpc("hello")).result).toMatchObject({ app: "Jarod-One" });
      again.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — every request authenticated", () => {
  it("closes the channel on a frame that is not sealed by the device", async () => {
    const r = await started();
    try {
      const { phone } = await pairPhone(r);
      expect((await phone.sendRaw(JSON.stringify({ n: 99, c: "AAAA" }))).status).toBe(204);
      await phone.closed;
      // The id is spent: nothing more goes in through it.
      expect((await phone.sendRaw("x")).status).toBe(404);
    } finally {
      await r.stop();
    }
  });

  it("binds a channel to one stream", async () => {
    const r = await started();
    try {
      const { phone } = await pairPhone(r);
      expect((await fetch(`${r.base}/m1/down?cid=${phone.cid}`)).status).toBe(404);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — the app's conversations", () => {
  it("lists conversations and messages, and streams a run's events", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Depuis le téléphone");
      r.core.messages.add(session.id, { role: "user", content: "Bonjour" });
      r.core.messages.add(session.id, { role: "assistant", content: "Bonjour !" });
      const { phone } = await pairPhone(r);

      const list = (await phone.rpc("sessions.list")).result as { id: string; title: string }[];
      expect(list.map((s) => s.title)).toContain("Depuis le téléphone");
      const messages = (await phone.rpc("messages.list", { sessionId: session.id })).result as { content: string }[];
      expect(messages.map((m) => m.content)).toEqual(["Bonjour", "Bonjour !"]);
      expect((await phone.rpc("messages.list", { sessionId: "inconnu" })).error).toContain("introuvable");

      // No provider is configured here: the run fails, and the phone is told so, live.
      const sent = await phone.rpc("chat.send", { sessionId: session.id, text: "dis bonjour" });
      expect(sent.error).toBeUndefined();
      await phone.waitFor((e) => e.event === "agent" && (e.data.type === "error" || e.data.type === "done"));
      expect(phone.events.find((e) => e.event === "agent")?.data.sessionId).toBe(session.id);
      expect((await phone.rpc("nimporte")).error).toContain("inconnue");
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("transcribes a voice message on this computer and sends what was heard", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Voix");
      const heard: { bytes: number; mime: string }[] = [];
      (r.core.app.gateways as unknown as { transcribeWith: (a: Buffer, m: string) => Promise<string> }).transcribeWith =
        async (audio, mime) => {
          heard.push({ bytes: audio.length, mime });
          return "  quelle heure est-il ?  ";
        };
      const { phone } = await pairPhone(r);
      const audio = Buffer.from("pas vraiment de l'opus").toString("base64");

      expect((await phone.rpc("chat.voice", { sessionId: session.id, audio, mime: "text/html" })).error).toContain(
        "Format",
      );
      expect((await phone.rpc("chat.voice", { sessionId: session.id, audio: "", mime: "audio/webm" })).error).toContain(
        "vide",
      );
      const big = Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64");
      expect((await phone.rpc("chat.voice", { sessionId: session.id, audio: big, mime: "audio/webm" })).error).toContain(
        "trop long",
      );
      expect(heard).toEqual([]);

      const ok = await phone.rpc("chat.voice", { sessionId: session.id, audio, mime: "audio/webm;codecs=opus" });
      expect(ok.result).toMatchObject({ heard: "quelle heure est-il ?" });
      expect(heard).toEqual([{ bytes: 22, mime: "audio/webm;codecs=opus" }]);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — tidying conversations from the phone", () => {
  it("renames a conversation, and refuses an unknown one or an empty title", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Ancien titre");
      const { phone } = await pairPhone(r);
      const renamed = await phone.rpc("sessions.rename", { sessionId: session.id, title: "  Courses\n de la semaine " });
      expect(renamed.result).toEqual({ id: session.id, title: "Courses de la semaine" });
      expect(r.core.sessions.get(session.id)?.title).toBe("Courses de la semaine");
      expect((await phone.rpc("sessions.rename", { sessionId: session.id, title: "   " })).error).toContain("vide");
      expect((await phone.rpc("sessions.rename", { sessionId: "inconnu", title: "x" })).error).toContain("introuvable");
      const long = await phone.rpc("sessions.rename", { sessionId: session.id, title: "a".repeat(500) });
      expect((long.result as { title: string }).title).toHaveLength(120);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("deletes a conversation with its attachments, and refuses an unknown one", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("À supprimer");
      const kept = r.core.sessions.create("À garder");
      const att = r.core.attachments.save("note.txt", "text/plain", Buffer.from("bonjour"));
      r.core.messages.add(session.id, { role: "user", content: "voici", attachments: [att] });
      const { phone } = await pairPhone(r);
      expect((await phone.rpc("sessions.delete", { sessionId: "inconnu" })).error).toContain("introuvable");
      expect((await phone.rpc("sessions.delete", { sessionId: session.id })).result).toBe(true);
      expect(r.core.sessions.get(session.id)).toBeUndefined();
      expect(r.core.attachments.get(att.id)).toBeUndefined();
      expect(r.core.sessions.get(kept.id)).toBeDefined();
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — a photo or file from the phone", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

  it("stores a checked file as an attachment of the conversation and sends it", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Photos");
      const { phone } = await pairPhone(r);
      const sent = await phone.rpc("chat.file", {
        sessionId: session.id,
        name: "photo.png",
        mime: "image/png",
        data: png.toString("base64"),
        text: "que vois-tu ?",
      });
      expect(sent.error).toBeUndefined();
      const { attachment } = sent.result as { attachment: { id: string; name: string; size: number } };
      expect(attachment).toMatchObject({ name: "photo.png", size: png.length });
      expect(r.core.attachments.read(attachment.id).equals(png)).toBe(true);
      await phone.waitFor((e) => e.event === "agent" && (e.data.type === "error" || e.data.type === "done"));
      const messages = (await phone.rpc("messages.list", { sessionId: session.id })).result as {
        role: string;
        content: string;
        attachments?: { name: string; mime: string; size: number }[];
      }[];
      const mine = messages.find((m) => m.role === "user");
      expect(mine?.content).toBe("que vois-tu ?");
      expect(mine?.attachments).toEqual([{ name: "photo.png", mime: "image/png", size: png.length }]);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("refuses an unknown conversation, a bad type, a lying type, an empty or too large file", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Refus");
      const { phone } = await pairPhone(r);
      const send = (params: Record<string, unknown>) =>
        phone.rpc("chat.file", { sessionId: session.id, name: "f", mime: "image/png", data: png.toString("base64"), ...params });

      expect((await send({ sessionId: "inconnu" })).error).toContain("introuvable");
      const exe = Buffer.from("MZ\x90\x00").toString("base64");
      expect((await send({ mime: "application/x-msdownload", data: exe })).error).toContain("non pris en charge");
      expect((await send({ mime: "text/html", data: Buffer.from("<b>x</b>").toString("base64") })).error).toContain(
        "non pris en charge",
      );
      expect((await send({ mime: "image/jpeg" })).error).toContain("ne correspond pas");
      expect((await send({ mime: "text/plain", data: exe })).error).toContain("ne correspond pas");
      expect((await send({ data: "" })).error).toContain("vide");
      const big = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]).toString("base64");
      expect((await send({ data: big })).error).toContain("trop volumineux");

      const text = await send({ name: "liste.txt", mime: "text/plain", data: Buffer.from("œufs, café").toString("base64") });
      expect(text.error).toBeUndefined();
      const stored = r.core.db.all<{ name: string }>("SELECT name FROM attachments");
      expect(stored.map((a) => a.name)).toEqual(["liste.txt"]);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — approvals reach the phone", () => {
  it("asks the phone, one decision per request, and reads nothing but a boolean", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Approbations");
      const { phone } = await pairPhone(r);
      // The hooks a run started from this phone gets (the agent needs a model to get there by itself).
      const host = r.core.remoteHost() as unknown as {
        clients: Map<string, unknown>;
        hooksFor: (c: unknown) => { approve: (s: string, call: unknown, d: string) => Promise<boolean> };
      };
      const client = [...host.clients.values()].find((c) => (c as { cid: string }).cid === phone.cid)!;
      const hooks = host.hooksFor(client);
      const call = { id: "t1", name: "remote_exec", args: { host: "pc-2", command: "dir" } };

      const first = hooks.approve(session.id, call, "Exécuter une commande sur pc-2");
      await phone.waitFor((e) => e.event === "approval");
      const asked = phone.events.find((e) => e.event === "approval")!.data as {
        id: string;
        call: { name: string; args: unknown };
        expiresAt: number;
      };
      expect(asked.call).toMatchObject({ name: "remote_exec", args: { host: "pc-2", command: "dir" } });
      expect(asked.expiresAt).toBeGreaterThan(Date.now());
      // "always" is not a yes.
      expect((await phone.rpc("approval.resolve", { id: asked.id, ok: "always" })).result).toBe(true);
      expect(await first).toBe(false);
      // Spent: the same id decides nothing a second time.
      expect((await phone.rpc("approval.resolve", { id: asked.id, ok: true })).result).toBe(false);

      const second = hooks.approve(session.id, call, "Encore");
      await phone.waitFor((e) => e.event === "approval" && e.data.id !== asked.id);
      const id2 = (phone.events.filter((e) => e.event === "approval").at(-1)!.data as { id: string }).id;
      expect((await phone.rpc("approval.resolve", { id: id2, ok: true })).result).toBe(true);
      expect(await second).toBe(true);

      // A phone that goes away refuses what it had pending.
      const third = hooks.approve(session.id, call, "Et encore");
      await phone.waitFor((e) => e.event === "approval" && e.data.id !== asked.id && e.data.id !== id2);
      phone.hangUp();
      expect(await third).toBe(false);
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — approvals of runs the phone did not start", () => {
  const call = { id: "t1", name: "write_file", args: { path: "note.txt" } };

  it("setting off (the default): a background request is refused at once and no phone hears of it", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Arrière-plan");
      const { phone } = await pairPhone(r);
      expect(r.core.settings.get("phoneApprovals")).toBe(false);
      expect(await r.core.backgroundHooks.approve(session.id, call as never, "Écrire")).toBe(false);
      expect((await phone.rpc("approvals.pending")).result).toEqual([]);
      expect(phone.events.filter((e) => e.event.startsWith("approval"))).toEqual([]);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("offers it to every phone, the first answer wins, the others drop the card, a late phone can pull it", async () => {
    const r = await started();
    try {
      r.core.settings.set("phoneApprovals", true);
      const session = r.core.sessions.create("Arrière-plan");
      const a = await pairPhone(r, "A");
      const b = await pairPhone(r, "B");
      const { token, seq } = (await a.phone.rpc("wake.register")).result as { token: string; seq: number };

      const decision = r.core.backgroundHooks.approve(session.id, call as never, "Écrire un fichier");
      await a.phone.waitFor((e) => e.event === "approval");
      await b.phone.waitFor((e) => e.event === "approval");
      const asked = a.phone.events.find((e) => e.event === "approval")!.data as { id: string; origin: string };
      expect(asked.origin).toBe("background");
      expect(b.phone.events.find((e) => e.event === "approval")!.data.id).toBe(asked.id);
      // A closed app is told something waits, and nothing more.
      const woke = (await (await fetch(`${r.base}/m1/wake?since=${seq}&wait=0`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
        news: boolean;
      };
      expect(woke.news).toBe(true);

      // A third phone that connects later finds the request waiting.
      const c = await pairPhone(r, "C");
      const waiting = (await c.phone.rpc("approvals.pending")).result as { id: string }[];
      expect(waiting.map((w) => w.id)).toEqual([asked.id]);

      expect((await b.phone.rpc("approval.resolve", { id: asked.id, ok: true })).result).toBe(true);
      expect(await decision).toBe(true);
      await a.phone.waitFor((e) => e.event === "approval-cancelled" && e.data.id === asked.id);
      await c.phone.waitFor((e) => e.event === "approval-cancelled" && e.data.id === asked.id);
      expect(b.phone.events.some((e) => e.event === "approval-cancelled")).toBe(false);
      // Spent: the others' answers decide nothing.
      expect((await a.phone.rpc("approval.resolve", { id: asked.id, ok: false })).result).toBe(false);
      expect((await c.phone.rpc("approvals.pending")).result).toEqual([]);

      // A phone going away does not refuse for the others.
      const next = r.core.backgroundHooks.approve(session.id, call as never, "Encore");
      await a.phone.waitFor((e) => e.event === "approval" && e.data.id !== asked.id);
      const id2 = (a.phone.events.filter((e) => e.event === "approval").at(-1)!.data as { id: string }).id;
      c.phone.hangUp();
      await c.phone.closed;
      expect((await a.phone.rpc("approval.resolve", { id: id2, ok: false })).result).toBe(true);
      expect(await next).toBe(false);
      a.phone.hangUp();
      b.phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("a phone that was never shown a request cannot answer it", async () => {
    const r = await started();
    try {
      r.core.settings.set("phoneApprovals", true);
      const session = r.core.sessions.create("Arrière-plan");
      const a = await pairPhone(r, "A");
      const decision = r.core.backgroundHooks.approve(session.id, call as never, "Écrire");
      await a.phone.waitFor((e) => e.event === "approval");
      const id = a.phone.events.find((e) => e.event === "approval")!.data.id as string;
      const late = await pairPhone(r, "Retardataire");
      // It has not asked for the waiting requests: the id alone opens nothing.
      expect((await late.phone.rpc("approval.resolve", { id, ok: true })).result).toBe(false);
      expect((await a.phone.rpc("approval.resolve", { id, ok: true })).result).toBe(true);
      expect(await decision).toBe(true);
      a.phone.hangUp();
      late.phone.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — notifications without content", () => {
  it("pushes notifications to a connected phone and lists them", async () => {
    const r = await started();
    try {
      const { phone } = await pairPhone(r);
      r.core.notifications.add("success", "Tâche terminée", "Le rapport est prêt.");
      await phone.waitFor((e) => e.event === "notification" && e.data.title === "Tâche terminée");
      const list = (await phone.rpc("notifications.list")).result as { title: string; topic: string }[];
      expect(list.map((n) => n.title)).toContain("Tâche terminée");
      // The topic travels inside the encrypted channel, for the phone's per-kind choices.
      expect(list.find((n) => n.title === "Tâche terminée")?.topic).toBe("task");
      r.core.notifications.add("error", "Plugin x en erreur", "");
      await phone.waitFor((e) => e.event === "notification" && e.data.title === "Plugin x en erreur" && e.data.topic === "alert");
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("wakes a closed app with a counter only, for a registered token, until revoked", async () => {
    const r = await started();
    try {
      const { phone } = await pairPhone(r);
      const { token, seq } = (await phone.rpc("wake.register")).result as { token: string; seq: number };
      expect(token.length).toBeGreaterThan(30);
      // Only its hash is kept.
      const stored = r.core.settings.getAll().remote.devices[0]!;
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(stored.wakeHash).toMatch(/^[0-9a-f]{64}$/);
      phone.hangUp();

      const wake = (t: string, since: number, wait = 0) =>
        fetch(`${r.base}/m1/wake?since=${since}&wait=${wait}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
      expect((await wake("", seq)).status).toBe(401);
      expect((await wake("pas-le-bon", seq)).status).toBe(401);
      expect(await (await wake(token, seq)).json()).toEqual({ seq, news: false, count: 0 });

      // A long-poll in progress returns as soon as there is news, and says nothing of what it is.
      const pending = wake(token, seq, 5000);
      await new Promise((d) => setTimeout(d, 100));
      r.core.notifications.add("warning", "Rappel", "Contenu privé");
      const body = (await (await pending).json()) as Record<string, unknown>;
      expect(body.news).toBe(true);
      expect(Object.keys(body).sort()).toEqual(["count", "news", "seq"]);
      expect(body.count).toBe(1);
      expect(JSON.stringify(body)).not.toContain("Rappel");
      expect(JSON.stringify(body)).not.toContain("reminder");

      // Two more, of different kinds: only how many, from the same `since`.
      r.core.notifications.add("error", "Tâche planifiée « x »", "Contenu privé");
      r.core.notifications.add("info", "Autre", "Contenu privé");
      const again = (await (await wake(token, seq)).json()) as Record<string, unknown>;
      expect(again).toEqual({ seq: again.seq, news: true, count: 3 });

      // Revoking the phone kills its wake token too.
      r.bridge.revoke(stored.id);
      expect((await wake(token, seq)).status).toBe(401);
    } finally {
      await r.stop();
    }
  });

  it("a new wake token replaces the old one", async () => {
    const r = await started();
    try {
      const { phone } = await pairPhone(r);
      const one = (await phone.rpc("wake.register")).result as { token: string };
      const two = (await phone.rpc("wake.register")).result as { token: string };
      const wake = (t: string) => fetch(`${r.base}/m1/wake?wait=0`, { headers: { authorization: `Bearer ${t}` } });
      expect((await wake(one.token)).status).toBe(401);
      expect((await wake(two.token)).status).toBe(200);
      phone.hangUp();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — taking the app's access away", () => {
  it("revoking from the PC cuts the channel at once and refuses the key afterwards", async () => {
    const r = await started();
    try {
      const { keys, info, phone } = await pairPhone(r);
      const id = r.bridge.status().devices[0]!.deviceId;
      r.bridge.revoke(id);
      await phone.closed;
      expect(r.bridge.status().devices).toEqual([]);
      const back = await connect(r.base, info.hostKey, keys);
      expect(back.denied).toContain("révoqué");
    } finally {
      await r.stop();
    }
  });

  it("revoking one phone leaves the others connected", async () => {
    const r = await started();
    try {
      const a = await pairPhone(r, "A");
      const b = await pairPhone(r, "B");
      const idA = r.bridge.status().devices.find((d) => d.name === "A")!.deviceId;
      r.bridge.revoke(idA);
      await a.phone.closed;
      expect((await b.phone.rpc("hello")).result).toMatchObject({ device: "B" });
      b.phone.hangUp();
    } finally {
      await r.stop();
    }
  });

  it("lets the phone forget this computer by itself", async () => {
    const r = await started();
    try {
      const { keys, info, phone } = await pairPhone(r);
      expect((await phone.rpc("device.leave")).result).toBe(true);
      await phone.closed;
      expect(r.core.settings.getAll().remote.devices).toEqual([]);
      expect((await connect(r.base, info.hostKey, keys)).denied).toContain("révoqué");
    } finally {
      await r.stop();
    }
  });

  it("answers the phone that leaves before cutting it off, however slow the sealing", async () => {
    const r = await started();
    try {
      const { phone } = await pairPhone(r);
      // A busy computer: sealing the answer takes longer than a timer tick.
      const host = r.core.remoteHost() as unknown as { clients: Map<string, { cid: string; channel: SecureChannel }> };
      const channel = [...host.clients.values()].find((c) => c.cid === phone.cid)!.channel;
      const seal = channel.seal.bind(channel);
      channel.seal = async (m) => {
        await new Promise((d) => setTimeout(d, 50));
        return seal(m);
      };
      const answer = phone.rpc("device.leave");
      await phone.closed;
      const late = new Promise((d) => setTimeout(() => d({ error: "no answer before the channel closed" }), 500));
      expect(await Promise.race([answer, late])).toEqual({ id: 1, result: true });
      expect(r.core.settings.getAll().remote.devices).toEqual([]);
    } finally {
      await r.stop();
    }
  });

  it("closes every direct channel when the bridge stops", async () => {
    const r = await started();
    const { phone } = await pairPhone(r);
    await r.stop();
    await phone.closed;
    expect(r.bridge.status().running).toBe(false);
  });
});
