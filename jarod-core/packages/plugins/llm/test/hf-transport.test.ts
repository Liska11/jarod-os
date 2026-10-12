// Chantier 4 de SPECS-P5-MODELS.md, transport : (4-A) redirections MANUELLES du téléchargement, (4-B) 429 défensif du transfert et des métadonnées, (4-C) espace
// disque libre vérifié AVANT le premier octet. Barres figées dans DECISIONS le 2026-10-03 AVANT ce code. Serveurs Hugging Face factices locaux ;
// `guardedFetch` rend rouge tout accès au vrai réseau ET enregistre chaque appel : il voit CHAQUE saut.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { type HfRemoval } from "../src/hf-transfer.js";
import { HF_DISK_MARGIN_BYTES, HuggingFaceService } from "../src/huggingface.js";
import { type FakeHf, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";

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
const start = async (options: Parameters<typeof startFakeHf>[0]) => {
  const s = await startFakeHf(options);
  servers.push(s);
  return s;
};

const BYTES = bytesOf(60_000, 1);
const ONE = [{ name: "m.gguf", size: BYTES.length, sha256: sha256(BYTES) }];

function make(fake: FakeHf, extra: { token?: string; trusted?: string[]; freeBytes?: (dir: string) => number | Promise<number> } = {}) {
  const guarded = guardedFetch([fake.origin, ...(extra.trusted ?? [])]);
  const journal: HfRemoval[] = [];
  const service = new HuggingFaceService({
    baseUrl: fake.origin,
    fetchImpl: guarded.fetch,
    journal: (e) => journal.push(e),
    token: extra.token,
    extraTrustedOrigins: extra.trusted,
    freeBytes: extra.freeBytes ?? (() => Number.MAX_SAFE_INTEGER),
  });
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

describe("(4-A) redirections MANUELLES du téléchargement", () => {
  it("un téléchargement ordinaire : 2 appels vus par le garde-fou (résolution + CDN), Accept-Encoding identity", async () => {
    const fake = await start({ files: { "m.gguf": BYTES } });
    const { guarded, service, dest } = make(fake);
    await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE });
    expect(guarded.calls).toHaveLength(2);
    expect(fake.log.map((l) => l.status)).toEqual([302, 200]);
    expect(fake.log.every((l) => l.acceptEncoding === "identity")).toBe(true);
  });

  it("3 redirections acceptées (4 appels vus), 4 refusées : TOO_MANY_REDIRECTS, jamais le CDN, rien d'écrit", async () => {
    const ok = await start({ files: { "m.gguf": BYTES }, chain: 3 });
    const a = make(ok);
    await a.service.downloadSet({ repo: REPO, revision: SHA, destDir: a.dest, files: ONE });
    expect(a.guarded.calls).toHaveLength(4);

    const ko = await start({ files: { "m.gguf": BYTES }, chain: 4 });
    const b = make(ko);
    const error = await failure(b.service.downloadSet({ repo: REPO, revision: SHA, destDir: b.dest, files: ONE }));
    expect(error.code).toBe("TOO_MANY_REDIRECTS");
    expect(ko.log.some((l) => l.path.startsWith("/cdn/"))).toBe(false);
    expect(listAll(b.dest)).toEqual([]);
    expect(b.journal).toEqual([]);
  });

  it("hôte interdit au 1ᵉʳ saut ET au 2ᵉ saut : HOST_REFUSED, aucune requête vers lui, aucun .part, journal vide", async () => {
    const forbidden = ["https://evil.example", "http://example.test", "https://127.0.0.1:1", "http://127.0.0.1:1", "https://huggingface.co.evil.example"];
    for (const target of forbidden) {
      for (const chain of [1, 2]) {
        const fake = await start({ files: { "m.gguf": BYTES }, redirect: target, chain });
        const { guarded, service, dest, journal } = make(fake);
        const error = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE }));
        expect(error.code, `${target} chain ${chain}`).toBe("HOST_REFUSED");
        expect(guarded.calls.every((u) => u.startsWith(fake.origin)), `${target} chain ${chain}`).toBe(true);
        expect(listAll(dest), `${target} chain ${chain}`).toEqual([]);
        expect(journal).toEqual([]);
      }
    }
  });

  it("redirection sans Location : HTTP ; réponse finale 206 non demandée : HTTP (corps partiel refusé)", async () => {
    const noLoc = await start({ files: { "m.gguf": BYTES }, noLocation: true });
    const a = make(noLoc);
    const e1 = await failure(a.service.downloadSet({ repo: REPO, revision: SHA, destDir: a.dest, files: ONE }));
    expect(e1.code).toBe("HTTP");
    expect(e1.status).toBe(302);
    expect(listAll(a.dest)).toEqual([]);

    const partial = await start({ files: { "m.gguf": BYTES }, partialOnPlain: true });
    const b = make(partial);
    const e2 = await failure(b.service.downloadSet({ repo: REPO, revision: SHA, destDir: b.dest, files: ONE }));
    expect(e2.code).toBe("HTTP");
    expect(e2.status).toBe(206);
    expect(listAll(b.dest)).toEqual([]);
  });

  it("le jeton part à l'origine de base, JAMAIS au CDN d'une autre origine, à aucun saut", async () => {
    const cdn = await start({ files: { "m.gguf": BYTES } });
    for (const chain of [1, 2]) {
      const main = await start({ files: { "m.gguf": BYTES }, redirect: cdn.origin, chain });
      const { service, dest } = make(main, { token: "T0KEN-SECRET", trusted: [cdn.origin] });
      cdn.log.length = 0;
      await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE });
      expect(main.log[0]!.authorization).toBe("Bearer T0KEN-SECRET");
      expect(cdn.log.length).toBeGreaterThanOrEqual(1);
      expect(cdn.log.every((l) => l.authorization === undefined)).toBe(true);
    }
  });
});

describe("(4-B) 429 défensif : message clair, Retry-After honoré, aucune relance", () => {
  it("au 1ᵉʳ saut : exactement 1 requête, secondes lues, rien d'écrit", async () => {
    const fake = await start({ files: { "m.gguf": BYTES }, rateLimit: { retryAfter: "7", at: "resolve" } });
    const { service, dest, journal } = make(fake);
    const error = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: ONE }));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(7);
    expect(fake.log).toHaveLength(1);
    expect(listAll(dest)).toEqual([]);
    expect(journal).toEqual([]);
  });

  it("au saut du CDN : exactement 2 requêtes, date HTTP lue ; sans Retry-After : null", async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const fake = await start({ files: { "m.gguf": BYTES }, rateLimit: { retryAfter: at, at: "cdn" } });
    const a = make(fake);
    const e1 = await failure(a.service.downloadSet({ repo: REPO, revision: SHA, destDir: a.dest, files: ONE }));
    expect(e1.code).toBe("RATE_LIMITED");
    expect(e1.retryAfterSeconds as number).toBeGreaterThanOrEqual(85);
    expect(e1.retryAfterSeconds as number).toBeLessThanOrEqual(91);
    expect(fake.log).toHaveLength(2);

    const bare = await start({ files: { "m.gguf": BYTES }, rateLimit: { at: "cdn" } });
    const b = make(bare);
    const e2 = await failure(b.service.downloadSet({ repo: REPO, revision: SHA, destDir: b.dest, files: ONE }));
    expect(e2.code).toBe("RATE_LIMITED");
    expect(e2.retryAfterSeconds).toBeNull();
    expect(bare.log).toHaveLength(2);
    expect(listAll(b.dest)).toEqual([]);
  });

  it("la recherche, la fiche, la liste et une page tree : exactement UNE requête chacune, RATE_LIMITED", async () => {
    const model = { sha: SHA, siblings: [{ rfilename: "a.gguf" }], tree: [{ type: "file", path: "a.gguf", size: 5 }] };
    const all = await start({ files: {}, models: { [REPO]: model }, apiRateLimit: { retryAfter: "12" } });
    const a = make(all);
    for (const [label, run] of [
      ["recherche", () => a.service.search("qwen")],
      ["liste", () => a.service.files(REPO)],
      ["fiche", () => a.service.repoInfo(REPO)],
    ] as const) {
      all.log.length = 0;
      const error = await failure(run());
      expect(error.code, label).toBe("RATE_LIMITED");
      expect(error.retryAfterSeconds, label).toBe(12);
      expect(all.log, label).toHaveLength(1);
    }

    // une page tree : la fiche passe (blobs sans taille ⇒ repli), la page tree répond 429
    const onlyTree = await start({ files: {}, models: { [REPO]: model }, apiRateLimit: { retryAfter: "3", onlyTree: true } });
    const b = make(onlyTree);
    const error = await failure(b.service.repoInfo(REPO));
    expect(error.code).toBe("RATE_LIMITED");
    expect(onlyTree.log.filter((l) => l.path.includes("/tree/"))).toHaveLength(1);
    expect(onlyTree.log).toHaveLength(2);
  });
});

describe("(4-C) espace libre : somme des tailles + 1 Gio, vérifié AVANT le premier octet", () => {
  const sizes = [30_000, 40_000, 50_000];
  const parts = sizes.map((n, i) => bytesOf(n, 10 + i));
  const names = ["m-00001-of-00003.gguf", "m-00002-of-00003.gguf", "m-00003-of-00003.gguf"];
  const files = Object.fromEntries(names.map((n, i) => [n, parts[i]!]));
  const expected = names.map((n, i) => ({ name: n, size: sizes[i]!, sha256: sha256(parts[i]!) }));
  const sum = sizes.reduce((a, b) => a + b, 0);

  it("libre = exigé − 1 : INSUFFICIENT_SPACE, 0 requête, dossier de destination non créé, message en octets", async () => {
    const fake = await start({ files });
    const probed: string[] = [];
    const { service, dest } = make(fake, { freeBytes: (dir) => (probed.push(dir), sum + HF_DISK_MARGIN_BYTES - 1) });
    const fresh = join(dest, "pas-encore", "la");
    const error = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: fresh, files: expected }));
    expect(error.code).toBe("INSUFFICIENT_SPACE");
    expect(fake.log).toHaveLength(0);
    expect(existsSync(join(dest, "pas-encore"))).toBe(false);
    expect(error.message).toContain(String(sum + HF_DISK_MARGIN_BYTES - 1));
    expect(error.message).toContain(String(sum + HF_DISK_MARGIN_BYTES));
    // l'espace est lu sur le plus proche dossier EXISTANT de la destination
    expect(probed).toEqual([dest]);
  });

  it("libre = exigé : accepté", async () => {
    const fake = await start({ files });
    const { service, dest } = make(fake, { freeBytes: () => sum + HF_DISK_MARGIN_BYTES });
    const result = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: expected });
    expect(result).toHaveLength(3);
  });

  it("chaque fichier tient seul mais la SOMME ne tient pas : refusé", async () => {
    const fake = await start({ files });
    const { service, dest } = make(fake, { freeBytes: () => Math.max(...sizes) + HF_DISK_MARGIN_BYTES + 10 });
    const error = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: expected }));
    expect(error.code).toBe("INSUFFICIENT_SPACE");
    expect(fake.log).toHaveLength(0);
    expect(listAll(dest)).toEqual([]);
  });

  it("espace indéterminable (lecture en échec, valeur absurde) : refusé, le message le dit", async () => {
    for (const freeBytes of [
      () => {
        throw new Error("statfs impossible");
      },
      () => Number.NaN,
      () => -1,
    ]) {
      const fake = await start({ files });
      const { service, dest } = make(fake, { freeBytes });
      const error = await failure(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: expected }));
      expect(error.code).toBe("INSUFFICIENT_SPACE");
      expect(error.message).toMatch(/indéterminable/);
      expect(fake.log).toHaveLength(0);
    }
  });

  it("la validation (révision) passe avant le contrôle d'espace", async () => {
    const fake = await start({ files });
    const { service, dest } = make(fake, { freeBytes: () => 0 });
    const bad = await failure(service.downloadSet({ repo: REPO, revision: "main", destDir: dest, files: expected }));
    expect(bad.code).toBe("INVALID_REVISION");
  });
});
