// Portage de packages/core/src/remote/protocol.ts (rév. 2e180305).
/**
 * End-to-end encrypted channel between the desktop app (host) and a paired device (client),
 * carried by an untrusted relay. WebCrypto only: the same code runs in Node/Electron and in the
 * phone's browser.
 *
 * Handshake (one round trip):
 *   client → host  init   { clientStatic C, clientEph Ec, pairing? = HMAC(pairingSecret, C‖Ec) }
 *   host → client  accept { hostEph Eh, confirm = HMAC(kConfirm, "host") }
 *   keys = HKDF(DH(Eh, Ec) ‖ DH(H, C), salt = SHA-256(v ‖ H ‖ C ‖ Ec ‖ Eh))
 * The client learns the host's static key H from the pairing QR code (URL fragment, never sent to
 * the relay), so the relay cannot sit in the middle. DH(H, C) authenticates both sides, the
 * ephemeral DH gives forward secrecy. Frames are AES-256-GCM with a per-direction key and a
 * strictly increasing counter (replays and reordering are rejected).
 */

// WebCrypto types derived from the global `crypto`, so they match both Node's and the DOM's typings.
type Subtle = typeof globalThis.crypto.subtle;
type CryptoKey = Awaited<ReturnType<Subtle["importKey"]>>;
export interface CryptoKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}
interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
}
type BufferSource = Parameters<Subtle["digest"]>[1];

export const PROTOCOL_VERSION = "jarod-relay/1";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- Encoding ----------

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Constant-time comparison. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------- Primitives ----------

export function generateKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: "X25519" }, extractable, ["deriveBits"]) as unknown as Promise<CryptoKeyPair>;
}

export async function rawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey("raw", key));
}

/** Host keys are persisted as JWK (in the app's encrypted secrets). */
export async function exportKeyPair(pair: CryptoKeyPair): Promise<string> {
  return JSON.stringify(await subtle.exportKey("jwk", pair.privateKey));
}

export async function importKeyPair(json: string): Promise<CryptoKeyPair> {
  const jwk = JSON.parse(json) as Jwk;
  // `as never`: Node and DOM typings disagree on JsonWebKey; the runtime API is the same.
  const privateKey = await subtle.importKey("jwk", jwk as never, { name: "X25519" }, false, ["deriveBits"]);
  const publicKey = await subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as never,
    { name: "X25519" },
    true,
    [],
  );
  return { privateKey, publicKey };
}

async function dh(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> {
  if (peerPublic.length !== 32) throw new Error("Clé publique invalide");
  const pub = await subtle.importKey("raw", peerPublic as BufferSource, { name: "X25519" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, privateKey, 256));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", data as BufferSource));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data as BufferSource));
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: enc.encode(info) },
      k,
      bytes * 8,
    ),
  );
}

/** Short stable id of a device, derived from its public key. */
export async function deviceId(publicKey: Uint8Array): Promise<string> {
  return b64uEncode((await sha256(publicKey)).slice(0, 12));
}

// ---------- Secure channel ----------

interface Frame {
  n: number;
  c: string;
}

export class SecureChannel {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
  ) {}

  private static iv(n: number): Uint8Array {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
  }

  async seal(message: unknown): Promise<string> {
    const n = ++this.sent;
    const c = await subtle.encrypt(
      { name: "AES-GCM", iv: SecureChannel.iv(n) as BufferSource, additionalData: enc.encode(PROTOCOL_VERSION) },
      this.sendKey,
      enc.encode(JSON.stringify(message)),
    );
    return JSON.stringify({ n, c: b64uEncode(new Uint8Array(c)) } satisfies Frame);
  }

  /** Throws on tampering, a wrong key or a replayed / reordered frame. */
  async open(frame: string): Promise<unknown> {
    const f = JSON.parse(frame) as Frame;
    if (!Number.isSafeInteger(f.n) || f.n <= this.received) throw new Error("Trame rejouée ou désordonnée");
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: SecureChannel.iv(f.n) as BufferSource, additionalData: enc.encode(PROTOCOL_VERSION) },
      this.recvKey,
      b64uDecode(f.c) as BufferSource,
    );
    this.received = f.n;
    return JSON.parse(dec.decode(plain));
  }
}

// ---------- Handshake ----------

export interface ClientInit {
  type: "init";
  v: typeof PROTOCOL_VERSION;
  clientStatic: string;
  clientEph: string;
  /** Present on first contact: proves the client scanned the pairing code. */
  pairing?: string;
  /** Device name shown in the app ("iPhone de Léa"). */
  name?: string;
}

export interface HostAccept {
  type: "accept";
  hostEph: string;
  confirm: string;
}

async function deriveKeys(
  ee: Uint8Array,
  ss: Uint8Array,
  keys: { host: Uint8Array; client: Uint8Array; clientEph: Uint8Array; hostEph: Uint8Array },
): Promise<{ c2h: CryptoKey; h2c: CryptoKey; confirm: Uint8Array }> {
  const salt = await sha256(concat(enc.encode(PROTOCOL_VERSION), keys.host, keys.client, keys.clientEph, keys.hostEph));
  const okm = await hkdf(concat(ee, ss), salt, `${PROTOCOL_VERSION} keys`, 96);
  const aes = (bytes: Uint8Array) =>
    subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    c2h: await aes(okm.slice(0, 32)),
    h2c: await aes(okm.slice(32, 64)),
    confirm: await hmac(okm.slice(64), enc.encode("host")),
  };
}

const pairingProof = (secret: Uint8Array, clientStatic: Uint8Array, clientEph: Uint8Array) =>
  hmac(secret, concat(clientStatic, clientEph));

/** Client side: builds the init message; `finish` checks the host's answer and opens the channel. */
export async function clientHandshake(
  clientStatic: CryptoKeyPair,
  hostStatic: Uint8Array,
  opts: { pairingSecret?: Uint8Array; name?: string } = {},
): Promise<{ init: ClientInit; finish(accept: HostAccept): Promise<SecureChannel> }> {
  const eph = await generateKeyPair();
  const c = await rawPublicKey(clientStatic.publicKey);
  const ec = await rawPublicKey(eph.publicKey);
  const init: ClientInit = {
    type: "init",
    v: PROTOCOL_VERSION,
    clientStatic: b64uEncode(c),
    clientEph: b64uEncode(ec),
    ...(opts.pairingSecret ? { pairing: b64uEncode(await pairingProof(opts.pairingSecret, c, ec)) } : {}),
    ...(opts.name ? { name: opts.name.slice(0, 60) } : {}),
  };
  return {
    init,
    async finish(accept) {
      const eh = b64uDecode(accept.hostEph);
      const k = await deriveKeys(await dh(eph.privateKey, eh), await dh(clientStatic.privateKey, hostStatic), {
        host: hostStatic,
        client: c,
        clientEph: ec,
        hostEph: eh,
      });
      if (!equal(k.confirm, b64uDecode(accept.confirm))) throw new Error("L'ordinateur n'a pas pu être authentifié.");
      return new SecureChannel(k.c2h, k.h2c);
    },
  };
}

/**
 * Host side: answers an init. The caller decides whether the client is allowed (known device, or
 * valid pairing proof via `checkPairing`) before using the channel.
 */
export async function hostHandshake(
  hostStatic: CryptoKeyPair,
  init: ClientInit,
): Promise<{
  accept: HostAccept;
  channel: SecureChannel;
  clientStatic: Uint8Array;
  checkPairing(secret: Uint8Array): Promise<boolean>;
}> {
  if (init.v !== PROTOCOL_VERSION) throw new Error(`Version de protocole non prise en charge : ${String(init.v)}`);
  const c = b64uDecode(init.clientStatic);
  const ec = b64uDecode(init.clientEph);
  const h = await rawPublicKey(hostStatic.publicKey);
  const eph = await generateKeyPair();
  const eh = await rawPublicKey(eph.publicKey);
  const k = await deriveKeys(await dh(eph.privateKey, ec), await dh(hostStatic.privateKey, c), {
    host: h,
    client: c,
    clientEph: ec,
    hostEph: eh,
  });
  return {
    accept: { type: "accept", hostEph: b64uEncode(eh), confirm: b64uEncode(k.confirm) },
    channel: new SecureChannel(k.h2c, k.c2h),
    clientStatic: c,
    checkPairing: async (secret) =>
      Boolean(init.pairing) && equal(await pairingProof(secret, c, ec), b64uDecode(init.pairing!)),
  };
}

// ---------- Pairing link ----------

export interface PairingInfo {
  hostId: string;
  hostKey: string;
  secret: string;
}

/** The secret parts live in the URL fragment: browsers never send it to the server. */
export function pairingLink(relayUrl: string, info: PairingInfo): string {
  return `${relayUrl.replace(/\/+$/, "")}/#v=1&h=${info.hostId}&k=${info.hostKey}&p=${info.secret}`;
}

export function parsePairingFragment(fragment: string): PairingInfo | null {
  const p = new URLSearchParams(fragment.replace(/^#/, ""));
  const hostId = p.get("h");
  const hostKey = p.get("k");
  const secret = p.get("p");
  if (p.get("v") !== "1" || !hostId || !hostKey || !secret) return null;
  return { hostId, hostKey, secret };
}

// ---------- Addresses ----------

/**
 * Who may talk to the bridge: this computer, the local networks, link-local, Tailscale's range
 * (100.64.0.0/10, fd7a:115c:a1e0::/48 inside fc00::/7). A port forwarded on a router by mistake still
 * opens nothing to the Internet.
 */
export function isPrivateAddress(raw: string): boolean {
  let a = raw.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    if (x === 127 || x === 10) return true;
    if (x === 172 && y >= 16 && y <= 31) return true;
    if (x === 192 && y === 168) return true;
    if (x === 169 && y === 254) return true;
    if (x === 100 && y >= 64 && y <= 127) return true;
    return false;
  }
  if (a === "::1") return true;
  // fc00::/7 (unique local, Tailscale) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}
