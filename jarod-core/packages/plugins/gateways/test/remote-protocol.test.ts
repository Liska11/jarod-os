// Portage de packages/core/test/remote-protocol.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  clientHandshake,
  exportKeyPair,
  generateKeyPair,
  hostHandshake,
  importKeyPair,
  pairingLink,
  parsePairingFragment,
  randomBytes,
  rawPublicKey,
} from "../src/remote-protocol.js";

async function pair() {
  const host = await generateKeyPair(true);
  const client = await generateKeyPair();
  const hostPub = await rawPublicKey(host.publicKey);
  const secret = randomBytes(32);
  const c = await clientHandshake(client, hostPub, { pairingSecret: secret, name: "Téléphone" });
  const h = await hostHandshake(host, c.init);
  const clientChannel = await c.finish(h.accept);
  return { host, client, hostPub, secret, c, h, clientChannel, hostChannel: h.channel };
}

describe("relay protocol", () => {
  it("opens a two-way encrypted channel and proves pairing", async () => {
    const { h, secret, clientChannel, hostChannel, client } = await pair();
    expect(await h.checkPairing(secret)).toBe(true);
    expect(await h.checkPairing(randomBytes(32))).toBe(false);
    expect(h.clientStatic).toEqual(await rawPublicKey(client.publicKey));

    const frame = await clientChannel.seal({ method: "ping", text: "Bonjour 🌍" });
    expect(frame).not.toContain("Bonjour");
    expect(await hostChannel.open(frame)).toEqual({ method: "ping", text: "Bonjour 🌍" });
    expect(await clientChannel.open(await hostChannel.seal({ ok: true }))).toEqual({ ok: true });
  });

  it("rejects replayed, reordered and tampered frames", async () => {
    const { clientChannel, hostChannel } = await pair();
    const f1 = await clientChannel.seal(1);
    const f2 = await clientChannel.seal(2);
    await hostChannel.open(f2);
    await expect(hostChannel.open(f1)).rejects.toThrow(/rejouée/);
    await expect(hostChannel.open(f2)).rejects.toThrow(/rejouée/);

    const f3 = JSON.parse(await clientChannel.seal("secret"));
    const bytes = b64uDecode(f3.c);
    bytes[0]! ^= 1;
    await expect(hostChannel.open(JSON.stringify({ n: f3.n, c: b64uEncode(bytes) }))).rejects.toThrow();
  });

  it("hands out concurrently sealed frames in counter order, so sending each as it comes is safe", async () => {
    // The host pushes a reply and a run's events at the same time. AES-GCM runs off the main
    // thread: a small frame sealed after a large one could finish first and go out ahead of it.
    const { clientChannel, hostChannel } = await pair();
    const wire: string[] = [];
    const big = "x".repeat(4 * 1024 * 1024);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => hostChannel.seal(i % 10 === 0 ? { i, big } : { i }).then((f) => wire.push(f))),
    );
    const got: number[] = [];
    for (const f of wire) got.push(((await clientChannel.open(f)) as { i: number }).i);
    expect(got).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("detects a relay that swaps in its own host key", async () => {
    const realHost = await generateKeyPair();
    const attacker = await generateKeyPair();
    const client = await generateKeyPair();
    // The client knows the real host key (from the QR code); the relay answers with its own.
    const c = await clientHandshake(client, await rawPublicKey(realHost.publicKey));
    const forged = await hostHandshake(attacker, c.init);
    await expect(c.finish(forged.accept)).rejects.toThrow(/authentifié/);
  });

  it("gives a client that does not own its static key no usable channel", async () => {
    const host = await generateKeyPair();
    const victim = await generateKeyPair();
    const impostor = await generateKeyPair();
    const hostPub = await rawPublicKey(host.publicKey);
    // The impostor claims the victim's public key but only holds its own private key.
    const c = await clientHandshake({ publicKey: victim.publicKey, privateKey: impostor.privateKey }, hostPub);
    const h = await hostHandshake(host, c.init);
    await expect(c.finish(h.accept)).rejects.toThrow();
  });

  it("persists host keys and round-trips pairing links", async () => {
    const host = await generateKeyPair(true);
    const restored = await importKeyPair(await exportKeyPair(host));
    expect(await rawPublicKey(restored.publicKey)).toEqual(await rawPublicKey(host.publicKey));
    const client = await generateKeyPair();
    const c = await clientHandshake(client, await rawPublicKey(host.publicKey));
    await expect(c.finish((await hostHandshake(restored, c.init)).accept)).resolves.toBeTruthy();

    const link = pairingLink("https://relais.exemple.fr/", { hostId: "abc", hostKey: "KEY", secret: "SEC" });
    expect(link).toBe("https://relais.exemple.fr/#v=1&h=abc&k=KEY&p=SEC");
    expect(parsePairingFragment(new URL(link).hash)).toEqual({ hostId: "abc", hostKey: "KEY", secret: "SEC" });
    expect(parsePairingFragment("#v=2&h=a&k=b&p=c")).toBeNull();
  });
});
