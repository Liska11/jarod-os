// Chantier 5a de SPECS-P5-MODELS.md, barre (5a-B) suite et (5a-C) : le verdict DISTANT (`checkFit`) — cache d'abord, sinon lecture `Range` de l'en-tête du premier fragment à
// la révision épinglée, mise en cache du seul résultat, verdict recalculé pour les options demandées. Barres figées dans DECISIONS AVANT ce code. Serveur Hugging Face factice
// local ; `guardedFetch` rend rouge tout accès au vrai réseau et compte chaque appel.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GGUF_WINDOW_BYTES, fitReportFromMetadata, parseGgufMetadata, reportGgufFit } from "../src/gguf-fit.js";
import { HfFitCache } from "../src/hf-fit-cache.js";
import { checkFit } from "../src/hf-fit.js";
import { groupGgufFiles } from "../src/hf-repo.js";
import { HuggingFaceService } from "../src/huggingface.js";
import { type FakeHf, type FakeHfOptions, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";
import { STD_LLAMA, barAFixtures, gguf, withTail } from "./gguf-fixtures.js";

const GIB = 1024 ** 3;
const REPO = "acme/tiny-GGUF";
const SHA2 = "c".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "jarod-hffit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: FakeHf[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const start = async (options: FakeHfOptions) => {
  const s = await startFakeHf(options);
  servers.push(s);
  return s;
};

let n = 0;
function setup(fake: FakeHf, cache = new HfFitCache({ path: join(dir, `cache-${n++}.json`) })) {
  const guarded = guardedFetch([fake.origin]);
  const service = new HuggingFaceService({ baseUrl: fake.origin, fetchImpl: guarded.fetch });
  return { service, cache, guarded };
}
const entryOf = (files: Record<string, Buffer>, wanted: string[] = Object.keys(files)) =>
  groupGgufFiles(wanted.map((name) => ({ name, size: files[name]!.length, sha256: null }))).entries[0]!;

const OPTS = { contextTokens: 8192, gpuBytes: 24 * GIB, parallelSlots: 1 };

describe("(5a-B/C) verdict distant = verdict local, avec ou sans cache", () => {
  const fixtures = barAFixtures();

  it("6 fixtures : rapports identiques à reportGgufFit sur le même GGUF local, à la 1ʳᵉ lecture ET depuis le cache", async () => {
    const fake = await start({ files: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, f.bytes])) });
    const { service, cache, guarded } = setup(fake);
    for (const [name, f] of Object.entries(fixtures)) {
      const path = join(dir, name);
      writeFileSync(path, f.bytes);
      const opts = { ...OPTS, contextTokens: f.ctx };
      const local = await reportGgufFit(path, opts);
      const entry = entryOf({ [name]: f.bytes });
      const first = await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: opts });
      expect(first.state, name).toBe("checked");
      if (first.state !== "checked") continue;
      expect(first.report, name).toEqual(local);
      expect(first.report.fit.status, name).toBe(f.status);
      expect(first.cached, name).toBe(false);
      expect(first.transferredBytes, name).toBeLessThanOrEqual(GGUF_WINDOW_BYTES);
      const before = guarded.calls.length;
      const again = await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: opts });
      expect(again.state, name).toBe("checked");
      if (again.state !== "checked") continue;
      expect(again.report, name).toEqual(local); // le cache ne change PAS le verdict
      expect(again.cached, name).toBe(true);
      expect(again.requests, name).toBe(0);
      expect(guarded.calls.length, name).toBe(before);
    }
  });

  it("fitReportFromMetadata rend EXACTEMENT ce que reportGgufFit rend (extraction sans changement de comportement)", async () => {
    for (const [name, f] of Object.entries(fixtures)) {
      const path = join(dir, `x-${name}`);
      writeFileSync(path, f.bytes);
      const opts = { contextTokens: f.ctx, gpuBytes: 24 * GIB, cacheType: "q8_0" as const, gpuLayers: 999 };
      const viaFile = await reportGgufFit(path, opts);
      const meta = parseGgufMetadata(f.bytes.subarray(0, GGUF_WINDOW_BYTES));
      if (viaFile.fileBytes === null) continue; // illisible : pas de métadonnées à rejouer
      expect(fitReportFromMetadata(meta, f.bytes.length, opts), name).toEqual(viaFile);
    }
  });

  it("le cache garde l'ANALYSE, pas le verdict : un autre contexte et un autre type de cache = 0 requête et verdict de reportGgufFit pour ces options", async () => {
    const f = fixtures["standard.gguf"]!;
    const path = join(dir, "std-opts.gguf");
    writeFileSync(path, f.bytes);
    const fake = await start({ files: { "standard.gguf": f.bytes } });
    const { service, cache, guarded } = setup(fake);
    const entry = entryOf({ "standard.gguf": f.bytes });
    await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: OPTS });
    const before = guarded.calls.length;
    for (const options of [
      { contextTokens: 131_072, gpuBytes: 24 * GIB, parallelSlots: 1, cacheType: "q4_0" as const },
      { contextTokens: 512, gpuBytes: 2 * GIB, parallelSlots: 1 },
      { contextTokens: 8192, gpuBytes: null, parallelSlots: 1, cacheType: "q8_0" as const },
    ]) {
      const r = await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options });
      expect(r.state).toBe("checked");
      if (r.state === "checked") expect(r.report).toEqual(await reportGgufFit(path, options));
    }
    expect(guarded.calls.length).toBe(before);
  });
});

describe("(5a-B) clé du cache : révision et taille", () => {
  it("une nouvelle révision OU une taille différente = relecture ; la même clé = aucune requête", async () => {
    const std = barAFixtures()["standard.gguf"]!.bytes;
    const bigger = withTail(gguf(STD_LLAMA), 11_000_000);
    const fake = await start({ files: { "m.gguf": std } });
    const { service, cache, guarded } = setup(fake);
    await checkFit({ service, cache, repo: REPO, sha: SHA, entry: entryOf({ "m.gguf": std }), options: OPTS });
    const base = guarded.calls.length;
    await checkFit({ service, cache, repo: REPO, sha: SHA, entry: entryOf({ "m.gguf": std }), options: OPTS });
    expect(guarded.calls.length).toBe(base); // même clé
    const r2 = await checkFit({ service, cache, repo: REPO, sha: SHA2, entry: entryOf({ "m.gguf": std }), options: OPTS });
    expect(r2.state === "checked" && r2.cached).toBe(false); // le dépôt a avancé
    expect(guarded.calls.length).toBeGreaterThan(base);
    const fake2 = await start({ files: { "m.gguf": bigger } });
    const b = setup(fake2, cache);
    const r3 = await checkFit({ service: b.service, cache, repo: REPO, sha: SHA, entry: entryOf({ "m.gguf": bigger }), options: OPTS });
    expect(r3.state === "checked" && r3.cached).toBe(false); // la taille a changé
    expect(b.guarded.calls.length).toBeGreaterThan(0);
  });

  it("force relit (une lecture) et remplace l'entrée", async () => {
    const std = barAFixtures()["standard.gguf"]!.bytes;
    const fake = await start({ files: { "m.gguf": std } });
    const { service, cache, guarded } = setup(fake);
    const entry = entryOf({ "m.gguf": std });
    await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: OPTS });
    const before = guarded.calls.length;
    const r = await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: OPTS, force: true });
    expect(r.state === "checked" && r.cached).toBe(false);
    expect(guarded.calls.length).toBe(before + 2); // 302 puis 206 : une lecture
    expect(cache.size).toBe(1);
  });
});

describe("(5a-B) « Not checked » n'est JAMAIS mis en cache ; « Not estimated » l'est", () => {
  const std = barAFixtures()["standard.gguf"]!.bytes;
  const entry = entryOf({ "m.gguf": std });

  it("429 (secondes) : not-checked RATE_LIMITED avec retryAfterSeconds, une lecture partie, rien en cache, la lecture suivante PART", async () => {
    const limited = await start({ files: { "m.gguf": std }, rateLimit: { retryAfter: "7", at: "resolve" } });
    const a = setup(limited);
    const r = await checkFit({ service: a.service, cache: a.cache, repo: REPO, sha: SHA, entry, options: OPTS });
    expect(r).toMatchObject({ state: "not-checked", code: "RATE_LIMITED", retryAfterSeconds: 7 });
    expect(limited.log).toHaveLength(1); // aucune relance
    expect(a.cache.size).toBe(0);
    const healthy = await start({ files: { "m.gguf": std } });
    const b = setup(healthy, a.cache);
    const ok = await checkFit({ service: b.service, cache: a.cache, repo: REPO, sha: SHA, entry, options: OPTS });
    expect(ok.state === "checked" && ok.cached).toBe(false);
    expect(b.guarded.calls.length).toBe(2);
  });

  it("Range ignoré (200), délai dépassé, annulation : not-checked, jamais en cache", async () => {
    const ignoring = await start({ files: { "m.gguf": std }, rangeMode: "ignore", redirect: "none" });
    const a = setup(ignoring);
    expect(await checkFit({ service: a.service, cache: a.cache, repo: REPO, sha: SHA, entry, options: OPTS })).toMatchObject({ state: "not-checked", code: "RANGE_NOT_HONORED" });
    const hanging = await start({ files: { "m.gguf": std }, hang: true });
    const b = setup(hanging);
    expect(await checkFit({ service: b.service, cache: b.cache, repo: REPO, sha: SHA, entry, options: OPTS, timeoutMs: 80 })).toMatchObject({ state: "not-checked", code: "TIMEOUT" });
    const fine = await start({ files: { "m.gguf": std } });
    const c = setup(fine);
    const ctl = new AbortController();
    ctl.abort();
    expect(await checkFit({ service: c.service, cache: c.cache, repo: REPO, sha: SHA, entry, options: OPTS, signal: ctl.signal })).toMatchObject({ state: "not-checked", code: "ABORTED" });
    expect(a.cache.size + b.cache.size + c.cache.size).toBe(0);
  });

  it("architecture hors v1 : « Not estimated » est un résultat d'analyse, mis en cache (0 requête ensuite)", async () => {
    const unknown = barAFixtures()["inconnue.gguf"]!.bytes;
    const fake = await start({ files: { "u.gguf": unknown } });
    const { service, cache, guarded } = setup(fake);
    const e = entryOf({ "u.gguf": unknown });
    const first = await checkFit({ service, cache, repo: REPO, sha: SHA, entry: e, options: OPTS });
    expect(first.state === "checked" && first.report.fit.status).toBe("not-estimated");
    const before = guarded.calls.length;
    const second = await checkFit({ service, cache, repo: REPO, sha: SHA, entry: e, options: OPTS });
    expect(second.state === "checked" && second.cached).toBe(true);
    expect(guarded.calls.length).toBe(before);
  });

  it("en-tête hostile (mauvais magic) : « Not estimated » avec la raison, mis en cache, jamais une exception", async () => {
    const junk = Buffer.alloc(3_000_000, 1);
    const fake = await start({ files: { "j.gguf": junk } });
    const { service, cache, guarded } = setup(fake);
    const e = entryOf({ "j.gguf": junk });
    const first = await checkFit({ service, cache, repo: REPO, sha: SHA, entry: e, options: OPTS });
    expect(first.state).toBe("checked");
    if (first.state === "checked") {
      expect(first.report.fit.status).toBe("not-estimated");
      expect(first.report.fit.reason).toMatch(/BAD_MAGIC|GGUF/i);
      expect(first.report.fileBytes).toBeNull();
    }
    const before = guarded.calls.length;
    const second = await checkFit({ service, cache, repo: REPO, sha: SHA, entry: e, options: OPTS });
    expect(second.state === "checked" && second.cached).toBe(true);
    expect(guarded.calls.length).toBe(before);
    if (first.state === "checked" && second.state === "checked") expect(second.report).toEqual(first.report);
  });
});

describe("(5a-B/C) modèle découpé : en-tête du PREMIER fragment, poids = somme", () => {
  it("seul le 1ᵉʳ fragment est lu ; fileBytes = somme des tailles ; verdict = fitReportFromMetadata de l'en-tête et de la somme", async () => {
    const first = withTail(gguf(STD_LLAMA), 3_000_000);
    const second = Buffer.alloc(4_000_000, 9);
    const files = { "m-00001-of-00002.gguf": first, "m-00002-of-00002.gguf": second };
    const fake = await start({ files });
    const { service, cache } = setup(fake);
    const entry = entryOf(files);
    const r = await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: OPTS });
    expect(r.state).toBe("checked");
    if (r.state !== "checked") return;
    expect(fake.log.every((l) => !l.path.includes("m-00002-of-00002"))).toBe(true);
    expect(r.report.fileBytes).toBe(first.length + second.length);
    expect(r.report).toEqual(fitReportFromMetadata(parseGgufMetadata(first.subarray(0, GGUF_WINDOW_BYTES)), first.length + second.length, OPTS));
    expect(cache.has({ repo: REPO, sha: SHA, file: "m-00001-of-00002.gguf", size: first.length })).toBe(true);
  });

  it("jeu incomplet : not-checked INCOMPLETE_SET, 0 requête", async () => {
    const first = withTail(gguf(STD_LLAMA), 1000);
    const fake = await start({ files: { "m-00001-of-00003.gguf": first } });
    const { service, cache, guarded } = setup(fake);
    const entry = groupGgufFiles([{ name: "m-00001-of-00003.gguf", size: first.length, sha256: null }]).entries[0]!;
    expect(entry.complete).toBe(false);
    expect(await checkFit({ service, cache, repo: REPO, sha: SHA, entry, options: OPTS })).toMatchObject({ state: "not-checked", code: "INCOMPLETE_SET", requests: 0 });
    expect(guarded.calls).toHaveLength(0);
  });
});
