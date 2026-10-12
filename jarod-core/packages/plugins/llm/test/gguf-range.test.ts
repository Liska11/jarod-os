// SPECS-P5-MODELS.md chantier 1 : source d'octets de `gguf-fit` et lecture HTTP `Range` d'un en-tête GGUF distant, sur serveur Hugging Face FACTICE local
// (§ 6) — jamais de réseau réel (`guardedFetch` rend rouge tout test qui en tenterait). Couvre la barre (A) : verdict distant IDENTIQUE au verdict local.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GGUF_MAX_READ_BYTES, GGUF_WINDOW_BYTES, type GgufByteSource, parseGgufMetadata, readGgufFile, readGgufSource, reportGgufFit } from "../src/gguf-fit.js";
import { GgufRangeError, httpRangeSource, isHfUrlAllowed, parseRetryAfter } from "../src/gguf-range.js";
import { type FakeHf, type FakeHfOptions, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";
import { MOE, QWEN35_9B, STD_LLAMA, UNKNOWN_ARCH, gguf, str, withTail } from "./gguf-fixtures.js";

const GIB = 1024 ** 3;
const servers: FakeHf[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const serve = async (o: FakeHfOptions): Promise<FakeHf> => {
  const s = await startFakeHf(o);
  servers.push(s);
  return s;
};

/** Une source sur un fichier du serveur factice, avec le garde-fou réseau. */
function remote(s: FakeHf, file: string, extra: Partial<Parameters<typeof httpRangeSource>[0]> = {}, allowed: string[] = [s.origin]) {
  const g = guardedFetch(allowed);
  const source = httpRangeSource({ url: s.resolveUrl(file), baseUrl: s.origin, ...(s.options.files[file] ? { expectedSize: s.options.files[file]!.length } : {}), fetchImpl: g.fetch, ...extra });
  return { source, calls: g.calls };
}

const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, `attendu ${code}`).toBeInstanceOf(GgufRangeError);
  expect((e as GgufRangeError).code).toBe(code);
  return e as GgufRangeError;
};

/** Un GGUF aux grosses chaînes (sans clé d'architecture) : on construit les octets directement, pas octet par octet. */
function bigGguf(pairs: number, stringBytes: number): Buffer {
  const head = Buffer.alloc(24);
  head.write("GGUF", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeBigUInt64LE(0n, 8);
  head.writeBigUInt64LE(BigInt(pairs), 16);
  const parts: Buffer[] = [head];
  for (let i = 0; i < pairs; i++) {
    const key = Buffer.from(`pad.k${i}`);
    const h = Buffer.alloc(8 + key.length + 4 + 8);
    h.writeBigUInt64LE(BigInt(key.length), 0);
    key.copy(h, 8);
    h.writeUInt32LE(8, 8 + key.length);
    h.writeBigUInt64LE(BigInt(stringBytes), 12 + key.length);
    parts.push(h, Buffer.alloc(stringBytes, 97));
  }
  return Buffer.concat(parts);
}

describe("readGgufSource — la boucle de fenêtre sur une source quelconque", () => {
  const memory = (bytes: Uint8Array, log: [number, number][] = []): GgufByteSource => ({
    async read(offset, length) {
      log.push([offset, length]);
      return { bytes: bytes.subarray(offset, Math.min(bytes.length, offset + length)), total: bytes.length };
    },
  });

  it("même résultat que l'analyse directe, une seule lecture quand les clés sont en tête", async () => {
    const bytes = withTail(gguf(QWEN35_9B), 100_000);
    const log: [number, number][] = [];
    const r = await readGgufSource(memory(bytes, log), { windowBytes: 4096 });
    expect(r.metadata.kv).toEqual(parseGgufMetadata(bytes.subarray(0, 4096)).kv);
    expect(r.fileBytes).toBe(bytes.length);
    expect(log).toEqual([[0, 4096]]);
  });

  it("ne relit JAMAIS un octet déjà lu : chaque doublement ne demande que la tranche suivante", async () => {
    const entries = [str("general.architecture", "llama"), str("general.name", "n".repeat(3000)), ...STD_LLAMA.slice(1)];
    const log: [number, number][] = [];
    const r = await readGgufSource(memory(withTail(gguf(entries), 10_000), log), { windowBytes: 512 });
    expect(r.metadata.kv.get("llama.block_count")).toBe(40);
    expect(log[0]).toEqual([0, 512]);
    expect(log[1]).toEqual([512, 512]); // fenêtre 1024 : seulement les 512 octets suivants
    for (let i = 1; i < log.length; i++) expect(log[i]![0]).toBe(log[i - 1]![0] + log[i - 1]![1]);
  });

  it("une source qui ne rend plus rien avant la fin ne fait pas boucler", async () => {
    const stuck: GgufByteSource = { read: async (offset) => ({ bytes: offset === 0 ? gguf([str("general.architecture", "llama")]) : new Uint8Array(0), total: 1_000_000 }) };
    const r = await readGgufSource(stuck, { windowBytes: 64 });
    expect(r.metadata.kv.get("general.architecture")).toBe("llama");
  });

  it("readGgufFile (fichier local) donne le même résultat qu'une source mémoire sur les mêmes octets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-gguf-src-"));
    try {
      const bytes = withTail(gguf(QWEN35_9B), 5000);
      const path = join(dir, "m.gguf");
      writeFileSync(path, bytes);
      const a = await readGgufFile(path);
      const b = await readGgufSource(memory(bytes));
      expect(a.fileBytes).toBe(b.fileBytes);
      expect(a.metadata.kv).toEqual(b.metadata.kv);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("barre (A) — le verdict distant est IDENTIQUE à celui de reportGgufFit sur le même GGUF local", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-gguf-range-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const TAIL = 10_000_000; // le « poids » : jamais lu, ni localement ni par Range
  const fixtures: Record<string, { bytes: Buffer; ctx: number; status: string }> = {
    "standard.gguf": { bytes: withTail(gguf(STD_LLAMA), TAIL), ctx: 8192, status: "fits" },
    "hybride.gguf": { bytes: withTail(gguf(QWEN35_9B), TAIL), ctx: 8192, status: "fits" },
    "moe.gguf": { bytes: withTail(gguf(MOE), TAIL), ctx: 8192, status: "fits" },
    "inconnue.gguf": { bytes: withTail(gguf(UNKNOWN_ARCH), TAIL), ctx: 8192, status: "not-estimated" },
    // En-tête qui annonce plus de paires qu'il n'en contient et s'arrête : tronqué.
    "tronque.gguf": { bytes: withTail(gguf([str("general.architecture", "llama")], { declared: 40 }), 0), ctx: 8192, status: "not-estimated" },
    "au-dela.gguf": { bytes: withTail(gguf(STD_LLAMA), TAIL), ctx: 200_000, status: "beyond-native-context" },
  };

  it("6 fixtures : standard, hybride, MoE, architecture inconnue, tronquée, au-delà du contexte natif — rapports identiques à l'octet près", async () => {
    const s = await serve({ files: Object.fromEntries(Object.entries(fixtures).map(([n, f]) => [n, f.bytes])) });
    for (const [name, f] of Object.entries(fixtures)) {
      const path = join(dir, name);
      writeFileSync(path, f.bytes);
      const opts = { contextTokens: f.ctx, gpuBytes: 24 * GIB };
      const local = await reportGgufFit(path, opts);
      const { source } = remote(s, name);
      const distant = await reportGgufFit(source, opts);
      expect(distant, name).toEqual(local);
      expect(distant.fit.status, name).toBe(f.status);
      expect(distant.fileBytes, name).toBe(f.bytes.length);
      // Jamais le fichier : au plus la fenêtre de 256 Kio (les fixtures tiennent toutes dans la première).
      expect(source.transferred(), name).toBeLessThanOrEqual(GGUF_WINDOW_BYTES);
    }
  });

  it("aucun « Fits » sans estimation, jamais d'octet de poids : le serveur ne sert que le début du fichier", async () => {
    const s = await serve({ files: { "g.gguf": fixtures["standard.gguf"]!.bytes } });
    const { source } = remote(s, "g.gguf");
    await reportGgufFit(source, { contextTokens: 8192, gpuBytes: 24 * GIB });
    const served = s.log.reduce((n, e) => n + e.served, 0);
    expect(served).toBeLessThan(GGUF_WINDOW_BYTES + 4096); // la fenêtre + le corps de la redirection, pas les 10 Mo de « poids »
    expect(s.log.every((e) => e.range === `bytes=0-${GGUF_WINDOW_BYTES - 1}`)).toBe(true);
  });
});

describe("fenêtre : doublée sans relecture, plafonnée à 16 Mio", () => {
  it("clés d'architecture après un long nom : 2e tranche = 262144-524287 (pas de relecture du début), verdict identique", async () => {
    const entries = [str("general.architecture", "llama"), str("general.name", "n".repeat(300_000)), ...STD_LLAMA.slice(1)];
    const bytes = withTail(gguf(entries), 1_000_000);
    const s = await serve({ files: { "a.gguf": bytes }, redirect: "none" });
    const { source } = remote(s, "a.gguf");
    const r = await reportGgufFit(source, { contextTokens: 4096, gpuBytes: 24 * GIB });
    expect(r.fit.status).toBe("fits");
    expect(s.log.map((e) => e.range)).toEqual([`bytes=0-${GGUF_WINDOW_BYTES - 1}`, `bytes=${GGUF_WINDOW_BYTES}-${2 * GGUF_WINDOW_BYTES - 1}`]);
    expect(source.transferred()).toBe(2 * GGUF_WINDOW_BYTES);
  });

  it("clés introuvables : on s'arrête à 16 Mio de corps au plus, l'en-tête partiel donne « non estimé »", async () => {
    const bytes = bigGguf(30, 1024 * 1024); // 30 Mio de métadonnées sans `general.architecture`
    const s = await serve({ files: { "gros.gguf": bytes }, redirect: "none", chunk: 1024 * 1024 });
    const { source } = remote(s, "gros.gguf");
    const r = await reportGgufFit(source, { contextTokens: 4096, gpuBytes: 24 * GIB });
    expect(r.fit.status).toBe("not-estimated");
    expect(source.transferred()).toBeLessThanOrEqual(GGUF_MAX_READ_BYTES);
    expect(source.transferred()).toBeGreaterThan(GGUF_MAX_READ_BYTES / 2);
  }, 30_000);
});

describe("redirections : manuelles, le Range rejoué à chaque saut", () => {
  const bytes = withTail(gguf(STD_LLAMA), 50_000);

  it("forme observée : 302 sans 206 au premier saut, puis le MÊME Range rejoué au CDN, 206 + Content-Range", async () => {
    const s = await serve({ files: { "m.gguf": bytes } });
    const { source } = remote(s, "m.gguf");
    const r = await source.read(0, 1024);
    expect(r.total).toBe(bytes.length);
    expect(r.bytes.length).toBe(1024);
    expect(s.log.map((e) => [e.status, e.range, e.path.startsWith("/cdn/") ? "cdn" : "resolve"])).toEqual([
      [302, "bytes=0-1023", "resolve"],
      [206, "bytes=0-1023", "cdn"],
    ]);
    expect(source.requests()).toBe(2);
    expect(source.transferred()).toBe(1024); // le corps du 302 ne compte pas
  });

  it("3 redirections passent, la 4e est refusée", async () => {
    const ok = await serve({ files: { "m.gguf": bytes }, chain: 3 });
    expect((await remote(ok, "m.gguf").source.read(0, 64)).bytes.length).toBe(64);
    const ko = await serve({ files: { "m.gguf": bytes }, chain: 4 });
    await rejectsWith(remote(ko, "m.gguf").source.read(0, 64), "TOO_MANY_REDIRECTS");
  });

  it("redirection vers un hôte hors liste : refusée, et AUCUNE requête n'y part", async () => {
    for (const evil of ["https://evil.example", "http://huggingface.co.evil.example", "https://203.0.113.9"]) {
      const s = await serve({ files: { "m.gguf": bytes }, redirect: evil });
      const { source, calls } = remote(s, "m.gguf");
      await rejectsWith(source.read(0, 64), "HOST_REFUSED");
      expect(calls, evil).toHaveLength(1); // seulement le premier saut, vers le serveur factice
    }
  });

  it("redirection vers un AUTRE serveur local non déclaré : refusée (seules les origines injectées sont admises)", async () => {
    const cdn = await serve({ files: { "m.gguf": bytes }, redirect: "none" });
    const api = await serve({ files: { "m.gguf": bytes }, redirect: cdn.origin });
    const { source } = remote(api, "m.gguf", {}, [api.origin, cdn.origin]);
    await rejectsWith(source.read(0, 64), "HOST_REFUSED");
    expect(cdn.log).toHaveLength(0);
  });

  it("jeton : envoyé à l'hôte de base, ABSENT du saut vers le CDN (autre origine, injectée)", async () => {
    const cdn = await serve({ files: { "m.gguf": bytes }, redirect: "none" });
    const api = await serve({ files: { "m.gguf": bytes }, redirect: cdn.origin });
    const { source } = remote(api, "m.gguf", { token: "hf_jeton_de_test", extraTrustedOrigins: [cdn.origin] }, [api.origin, cdn.origin]);
    expect((await source.read(0, 64)).bytes.length).toBe(64);
    expect(api.log[0]!.authorization).toBe("Bearer hf_jeton_de_test");
    expect(cdn.log).toHaveLength(1);
    expect(cdn.log[0]!.authorization).toBeUndefined();
    expect(cdn.log[0]!.range).toBe("bytes=0-63");
  });
});

describe("adresse : révision épinglée et hôtes", () => {
  it("resolve/main refusé à la construction, avant toute requête (exigence a)", () => {
    const g = guardedFetch([]);
    expect(() => httpRangeSource({ url: "https://huggingface.co/acme/tiny-GGUF/resolve/main/m.gguf", fetchImpl: g.fetch })).toThrow(/UNPINNED_REVISION/);
    expect(() => httpRangeSource({ url: `https://huggingface.co/acme/tiny-GGUF/resolve/${SHA.slice(0, 39)}/m.gguf`, fetchImpl: g.fetch })).toThrow(/UNPINNED_REVISION/);
    expect(() => httpRangeSource({ url: `https://huggingface.co/acme/tiny-GGUF/blob/${SHA}/m.gguf`, fetchImpl: g.fetch })).toThrow(/UNPINNED_REVISION/);
    expect(g.calls).toEqual([]);
  });

  it("hôte non admis refusé à la construction", () => {
    for (const u of [`https://evil.example/a/b/resolve/${SHA}/m.gguf`, `https://93.184.216.34/a/b/resolve/${SHA}/m.gguf`, `http://huggingface.co/a/b/resolve/${SHA}/m.gguf`]) {
      expect(() => httpRangeSource({ url: u, fetchImpl: guardedFetch([]).fetch }), u).toThrow(/HOST_REFUSED/);
    }
  });

  it("liste d'hôtes : huggingface.co, hf.co et leurs sous-domaines en https, rien d'autre", () => {
    const ok = ["https://huggingface.co/x", "https://us.aws.cdn.hf.co/x", "https://hf.co/x", "https://cdn-lfs.huggingface.co/x"];
    const ko = ["http://huggingface.co/x", "https://evilhf.co/x", "https://hf.co.evil.io/x", "https://huggingface.co.evil.io/x", "https://1.2.3.4/x", "https://[::1]/x", "ftp://hf.co/x"];
    for (const u of ok) expect(isHfUrlAllowed(new URL(u)), u).toBe(true);
    for (const u of ko) expect(isHfUrlAllowed(new URL(u)), u).toBe(false);
  });
});

describe("429 défensif : message clair, Retry-After honoré, JAMAIS de relance automatique", () => {
  const bytes = withTail(gguf(STD_LLAMA), 1000);

  it("Retry-After en secondes : l'erreur le porte, le serveur reçoit exactement UNE requête, même après attente", async () => {
    const s = await serve({ files: { "m.gguf": bytes }, rateLimit: { retryAfter: "7" } });
    const { source } = remote(s, "m.gguf");
    const e = await rejectsWith(source.read(0, 64), "RATE_LIMITED");
    expect(e.retryAfterSeconds).toBe(7);
    expect(e.status).toBe(429);
    await new Promise((r) => setTimeout(r, 150));
    expect(s.log).toHaveLength(1);
    expect(source.requests()).toBe(1);
  });

  it("Retry-After en date HTTP, et absent", async () => {
    const date = new Date(Date.now() + 90_000).toUTCString();
    const s1 = await serve({ files: { "m.gguf": bytes }, rateLimit: { retryAfter: date } });
    const e1 = await rejectsWith(remote(s1, "m.gguf").source.read(0, 64), "RATE_LIMITED");
    expect(e1.retryAfterSeconds).toBeGreaterThanOrEqual(88);
    expect(e1.retryAfterSeconds).toBeLessThanOrEqual(90);
    const s2 = await serve({ files: { "m.gguf": bytes }, rateLimit: {} });
    expect((await rejectsWith(remote(s2, "m.gguf").source.read(0, 64), "RATE_LIMITED")).retryAfterSeconds).toBeNull();
  });

  it("429 au saut du CDN : une requête par saut, aucune relance", async () => {
    const cdn = await serve({ files: { "m.gguf": bytes }, rateLimit: { retryAfter: "3" } });
    const api = await serve({ files: { "m.gguf": bytes }, redirect: cdn.origin });
    const { source } = remote(api, "m.gguf", { extraTrustedOrigins: [cdn.origin] }, [api.origin, cdn.origin]);
    const e = await rejectsWith(source.read(0, 64), "RATE_LIMITED");
    expect(e.retryAfterSeconds).toBe(3);
    expect(source.requests()).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.log).toHaveLength(1);
    expect(cdn.log).toHaveLength(1);
  });

  it("le verdict ne transforme pas une 429 en « non estimé » : l'erreur remonte (l'écran dit « non vérifié »)", async () => {
    const s = await serve({ files: { "m.gguf": bytes }, rateLimit: { retryAfter: "5" } });
    const { source } = remote(s, "m.gguf");
    await rejectsWith(reportGgufFit(source, { contextTokens: 4096, gpuBytes: GIB }), "RATE_LIMITED");
  });

  it("parseRetryAfter : secondes, date passée (0), illisible, absent", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter(new Date(Date.now() - 5000).toUTCString())).toBe(0);
    expect(parseRetryAfter("bientôt")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("réponses anormales : jamais lues comme un en-tête", () => {
  const bytes = withTail(gguf(STD_LLAMA), 2_000_000);

  it("le serveur ignore Range (200) : coupé tout de suite, AUCUN octet de corps lu, jamais le fichier", async () => {
    const s = await serve({ files: { "m.gguf": bytes }, rangeMode: "ignore", redirect: "none", chunk: 16 * 1024 });
    const { source } = remote(s, "m.gguf");
    await rejectsWith(source.read(0, GGUF_WINDOW_BYTES), "RANGE_NOT_HONORED");
    expect(source.transferred()).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(s.log[0]!.served).toBeLessThan(bytes.length / 2);
  });

  it("Content-Range incohérent : début décalé, absent, total différent de l'API", async () => {
    const wrongStart = await serve({ files: { "m.gguf": bytes }, rangeMode: "wrong-start", redirect: "none" });
    await rejectsWith(remote(wrongStart, "m.gguf").source.read(0, 1024), "BAD_RANGE");
    const none = await serve({ files: { "m.gguf": bytes }, rangeMode: "no-content-range", redirect: "none" });
    await rejectsWith(remote(none, "m.gguf").source.read(0, 1024), "BAD_RANGE");
    const total = await serve({ files: { "m.gguf": bytes }, rangeMode: "bad-total", redirect: "none" });
    await rejectsWith(remote(total, "m.gguf").source.read(0, 1024), "SIZE_MISMATCH");
    const honest = await serve({ files: { "m.gguf": bytes }, redirect: "none" });
    await rejectsWith(remote(honest, "m.gguf", { expectedSize: bytes.length + 1 }).source.read(0, 1024), "SIZE_MISMATCH");
  });

  it("corps plus long que la tranche annoncée, ou plus court : rejeté", async () => {
    const overlong = await serve({ files: { "m.gguf": bytes }, rangeMode: "overlong", redirect: "none" });
    const { source } = remote(overlong, "m.gguf");
    await rejectsWith(source.read(0, 1024), "BAD_RANGE");
    expect(source.transferred()).toBeLessThanOrEqual(1024);
    const short = await serve({ files: { "m.gguf": bytes }, rangeMode: "short-body", redirect: "none" });
    await rejectsWith(remote(short, "m.gguf").source.read(0, 1024), "TRUNCATED_BODY");
  });

  it("fichier inconnu : erreur HTTP 404 nommée", async () => {
    const s = await serve({ files: { "m.gguf": bytes }, redirect: "none" });
    const e = await rejectsWith(httpRangeSource({ url: s.resolveUrl("absent.gguf"), baseUrl: s.origin, fetchImpl: guardedFetch([s.origin]).fetch }).read(0, 64), "HTTP");
    expect(e.status).toBe(404);
  });

  it("un en-tête hostile (pas un GGUF) rend « non estimé », pas une erreur de transport", async () => {
    const s = await serve({ files: { "x.gguf": Buffer.from("PK ceci n'est pas un gguf".padEnd(5000, "x")) }, redirect: "none" });
    const r = await reportGgufFit(remote(s, "x.gguf").source, { contextTokens: 4096, gpuBytes: GIB });
    expect(r.fit.status).toBe("not-estimated");
    expect(r.fit.reason).toMatch(/BAD_MAGIC/);
  });

  it("délai : un serveur muet est abandonné (TIMEOUT), un signal annule (ABORTED)", async () => {
    const s = await serve({ files: { "m.gguf": bytes }, hang: true });
    await rejectsWith(remote(s, "m.gguf", { timeoutMs: 120 }).source.read(0, 64), "TIMEOUT");
    const ctl = new AbortController();
    const p = remote(s, "m.gguf", { signal: ctl.signal }).source.read(0, 64);
    setTimeout(() => ctl.abort(), 50);
    await rejectsWith(p, "ABORTED");
  });

  it("réseau coupé : NETWORK, aucun accès réseau réel (garde-fou)", async () => {
    const s = await serve({ files: { "m.gguf": bytes }, redirect: "none" });
    const { source } = remote(s, "m.gguf", {}, []); // l'origine du serveur factice n'est pas dans la liste du garde-fou : le fetch échoue
    await rejectsWith(source.read(0, 64), "NETWORK");
  });
});
