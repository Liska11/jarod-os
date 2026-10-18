// Portage de packages/core/test/mobile.test.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MobileBridge } from "../src/mobile.js";
import { makeCore } from "./helpers.js";

interface Rig {
  core: Awaited<ReturnType<typeof makeCore>>;
  bridge: MobileBridge;
  base: string;
  /** A paired device's token, and the session the phone would open. */
  pair: () => Promise<string>;
  stop: () => Promise<unknown>;
}

/** A real server on an ephemeral port, and real requests: this is a network surface. */
async function started(): Promise<Rig> {
  const core = await makeCore();
  const bridge = new MobileBridge(core);
  await bridge.start(0);
  const base = `http://127.0.0.1:${bridge.status().port}`;
  const pair = async () => {
    const { secret } = bridge.pairing();
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, name: "Téléphone de test" }),
    });
    const body = (await res.json()) as { token: string };
    expect(res.status).toBe(200);
    return body.token;
  };
  return { core, bridge, base, pair, stop: () => bridge.stop() };
}

const get = (base: string, path: string, token?: string) =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("mobile bridge — the page it serves", () => {
  it("serves its own page and script, with no cross-origin door", async () => {
    const r = await started();
    try {
      const page = await fetch(`${r.base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html.length).toBeGreaterThan(500);
      // HTTP on the local network, by choice: the phone is told so, where it types.
      expect(html).toContain("non chiffrée");
      // A page elsewhere on the web must not be able to read an answer from here.
      expect(page.headers.get("access-control-allow-origin")).toBeNull();
      expect(page.headers.get("cache-control")).toBe("no-store");

      const app = await fetch(`${r.base}/app.js`);
      expect(app.status).toBe(200);
      expect(app.headers.get("content-type")).toContain("javascript");
      expect(app.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await app.text()).toContain("/api/pair");
    } finally {
      await r.stop();
    }
  });

  it("gives nothing to a caller that has not paired", async () => {
    const r = await started();
    try {
      for (const path of ["/api/status", "/api/sessions", "/api/session?id=x", "/api/events"]) {
        expect((await get(r.base, path)).status).toBe(401);
      }
      expect((await get(r.base, "/api/status", "jeton-invente")).status).toBe(401);
      expect((await fetch(`${r.base}/api/ask`, { method: "POST", body: "{}" })).status).toBe(401);
      // No data was written for any of those attempts.
      expect(r.core.settings.getAll().mobile.devices).toEqual([]);
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — pairing", () => {
  it("pairs with the secret the desktop shows, and stores only a hash of the token", async () => {
    const r = await started();
    try {
      // The local bridge needs no relay: an empty relayUrl is the normal case here.
      const { secret, expiresAt } = r.bridge.pairing();
      expect(secret.length).toBeGreaterThan(20);
      expect(expiresAt).toBeGreaterThan(Date.now());

      const token = await r.pair();
      const device = r.core.settings.getAll().mobile.devices[0]!;
      expect(device.name).toBe("Téléphone de test");
      // What the phone holds is never written down: only its hash is.
      expect(device.tokenHash).not.toBe(token);
      expect(device.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(r.bridge.status().devices).toEqual([
        {
          deviceId: device.deviceId,
          name: "Téléphone de test",
          pairedAt: device.pairedAt,
          lastSeen: device.lastSeen,
          kind: "browser",
        },
      ]);
    } finally {
      await r.stop();
    }
  });

  it("spends the secret once", async () => {
    const r = await started();
    try {
      const { secret } = r.bridge.pairing();
      const open = (s: string) =>
        fetch(`${r.base}/api/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: s }),
        });
      expect((await open(secret)).status).toBe(200);
      // Spent: the same secret opens nothing a second time.
      expect((await open(secret)).status).toBe(401);
      expect(r.core.settings.getAll().mobile.devices).toHaveLength(1);
    } finally {
      await r.stop();
    }
  });

  it("refuses to be guessed at, and stays shut once the budget is gone", async () => {
    const r = await started();
    try {
      const guess = (secret: string) =>
        fetch(`${r.base}/api/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
        });
      // Five failures is the whole budget: the sixth is refused before its secret is even read.
      for (let i = 0; i < 5; i++) expect((await guess("pas-le-bon")).status).toBe(401);
      expect((await guess("pas-le-bon")).status).toBe(429);

      // Not one of those attempts created a device, and a real secret no longer gets through either:
      // a half-open door is not a door.
      expect(r.core.settings.getAll().mobile.devices).toEqual([]);
      const { secret } = r.bridge.pairing();
      expect((await guess(secret)).status).toBe(429);
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — what a paired phone sees", () => {
  it("reads the state, the conversations and their messages", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Essai téléphone");
      r.core.messages.add(session.id, { role: "user", content: "Bonjour" });
      r.core.messages.add(session.id, { role: "assistant", content: "Bonjour Demba." });
      r.core.messages.add(session.id, { role: "tool", content: "sortie d'outil", toolName: "read_file" });
      const token = await r.pair();

      const status = await get(r.base, "/api/status", token);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ app: "Jarod-One" });

      const sessions = (await (await get(r.base, "/api/sessions", token)).json()) as { id: string; title: string }[];
      expect(sessions.map((s) => s.title)).toContain("Essai téléphone");

      const messages = (await (await get(r.base, `/api/session?id=${session.id}`, token)).json()) as {
        role: string;
        text: string;
      }[];
      // The tool traffic is not a conversation: the phone shows what was said.
      expect(messages).toEqual([
        { role: "user", text: "Bonjour" },
        { role: "assistant", text: "Bonjour Demba." },
      ]);

      expect((await get(r.base, "/api/session?id=inconnu", token)).status).toBe(404);
      expect((await get(r.base, "/api/nimporte", token)).status).toBe(404);
    } finally {
      await r.stop();
    }
  });

  it("refuses a message with nothing in it, and one for a session that does not exist", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Essai");
      const token = await r.pair();
      const ask = (body: unknown) =>
        fetch(`${r.base}/api/ask`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      expect((await ask({ sessionId: session.id, text: "   " })).status).toBe(400);
      expect((await ask({ sessionId: "inconnu", text: "salut" })).status).toBe(404);
    } finally {
      await r.stop();
    }
  });

  it("streams a run's events to the phone that started it", async () => {
    const r = await started();
    try {
      const session = r.core.sessions.create("Essai");
      const other = r.core.sessions.create("Autre");
      const token = await r.pair();

      const controller = new AbortController();
      const stream = await fetch(`${r.base}/api/events?t=${encodeURIComponent(token)}`, { signal: controller.signal });
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;

      // A run is started, not awaited: the phone gets its events as they come.
      const res = await fetch(`${r.base}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId: session.id, text: "dis bonjour" }),
      });
      expect(res.status).toBe(202);

      // The run's own events arrive in order, each tagged with its session: the message the agent
      // received, then its outcome. No provider is configured here, so the outcome is an error —
      // which is exactly the point: what happens on this computer is what the phone is told.
      const seen = await collect(reader, (event) => event.type === "error" || event.type === "done");
      expect(seen[0]).toMatchObject({ sessionId: session.id, type: "message" });
      expect(seen.at(-1)?.sessionId).toBe(session.id);
      expect(other.id).not.toBe(session.id);

      controller.abort();
    } finally {
      await r.stop();
    }
  });
});

describe("mobile bridge — taking access away", () => {
  it("drops a device when the desktop revokes it", async () => {
    const r = await started();
    try {
      const token = await r.pair();
      const device = r.core.settings.getAll().mobile.devices[0]!;
      expect((await get(r.base, "/api/status", token)).status).toBe(200);

      r.bridge.revoke(device.deviceId);
      expect((await get(r.base, "/api/status", token)).status).toBe(401);
      expect(r.bridge.status().devices).toEqual([]);
    } finally {
      await r.stop();
    }
  });

  it("revoking one phone cuts only that phone's live stream", async () => {
    const r = await started();
    try {
      const tokenA = await r.pair();
      const tokenB = await r.pair();
      const [deviceA] = r.core.settings.getAll().mobile.devices;
      const open = async (token: string) => {
        const res = await fetch(`${r.base}/api/events?t=${encodeURIComponent(token)}`);
        const reader = res.body!.getReader();
        await reader.read(); // the opening comment: the stream is registered
        return reader;
      };
      const streamA = await open(tokenA);
      await open(tokenB);
      const streams = (r.bridge as unknown as { streams: Set<{ deviceId: string }> }).streams;
      expect(streams.size).toBe(2);

      r.bridge.revoke(deviceA!.deviceId);

      // Before: every stream of every phone was closed.
      expect((await streamA.read()).done).toBe(true);
      expect([...streams].map((s) => s.deviceId)).not.toContain(deviceA!.deviceId);
      expect(streams.size).toBe(1);
    } finally {
      await r.stop();
    }
  });

  it("lets the phone leave by itself", async () => {
    const r = await started();
    try {
      const token = await r.pair();
      const out = await fetch(`${r.base}/api/leave`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(out.status).toBe(200);
      expect((await get(r.base, "/api/status", token)).status).toBe(401);
    } finally {
      await r.stop();
    }
  });

  it("closes the door on stop, and does not reopen it by itself", async () => {
    const r = await started();
    const port = r.bridge.status().port;
    await r.stop();
    expect(r.bridge.status()).toMatchObject({ running: false, url: "" });
    expect(r.core.settings.getAll().mobile.enabled).toBe(false);
    // Nothing is listening any more.
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("accepts the token in the query, because an EventSource cannot send a header", async () => {
    const r = await started();
    try {
      const token = await r.pair();
      const res = await fetch(`${r.base}/api/events?t=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      await res.body?.cancel();
    } finally {
      await r.stop();
    }
  });
});

/**
 * The next `data:` frame of a stream, or a failure rather than a test that hangs. Frames that do not
 * satisfy `wanted` are skipped, so a test can wait for the event it is about without knowing how many
 * unrelated ones came first.
 */
async function collect(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stop: (event: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: boolean; value?: Uint8Array }>((done) =>
        setTimeout(() => done({ done: false, value: undefined }), 250),
      ),
    ]);
    if (chunk.value) buffer += new TextDecoder().decode(chunk.value);
    // In order: several frames can arrive in one read, and the order is what is being asserted.
    while (buffer.includes("\n\n")) {
      const frame = buffer.slice(0, buffer.indexOf("\n\n") + 2).trim();
      buffer = buffer.slice(buffer.indexOf("\n\n") + 2);
      if (!frame.startsWith("data: ")) continue;
      const event = JSON.parse(frame.slice(6)) as Record<string, unknown>;
      events.push(event);
      if (stop(event)) return events;
    }
  }
  throw new Error("aucun événement reçu dans le délai");
}
