// Chantier 5a de SPECS-P5-MODELS.md, barre (5a-A) : recoupement de `X-Linked-Size` (premier saut) avec la taille de l'API — au TRANSFERT et à la lecture `Range`.
// Décision de l'utilisateur (2026-10-03) : `X-Linked-Size` SEULEMENT (`X-Linked-ETag` est une empreinte Xet, pas un SHA-256, et n'est pas utilisé). Barres figées dans
// DECISIONS AVANT ce code. Serveur Hugging Face factice local ; `guardedFetch` rend rouge tout accès au vrai réseau.
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { GgufRangeError, httpRangeSource } from "../src/gguf-range.js";
import { HuggingFaceService } from "../src/huggingface.js";
import { type HfRemoval } from "../src/hf-transfer.js";
import { type FakeHf, type FakeHfOptions, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";

const REPO = "acme/tiny-GGUF";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytesOf = (n: number, seed: number) => {
  const out = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
};
const listAll = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);

const servers: FakeHf[] = [];
afterEach(async () => {
  await cleanup();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const start = async (options: FakeHfOptions) => {
  const s = await startFakeHf(options);
  servers.push(s);
  return s;
};

const BYTES = bytesOf(60_000, 1);
const ONE = [{ name: "m.gguf", size: BYTES.length, sha256: sha256(BYTES) }];

function make(fake: FakeHf) {
  const guarded = guardedFetch([fake.origin]);
  const journal: HfRemoval[] = [];
  const service = new HuggingFaceService({ baseUrl: fake.origin, fetchImpl: guarded.fetch, journal: (e) => journal.push(e), freeBytes: () => Number.MAX_SAFE_INTEGER });
  const dest = tempDir();
  return { guarded, journal, service, dest };
}

async function failure(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("aucun rejet");
}

const cdnRequests = (fake: FakeHf) => fake.log.filter((l) => l.path.startsWith("/cdn/") || l.path.startsWith("/hop/"));

describe("(5a-A) X-Linked-Size au TRANSFERT", () => {
  it("égal à la taille de l'API : transfert normal", async () => {
    const fake = await start({ files: { "m.gguf": BYTES } });
    const { service, dest } = make(fake);
    const [done] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE });
    expect(done!.bytes).toBe(BYTES.length);
    expect(fake.log.map((l) => l.status)).toEqual([302, 200]);
  });

  it("divergent : LINKED_SIZE_MISMATCH, 0 requête vers le CDN, 0 octet de corps, 0 .part, 0 cible", async () => {
    const fake = await start({ files: { "m.gguf": BYTES }, linkedSize: String(BYTES.length + 1) });
    const { service, dest } = make(fake);
    const e = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE }));
    expect(e.code).toBe("LINKED_SIZE_MISMATCH");
    expect(e.received).toBe(0);
    expect(e.expected).toBe(BYTES.length);
    expect(cdnRequests(fake)).toHaveLength(0);
    expect(fake.log).toHaveLength(1);
    expect(fake.log.reduce((n, l) => n + l.served, 0)).toBeLessThan(100); // le seul corps est le texte de la redirection
    expect(listAll(dest)).toEqual([]);
  });

  it("l'API annonce une autre taille que le serveur (taille attendue fausse) : refusé avant le premier octet, aussi dans l'autre sens", async () => {
    const fake = await start({ files: { "m.gguf": BYTES } });
    const { service, dest } = make(fake);
    const e = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [{ name: "m.gguf", size: BYTES.length - 1, sha256: sha256(BYTES) }] }));
    expect(e.code).toBe("LINKED_SIZE_MISMATCH");
    expect(cdnRequests(fake)).toHaveLength(0);
    expect(listAll(dest)).toEqual([]);
  });

  it("en-tête absent : rien à comparer, le transfert se fait (les contrôles de flux restent)", async () => {
    const fake = await start({ files: { "m.gguf": BYTES }, linkedSize: "absent" });
    const { service, dest } = make(fake);
    const [done] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE });
    expect(done!.bytes).toBe(BYTES.length);
    // et un flux plus long que la taille attendue reste rattrapé par le contrôle de flux
    const fake2 = await start({ files: { "m.gguf": BYTES }, linkedSize: "absent" });
    const b = make(fake2);
    const e = await failure(b.service.downloadSet({ repo: REPO, revision: SHA, destDir: b.dest, files: [{ name: "m.gguf", size: BYTES.length - 10, sha256: null }] }));
    expect(e.code).toBe("SIZE_MISMATCH");
  });

  it.each(["abc", "-1", "1e3", "12.5", "", " ", "0x10", "00060000", "60 000"])("illisible (%j) : refusé, jamais deviné", async (value) => {
    const fake = await start({ files: { "m.gguf": BYTES }, linkedSize: value });
    const { service, dest } = make(fake);
    const e = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE }));
    expect(e.code).toBe("LINKED_SIZE_MISMATCH");
    expect(cdnRequests(fake)).toHaveLength(0);
    expect(listAll(dest)).toEqual([]);
  });

  it("un fragment divergent dans un jeu : tout le jeu est refusé, rien n'est renommé ni laissé", async () => {
    const a = bytesOf(30_000, 11);
    const b = bytesOf(30_000, 12);
    const fake = await start({ files: { "m-00001-of-00002.gguf": a, "m-00002-of-00002.gguf": b }, linkedSize: { "m-00002-of-00002.gguf": "29999" } });
    const { service, dest, journal } = make(fake);
    const e = await failure(
      service.downloadSet({
        repo: REPO,
        revision: SHA,
        destDir: dest,
        files: [
          { name: "m-00001-of-00002.gguf", size: a.length, sha256: sha256(a) },
          { name: "m-00002-of-00002.gguf", size: b.length, sha256: sha256(b) },
        ],
      }),
    );
    expect(e.code).toBe("LINKED_SIZE_MISMATCH");
    expect(listAll(dest).filter((p) => /\.gguf(\.part)?$/.test(p))).toEqual([]);
    expect(journal.every((r) => r.path.endsWith(".part"))).toBe(true); // seules des suppressions de .part, journalisées
  });

  it("le recoupement ignore X-Linked-ETag : un ETag quelconque (Xet) ne change rien", async () => {
    const fake = await start({ files: { "m.gguf": BYTES }, etag: '"deadbeef"' });
    const { service, dest } = make(fake);
    const [done] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE });
    expect(done!.verified).toBe("sha256");
  });
});

describe("(5a-A) X-Linked-Size à la lecture Range", () => {
  const url = (fake: FakeHf) => fake.resolveUrl("m.gguf");

  it("égal à expectedSize : la lecture se fait", async () => {
    const fake = await start({ files: { "m.gguf": BYTES } });
    const g = guardedFetch([fake.origin]);
    const source = httpRangeSource({ url: url(fake), baseUrl: fake.origin, expectedSize: BYTES.length, fetchImpl: g.fetch });
    const r = await source.read(0, 1024);
    expect(r.bytes.length).toBe(1024);
    expect(r.total).toBe(BYTES.length);
  });

  it("divergent : SIZE_MISMATCH avant tout octet de corps, le CDN n'est pas demandé", async () => {
    const fake = await start({ files: { "m.gguf": BYTES }, linkedSize: String(BYTES.length + 5) });
    const g = guardedFetch([fake.origin]);
    const source = httpRangeSource({ url: url(fake), baseUrl: fake.origin, expectedSize: BYTES.length, fetchImpl: g.fetch });
    const e = await source.read(0, 1024).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(GgufRangeError);
    expect((e as GgufRangeError).code).toBe("SIZE_MISMATCH");
    expect(cdnRequests(fake)).toHaveLength(0);
    expect(source.transferred()).toBe(0);
  });

  it("illisible : SIZE_MISMATCH ; absent : lecture normale ; sans expectedSize : rien à comparer", async () => {
    const bad = await start({ files: { "m.gguf": BYTES }, linkedSize: "abc" });
    const s1 = httpRangeSource({ url: url(bad), baseUrl: bad.origin, expectedSize: BYTES.length, fetchImpl: guardedFetch([bad.origin]).fetch });
    await expect(s1.read(0, 64)).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
    const none = await start({ files: { "m.gguf": BYTES }, linkedSize: "absent" });
    const s2 = httpRangeSource({ url: url(none), baseUrl: none.origin, expectedSize: BYTES.length, fetchImpl: guardedFetch([none.origin]).fetch });
    expect((await s2.read(0, 64)).bytes.length).toBe(64);
    const free = await start({ files: { "m.gguf": BYTES }, linkedSize: "999999" });
    const s3 = httpRangeSource({ url: url(free), baseUrl: free.origin, fetchImpl: guardedFetch([free.origin]).fetch });
    expect((await s3.read(0, 64)).bytes.length).toBe(64);
  });
});
