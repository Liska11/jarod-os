/**
 * Chantier 5b de SPECS-P5-MODELS.md : les canaux `hf-*` du MAIN (§ 3.10 (d)–(f), (i)). VRAI kernel, VRAIS handlers, serveur Hugging Face FACTICE local
 * (`plugins/llm/test/fake-hf-server.ts`) ; `guardedFetch` rend rouge tout accès au vrai réseau et compte chaque appel. Barres figées dans DECISIONS le 2026-10-03
 * AVANT ce code : (5b-A) canaux et schémas, (5b-B) confirmation, (5b-C) verrou, (5b-D) révision, (5b-E) `hf-fit`, (5b-F) 429, (5b-G) jeton, (5b-H) destination, (5b-J) progression.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { JAROD_EVENT_CHANNELS, JAROD_INVOKE_CHANNELS } from "@jarod/contracts/ipc";
import { reportGgufFit, secretKeyFor } from "@jarod/plugin-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeHf, type FakeHfOptions, SHA, guardedFetch, startFakeHf } from "../../plugins/llm/test/fake-hf-server.js";
import { barAFixtures } from "../../plugins/llm/test/gguf-fixtures.js";
import { engineBudget } from "../src/main/engine-budget.js";
import type { HfWiring } from "../src/main/handlers/context.js";
import { setupKernel } from "./ui-parite-helpers.js";

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
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await cleanup();
});

const sibling = (name: string, bytes: Buffer, published = true) => ({ rfilename: name, size: bytes.length, ...(published ? { lfs: { sha256: sha256(bytes), size: bytes.length, pointerSize: 134 } } : {}) });
const modelOf = (files: Record<string, Buffer>, over: Record<string, unknown> = {}, unpublished: string[] = []) => ({
  sha: SHA,
  gated: false,
  cardData: { license: "mit" },
  tags: [],
  siblings: Object.entries(files).map(([name, bytes]) => sibling(name, bytes, !unpublished.includes(name))),
  ...over,
});

interface Env {
  fake: FakeHf;
  guarded: ReturnType<typeof guardedFetch>;
  call: (channel: string, ...args: unknown[]) => Promise<any>;
  confirms: { message: string; detail: string; action?: string }[];
  sent: unknown[][];
  on: (channel: string) => unknown[][];
  app: Awaited<ReturnType<typeof setupKernel>>["app"];
  kernel: Awaited<ReturnType<typeof setupKernel>>["kernel"];
  handlers: Awaited<ReturnType<typeof setupKernel>>["handlers"];
  dataRoot: string;
  models: string;
  wiring: HfWiring;
  /** Choisit le dossier des modèles par le canal (la boîte native simulée rend `models`). */
  chooseModels(): Promise<void>;
  resolveHits(): FakeHf["log"];
}

async function env(
  files: Record<string, Buffer>,
  o: {
    model?: Record<string, unknown>;
    unpublished?: string[];
    fake?: Partial<FakeHfOptions>;
    wiring?: Partial<HfWiring>;
    answers?: boolean[];
    confirm?: (message: string, detail: string, action?: string) => Promise<boolean>;
    noConfirm?: boolean;
    token?: string;
    cdn?: FakeHf;
    pick?: (title: string, defaultPath?: string) => Promise<string | null>;
    models?: string;
  } = {},
): Promise<Env> {
  const fake = await startFakeHf({
    files,
    ...(o.cdn ? { redirect: o.cdn.origin } : {}),
    models: { [REPO]: modelOf(files, o.model, o.unpublished) },
    ...o.fake,
  });
  servers.push(fake);
  const guarded = guardedFetch([fake.origin, ...(o.cdn ? [o.cdn.origin] : [])]);
  const models = o.models ?? tempDir();
  const wiring: HfWiring = { baseUrl: fake.origin, fetchImpl: guarded.fetch, freeBytes: () => Number.MAX_SAFE_INTEGER, ...(o.cdn ? { extraTrustedOrigins: [o.cdn.origin] } : {}), ...o.wiring };
  const dataRoot = tempDir();
  const k = await setupKernel(undefined, o.answers ?? [true], {
    huggingface: wiring,
    pickDestinationFolder: o.pick ?? (async () => models),
    ...(o.confirm ? { confirm: o.confirm } : {}),
    ...(o.noConfirm ? { noConfirm: true } : {}),
    dataRoot,
  });
  if (o.token) k.app.agent.settings.setSecret(secretKeyFor("huggingface"), o.token);
  const env: Env = {
    fake,
    guarded,
    call: async (channel, ...args) => k.call(channel, ...args),
    confirms: k.confirms,
    sent: k.sent,
    on: k.on,
    app: k.app,
    kernel: k.kernel,
    handlers: k.handlers,
    dataRoot,
    models,
    wiring,
    chooseModels: async () => void (await k.call("hf-pick-models-dir")),
    resolveHits: () => fake.log.filter((l) => l.path.includes("/resolve/")),
  };
  return env;
}

const failsWith = async (p: Promise<unknown>, pattern: RegExp) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x as Error,
  );
  expect(e, `attendu un rejet ${String(pattern)}`).toBeInstanceOf(Error);
  expect((e as Error).message).toMatch(pattern);
  return e as Error;
};

const SMALL = bytesOf(60_000, 1);
const BIG = bytesOf(4 * 1024 * 1024, 2);

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-A)

describe("(5b-A) canaux et schémas", () => {
  const HF = ["hf-search", "hf-repo", "hf-fit", "hf-download", "hf-download-cancel", "hf-models-dir", "hf-pick-models-dir"];

  it("les 7 canaux sont dans la liste blanche Jarod, l'événement hf-progress aussi, et tous sont servis", async () => {
    for (const c of HF) expect((JAROD_INVOKE_CHANNELS as readonly string[]).includes(c), c).toBe(true);
    expect((JAROD_EVENT_CHANNELS as readonly string[]).includes("hf-progress")).toBe(true);
    const e = await env({ "m.gguf": SMALL });
    for (const c of HF) expect(typeof e.handlers[c], c).toBe("function");
  });

  it("champ inconnu refusé sur CHAQUE canal à entrée ; aucun argument accepté sur ceux qui n'en ont pas", async () => {
    const e = await env({ "m.gguf": SMALL });
    const valid: Record<string, Record<string, unknown>> = {
      "hf-search": { query: "tiny" },
      "hf-repo": { repo: REPO },
      "hf-fit": { repo: REPO, sha: SHA, keys: ["m.gguf"], contextTokens: 8192, cacheType: "f16" },
      "hf-download": { repo: REPO, sha: SHA, keys: ["m.gguf"] },
    };
    for (const [ch, input] of Object.entries(valid)) await failsWith(e.call(ch, { ...input, intrus: 1 }), /champ|accept/i);
    for (const ch of ["hf-download-cancel", "hf-models-dir", "hf-pick-models-dir"]) await failsWith(e.call(ch, { x: 1 }), /argument|accept|attendu/i);
    expect(e.fake.log).toHaveLength(0);
  });

  it("jamais un chemin, une taille, une empreinte, une URL, une base ou un fichier venant du renderer", async () => {
    const e = await env({ "m.gguf": SMALL });
    for (const ch of ["hf-fit", "hf-download"] as const) {
      const base = ch === "hf-fit" ? { repo: REPO, sha: SHA, keys: ["m.gguf"], contextTokens: 8192, cacheType: "f16" } : { repo: REPO, sha: SHA, keys: ["m.gguf"] };
      for (const field of ["size", "sizes", "sha256", "path", "destDir", "url", "baseUrl", "file", "files", "revision", "expected"]) await failsWith(e.call(ch, { ...base, [field]: "x" }), /champ|accept/i);
    }
    await failsWith(e.call("hf-repo", { repo: REPO, baseUrl: "http://127.0.0.1:1" }), /champ|accept/i);
    await failsWith(e.call("hf-search", { query: "x", baseUrl: "http://127.0.0.1:1" }), /champ|accept/i);
    expect(e.fake.log).toHaveLength(0);
  });

  it("bornes : requête 1 à 100, dépôt valide, clés 1 à 100 (fit) / 1 à 8 (download), contexte entier 512 à 2 097 152, cache f16 / q8_0 / q4_0", async () => {
    const e = await env({ "m.gguf": SMALL });
    for (const query of ["", "x".repeat(101), "a\u0000b", "a\nb", 42, null, undefined]) await failsWith(e.call("hf-search", { query }), /requête|query|attendu/i);
    for (const repo of ["../x", "a/b/c", "a", "a/b?x", "a/b.", "", 5]) await failsWith(e.call("hf-repo", { repo }), /dépôt|repo/i);
    const fit = (over: Record<string, unknown>) => e.call("hf-fit", { repo: REPO, sha: SHA, keys: ["m.gguf"], contextTokens: 8192, cacheType: "f16", ...over });
    await failsWith(fit({ keys: [] }), /clé|keys/i);
    await failsWith(fit({ keys: Array.from({ length: 101 }, (_, i) => `k${i}`) }), /clé|keys/i);
    await failsWith(fit({ keys: [5] }), /clé|keys/i);
    for (const contextTokens of [511, 2_097_153, 1.5, "8192", null, Number.NaN]) await failsWith(fit({ contextTokens }), /contexte|context/i);
    for (const cacheType of ["q5_0", "F16", "", 1]) await failsWith(fit({ cacheType }), /cache/i);
    await failsWith(fit({ sha: "main" }), /révision|sha/i);
    await failsWith(e.call("hf-download", { repo: REPO, sha: SHA, keys: [] }), /clé|keys/i);
    await failsWith(e.call("hf-download", { repo: REPO, sha: SHA, keys: Array.from({ length: 9 }, (_, i) => `k${i}.gguf`) }), /clé|keys/i);
    expect(e.fake.log).toHaveLength(0); // aucune de ces entrées n'a déclenché de requête
  });

  it("créer les handlers et lire hf-models-dir = 0 requête réseau", async () => {
    const e = await env({ "m.gguf": SMALL });
    expect(await e.call("hf-models-dir")).toEqual({ dir: null });
    expect(e.fake.log).toHaveLength(0);
    expect(e.guarded.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- recherche, fiche

describe("hf-search et hf-repo", () => {
  it("hf-search : requête encodée, filtre gguf, 30 résultats au plus, identifiants hostiles écartés, tags non rendus", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `acme/m${i}-GGUF`, downloads: i, likes: 1, tags: ["gguf"] }));
    rows.push({ id: "../evil", downloads: 1, likes: 1, tags: [] }, { id: "a/b/c", downloads: 1, likes: 1, tags: [] });
    const e = await env({ "m.gguf": SMALL }, { fake: { searchRows: rows } });
    const out = await e.call("hf-search", { query: "tiny llama & co" });
    expect(out).toHaveLength(30);
    expect(out[0]).toEqual({ id: "acme/m0-GGUF", downloads: 0, likes: 1 });
    expect(out.every((r: { id: string }) => /^[\w.-]+\/[\w.-]+$/.test(r.id))).toBe(true);
    const hit = e.fake.log[0]!;
    expect(hit.path).toBe("/api/models");
    expect(new URLSearchParams(hit.search).get("search")).toBe("tiny llama & co");
    expect(new URLSearchParams(hit.search).get("filter")).toBe("gguf");
    expect(new URLSearchParams(hit.search).get("limit")).toBe("30");
  });

  it("hf-repo : la fiche à la révision épinglée, fragments regroupés, projecteur étiqueté, licence, gated, « déjà analysé » lu du cache", async () => {
    const files = { "m-Q4.gguf": SMALL, "m-00001-of-00002.gguf": bytesOf(10_000, 3), "m-00002-of-00002.gguf": bytesOf(12_000, 4), "mmproj-F16.gguf": bytesOf(9_000, 5), "n-Q8.gguf": bytesOf(7_000, 6) };
    const e = await env(files, { unpublished: ["n-Q8.gguf"], model: { gated: "manual", cardData: { license: "apache-2.0" } } });
    const view = await e.call("hf-repo", { repo: REPO });
    expect(view).toMatchObject({ repo: REPO, sha: SHA, gated: "manual", license: "apache-2.0", truncated: false, source: "blobs" });
    const byKey = Object.fromEntries(view.entries.map((x: { key: string }) => [x.key, x]));
    expect(Object.keys(byKey).sort()).toEqual(["m-Q4.gguf", "m-of-00002", "mmproj-F16.gguf", "n-Q8.gguf"]);
    expect(byKey["m-of-00002"]).toMatchObject({ shardCount: 2, complete: true, totalBytes: 22_000, projector: false, analyzed: false });
    expect(byKey["m-of-00002"].files.map((f: { name: string }) => f.name)).toEqual(["m-00001-of-00002.gguf", "m-00002-of-00002.gguf"]);
    expect(byKey["mmproj-F16.gguf"].projector).toBe(true);
    expect(byKey["m-Q4.gguf"].projector).toBe(false);
    expect(byKey["n-Q8.gguf"].files[0].sha256).toBeNull();
    expect(byKey["m-Q4.gguf"].files[0]).toEqual({ name: "m-Q4.gguf", size: SMALL.length, sha256: sha256(SMALL) });
    expect(JSON.stringify(view)).not.toMatch(/987654|context_length/); // le résumé gguf de la fiche n'est jamais lu
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-E)

describe("(5b-E) hf-fit", () => {
  const fixtures = barAFixtures();
  const files = Object.fromEntries(Object.entries(fixtures).map(([n, f]) => [n, f.bytes]));
  const OPTS = { contextTokens: 8192, cacheType: "f16" as const };

  it("verdict IDENTIQUE à reportGgufFit sur le même GGUF local (6 fixtures), avec le budget mémoire de la machine ; la seconde analyse = 0 requête", async () => {
    const e = await env(files);
    const view = await e.call("hf-repo", { repo: REPO });
    const budget = engineBudget(await e.app.llm!.detectHardware());
    const dir = tempDir();
    for (const [name, f] of Object.entries(fixtures)) {
      const path = join(dir, name);
      writeFileSync(path, f.bytes);
      const res = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: [name], contextTokens: f.ctx, cacheType: "f16" });
      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      expect(r.state, name).toBe("checked");
      expect(r.report, name).toEqual(await reportGgufFit(path, { contextTokens: f.ctx, cacheType: "f16", parallelSlots: 1, gpuBytes: budget.bytes }));
      if (f.status !== "fits") expect(r.report.fit.status, name).toBe(f.status); // « fits » dépend du budget de la machine : on compare alors au rapport local
      expect(r.cached).toBe(false);
    }
    const before = e.fake.log.length;
    const again = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: ["standard.gguf", "hybride.gguf"], ...OPTS });
    expect(e.fake.log.length).toBe(before); // 0 requête
    expect(again.requests).toBe(0);
    expect(again.results.every((x: { cached: boolean }) => x.cached)).toBe(true);
    // et hf-repo le sait, sans rien envoyer
    const after = await e.call("hf-repo", { repo: REPO });
    expect(after.entries.every((x: { analyzed: boolean }) => x.analyzed)).toBe(true); // les six ont été analysées plus haut
    const fresh = await env(files);
    expect((await fresh.call("hf-repo", { repo: REPO })).entries.some((x: { analyzed: boolean }) => x.analyzed)).toBe(false); // un profil neuf : aucune
  });

  it("force relit (une lecture), un autre contexte sur le cache = 0 requête", async () => {
    const e = await env(files);
    const view = await e.call("hf-repo", { repo: REPO });
    await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: ["standard.gguf"], ...OPTS });
    const before = e.fake.log.length;
    const other = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: ["standard.gguf"], contextTokens: 32768, cacheType: "q8_0" });
    expect(e.fake.log.length).toBe(before);
    expect(other.results[0].report.fit.contextTokens).toBe(32768);
    const forced = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: ["standard.gguf"], ...OPTS, force: true });
    expect(forced.results[0].cached).toBe(false);
    expect(e.fake.log.length).toBe(before + 2);
  });

  it("dépôt jamais listé, sha différent du mémorisé, clé inconnue : STALE_LIST, aucune requête de lecture", async () => {
    const e = await env(files);
    await failsWith(e.call("hf-fit", { repo: REPO, sha: SHA, keys: ["standard.gguf"], ...OPTS }), /HF_STALE_LIST/);
    expect(e.fake.log).toHaveLength(0);
    await e.call("hf-repo", { repo: REPO });
    const n = e.fake.log.length;
    await failsWith(e.call("hf-fit", { repo: REPO, sha: "d".repeat(40), keys: ["standard.gguf"], ...OPTS }), /HF_STALE_LIST/);
    await failsWith(e.call("hf-fit", { repo: REPO, sha: SHA, keys: ["inconnue-du-depot.gguf"], ...OPTS }), /HF_STALE_LIST/);
    expect(e.fake.log.length).toBe(n);
  });

  it("« Check all » : 3 lectures simultanées au plus (et 3 en pratique), tous les résultats rendus", async () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i}.gguf`, fixtures["standard.gguf"]!.bytes]));
    const e = await env(many, { fake: { holdMs: 60 } });
    const view = await e.call("hf-repo", { repo: REPO });
    const res = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: Object.keys(many), ...OPTS });
    expect(res.results).toHaveLength(9);
    expect(res.results.every((x: { state: string }) => x.state === "checked")).toBe(true);
    expect(e.fake.stats.peakCdnInFlight).toBe(3);
  });

  it("« Check all » s'arrête à la PREMIÈRE 429 : les clés restantes sont « non lues », le serveur ne compte que les requêtes déjà parties", async () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}.gguf`, fixtures["standard.gguf"]!.bytes]));
    const e = await env(many, { fake: { rateLimit: { retryAfter: "30", at: "resolve" } } });
    const view = await e.call("hf-repo", { repo: REPO });
    const apiHits = e.fake.log.length;
    const res = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: Object.keys(many), ...OPTS });
    expect(e.fake.log.length - apiHits).toBe(3); // la concurrence : trois lectures étaient déjà parties, aucune relance, aucune autre
    const states = res.results.map((x: { state: string }) => x.state);
    expect(states.filter((s: string) => s === "not-checked")).toHaveLength(3);
    expect(states.filter((s: string) => s === "not-read")).toHaveLength(5);
    expect(res.results.filter((x: { state: string }) => x.state === "not-read").every((x: { reason: string }) => x.reason === "RATE_LIMITED")).toBe(true);
    expect(res.rateLimited).toEqual({ retryAfterSeconds: 30 });
    expect(res.results[0]).toMatchObject({ state: "not-checked", code: "RATE_LIMITED", retryAfterSeconds: 30 });
  });

  it("budget de corps lus : jamais plus que le budget (injecté pour le test), les clés restantes « non lues » BUDGET, et la constante réelle est de 64 Mio", async () => {
    const { HF_FIT_BUDGET_BYTES, HF_FIT_READ_CAP_BYTES } = await import("../src/main/handlers/huggingface.js");
    expect(HF_FIT_BUDGET_BYTES).toBe(64 * 1024 * 1024);
    expect(HF_FIT_READ_CAP_BYTES).toBe(16 * 1024 * 1024);
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`m${i}.gguf`, fixtures["standard.gguf"]!.bytes]));
    const WINDOW = 256 * 1024;
    const e = await env(many, { wiring: { fitBudgetBytes: 3 * WINDOW, fitReadCapBytes: WINDOW } });
    const view = await e.call("hf-repo", { repo: REPO });
    const res = await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: Object.keys(many), ...OPTS });
    expect(res.results.filter((x: { state: string }) => x.state === "checked")).toHaveLength(3);
    expect(res.results.filter((x: { state: string; reason?: string }) => x.state === "not-read" && x.reason === "BUDGET")).toHaveLength(3);
    expect(res.transferredBytes).toBeLessThanOrEqual(3 * WINDOW);
    expect(res.budgetExhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-F)

describe("(5b-F) 429 : message clair, Retry-After honoré, UNE requête, aucune relance", () => {
  const future = (s: number) => new Date(Date.now() + s * 1000).toUTCString();

  it("hf-search et hf-repo (API) : HF_RATE_LIMITED avec le délai en secondes ou « plus tard »", async () => {
    for (const [retryAfter, expected] of [["30", /dans 30 s/], [future(45), /dans (4[0-6]) s/], [undefined, /plus tard/]] as const) {
      const e = await env({ "m.gguf": SMALL }, { fake: { apiRateLimit: { retryAfter } } });
      await failsWith(e.call("hf-search", { query: "tiny" }), new RegExp(`^HF_RATE_LIMITED: .*${expected.source}`));
      expect(e.fake.log).toHaveLength(1);
      await failsWith(e.call("hf-repo", { repo: REPO }), /^HF_RATE_LIMITED/);
      expect(e.fake.log).toHaveLength(2);
    }
  });

  it("hf-download (le transfert) : HF_RATE_LIMITED, une seule requête de transfert, rien d'écrit", async () => {
    const e = await env({ "m.gguf": SMALL }, { fake: { rateLimit: { retryAfter: "12", at: "resolve" } }, answers: [true, true] });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_RATE_LIMITED: .*dans 12 s/);
    expect(e.resolveHits()).toHaveLength(1);
    expect(listAll(e.models).filter((p) => /\.(gguf|part)$/.test(p))).toEqual([]); // le dossier de l'opération peut rester vide (T4), jamais un fichier
    // et le verrou est rendu
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_RATE_LIMITED/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-B)

describe("(5b-B) confirmation native avant tout transfert", () => {
  it("accord : fichier écrit sous <dossier>/<owner>__<repo>/, vérifié ; la boîte dit TOUT, une seule boîte", async () => {
    const files = { "m-Q4.gguf": SMALL, "n-Q8.gguf": bytesOf(7_000, 6) };
    const e = await env(files, { unpublished: ["n-Q8.gguf"], model: { gated: "manual", cardData: { license: "mit" } } });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    const out = await e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m-Q4.gguf", "n-Q8.gguf"] });
    // Chemin réel : sur la CI Windows, le dossier temporaire est un nom court (RUNNER~1) que le dossier des modèles développe.
    expect(out.destDir.toLowerCase()).toBe(join(realpathSync.native(e.models), "acme__tiny-GGUF").toLowerCase());
    expect(out.files.map((f: { name: string }) => f.name).sort()).toEqual(["m-Q4.gguf", "n-Q8.gguf"]);
    expect(readFileSync(join(out.destDir, "m-Q4.gguf")).equals(SMALL)).toBe(true);
    expect(out.files.find((f: { name: string }) => f.name === "n-Q8.gguf").verified).toBe("size-only");
    expect(out.files.find((f: { name: string }) => f.name === "m-Q4.gguf").verified).toBe("sha256");
    expect(listAll(out.destDir).filter((p) => p.endsWith(".part"))).toEqual([]);
    expect(e.confirms).toHaveLength(1);
    const box = e.confirms[0]!;
    expect(box.action).toBe("Télécharger");
    expect(box.message).toBe("Télécharger 2 fichier(s) depuis huggingface.co ?");
    for (const needle of [
      REPO,
      view.sha,
      "m-Q4.gguf",
      `${SMALL.length} octets`,
      sha256(SMALL), // empreinte COMPLÈTE
      "n-Q8.gguf",
      "empreinte non publiée : seule la taille est vérifiée",
      `Total : ${SMALL.length + 7_000} octets`,
      "Licence : mit",
      "gated",
      "manual",
      out.destDir,
      "Espace libre",
      "non analysé",
      "Annulable. Aucun fichier n'est utilisable avant la fin de la vérification.",
    ]) {
      expect(box.detail.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  it("licence absente : « non indiquée » ; verdict lu du CACHE (lignes séparées, KV à part) quand l'entrée a été analysée", async () => {
    const files = { "standard.gguf": barAFixtures()["standard.gguf"]!.bytes };
    const e = await env(files, { model: { cardData: {}, tags: [] } });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: ["standard.gguf"], contextTokens: 8192, cacheType: "f16" });
    await e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["standard.gguf"], contextTokens: 8192, cacheType: "f16" });
    const detail = e.confirms[0]!.detail;
    expect(detail).toContain("Licence : non indiquée");
    expect(detail).toMatch(/poids du fichier : /);
    expect(detail).toMatch(/cache KV \(8192 jetons/);
    expect(detail).toMatch(/marge de calcul/);
    // aucune lecture d'en-tête à la confirmation : le nombre de lectures `Range` n'a pas bougé
    expect(e.fake.log.filter((l) => l.range !== undefined && l.path.startsWith("/cdn/")).length).toBe(1);
  });

  it("refus de la boîte : HF_DECLINED, ZÉRO requête de transfert, 0 octet, 0 dossier, 0 .part ; le verrou est rendu", async () => {
    const e = await env({ "m.gguf": SMALL }, { answers: [false, true] });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_DECLINED/);
    expect(e.resolveHits()).toHaveLength(0);
    expect(e.fake.log.some((l) => l.path.startsWith("/cdn/"))).toBe(false);
    expect(listAll(e.models)).toEqual([]);
    await e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }); // le verrou est rendu : la seconde tentative passe
    expect(listAll(e.models).some((p) => p.endsWith("m.gguf"))).toBe(true);
  });

  it("pas de confirmation native disponible = refus, mêmes garanties", async () => {
    const e = await env({ "m.gguf": SMALL }, { noConfirm: true });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_DECLINED.*indisponible/);
    expect(e.resolveHits()).toHaveLength(0);
    expect(listAll(e.models)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-C)

describe("(5b-C) verrou « un seul transfert à la fois »", () => {
  it("un second hf-download pendant le premier : HF_BUSY AVANT toute boîte et sans requête ; une seule boîte au total", async () => {
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>((r) => (release = r));
    const e = await env({ "a.gguf": SMALL, "b.gguf": bytesOf(20_000, 9) }, { confirm: () => gate });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    const first = e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["a.gguf"] });
    await vi.waitFor(() => expect(e.confirms).toHaveLength(1));
    const hitsBefore = e.fake.log.length;
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["b.gguf"] }), /^HF_BUSY/);
    expect(e.confirms).toHaveLength(1);
    expect(e.fake.log.length).toBe(hitsBefore);
    release(true);
    await first;
    await e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["b.gguf"] }); // la boîte répond encore « oui » : le verrou est rendu après le succès
    const written = listAll(e.models).map((p) => p.split(/[\\/]/).pop());
    expect(written).toEqual(expect.arrayContaining(["a.gguf", "b.gguf"]));
  });

  it("le verrou est rendu après : refus de la boîte, échec d'intégrité, annulation, succès (le téléchargement suivant passe)", async () => {
    const good = bytesOf(30_000, 21);
    const files = { "refuse.gguf": good, "echec.gguf": bytesOf(30_000, 22), "annule.gguf": BIG, "ok.gguf": bytesOf(30_000, 23) };
    const e = await env(files, { answers: [false, true, true, true], fake: { corrupt: ["echec.gguf"], chunk: 8 * 1024, chunkDelayMs: 3 } });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    const dl = (k: string) => e.call("hf-download", { repo: REPO, sha: view.sha, keys: [k] });
    await failsWith(dl("refuse.gguf"), /^HF_DECLINED/);
    await failsWith(dl("echec.gguf"), /^HF_HASH_MISMATCH/);
    const already = e.on("hf-progress").length;
    const cancelled = dl("annule.gguf");
    await vi.waitFor(() => expect(e.on("hf-progress").length).toBeGreaterThan(already));
    expect(await e.call("hf-download-cancel")).toBe(true);
    await failsWith(cancelled, /^HF_CANCELLED/);
    await dl("ok.gguf"); // passe : le verrou a été rendu quatre fois de suite
    expect(listAll(e.models).filter((p) => p.endsWith(".gguf")).map((p) => p.split(/[\\/]/).pop())).toEqual(["ok.gguf"]);
  });

  it("hf-download-cancel : annule un transfert lent — .part supprimé, aucune cible, connexion fermée côté serveur ; false quand rien ne tourne", async () => {
    const e = await env({ "big.gguf": BIG }, { fake: { chunk: 8 * 1024, chunkDelayMs: 3 } });
    await e.chooseModels();
    expect(await e.call("hf-download-cancel")).toBe(false);
    const view = await e.call("hf-repo", { repo: REPO });
    const run = e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["big.gguf"] });
    await vi.waitFor(() => expect(e.on("hf-progress").some(([p]) => (p as { received: number }).received > 0)).toBe(true));
    expect(await e.call("hf-download-cancel")).toBe(true);
    await failsWith(run, /^HF_CANCELLED/);
    await new Promise((r) => setTimeout(r, 80));
    expect(listAll(e.models).filter((p) => /\.(gguf|part)$/.test(p))).toEqual([]);
    expect(e.fake.log.find((l) => l.path.startsWith("/cdn/"))!.aborted).toBe(true);
    expect(await e.call("hf-download-cancel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-D)

describe("(5b-D) révision et listes périmées", () => {
  it("le sha change entre la liste et le transfert : HF_REPO_CHANGED, zéro requête de transfert, aucune boîte ; après relecture, ça passe", async () => {
    const e = await env({ "m.gguf": SMALL });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    const newer = "e".repeat(40);
    (e.fake.options.models![REPO] as { sha: string }).sha = newer;
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_REPO_CHANGED/);
    expect(e.resolveHits()).toHaveLength(0);
    expect(e.confirms).toHaveLength(0);
    const fresh = await e.call("hf-repo", { repo: REPO });
    expect(fresh.sha).toBe(newer);
    await e.call("hf-download", { repo: REPO, sha: fresh.sha, keys: ["m.gguf"] });
    expect(e.resolveHits()[0]!.path).toContain(`/resolve/${newer}/`); // la révision épinglée, jamais main
  });

  it("clé inconnue : HF_STALE_LIST ; jeu incomplet (fragment manquant) : HF_NOT_DOWNLOADABLE — avant toute requête de transfert", async () => {
    const e = await env({ "m-00001-of-00003.gguf": bytesOf(1000, 3), "m-00003-of-00003.gguf": bytesOf(1000, 4), "ok.gguf": SMALL });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    const incomplete = view.entries.find((x: { complete: boolean }) => !x.complete);
    expect(incomplete.missing).toEqual([2]);
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: [incomplete.key] }), /^HF_NOT_DOWNLOADABLE/);
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["absent.gguf"] }), /^HF_STALE_LIST/);
    expect(e.resolveHits()).toHaveLength(0);
    expect(e.confirms).toHaveLength(0);
  });

  it("les erreurs d'intégrité du service traversent avec leur code : cible présente, espace insuffisant, empreinte fausse, X-Linked-Size divergent", async () => {
    const present = await env({ "m.gguf": SMALL });
    await present.chooseModels();
    mkdirSync(join(present.models, "acme__tiny-GGUF"), { recursive: true });
    writeFileSync(join(present.models, "acme__tiny-GGUF", "m.gguf"), "déjà là");
    const view = await present.call("hf-repo", { repo: REPO });
    await failsWith(present.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_ALREADY_PRESENT/);
    expect(readFileSync(join(present.models, "acme__tiny-GGUF", "m.gguf"), "utf8")).toBe("déjà là"); // jamais écrasé
    expect(present.confirms).toHaveLength(0); // refusé AVANT la boîte : rien à confirmer
    expect(present.resolveHits()).toHaveLength(0);

    const small = await env({ "m.gguf": SMALL }, { wiring: { freeBytes: () => 1000 } });
    await small.chooseModels();
    const v2 = await small.call("hf-repo", { repo: REPO });
    await failsWith(small.call("hf-download", { repo: REPO, sha: v2.sha, keys: ["m.gguf"] }), /^HF_INSUFFICIENT_SPACE/);
    expect(small.resolveHits()).toHaveLength(0);
    expect(small.confirms).toHaveLength(0); // refusé AVANT la boîte

    const linked = await env({ "m.gguf": SMALL }, { fake: { linkedSize: "123" } });
    await linked.chooseModels();
    const v3 = await linked.call("hf-repo", { repo: REPO });
    await failsWith(linked.call("hf-download", { repo: REPO, sha: v3.sha, keys: ["m.gguf"] }), /^HF_LINKED_SIZE_MISMATCH/);
    expect(linked.fake.log.some((l) => l.path.startsWith("/cdn/"))).toBe(false);
  });

  it("dépôt gated : drapeau dans la fiche ; un 401 au transfert donne HF_GATED qui renvoie à huggingface.co, rien d'autre", async () => {
    const e = await env({ "m.gguf": SMALL }, { model: { gated: "manual" }, fake: { resolveStatus: 401 } });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    expect(view.gated).toBe("manual");
    const err = await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_GATED/);
    expect(err.message).toContain("huggingface.co");
    expect(listAll(e.models).filter((p) => /\.(gguf|part)$/.test(p))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-G)

describe("(5b-G) jeton", () => {
  const TOKEN = "hf_TOKEN_SECRET_0123456789abcdefABCDEF";

  it("lu de la clé du fournisseur huggingface ; envoyé à l'origine de base SEULEMENT (absent du saut CDN) ; absent de tout message, résultat, événement, boîte et journal", async () => {
    const cdn = await startFakeHf({ files: { "m.gguf": SMALL } });
    servers.push(cdn);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = await env({ "m.gguf": SMALL }, { token: TOKEN, cdn });
    await e.chooseModels();
    const outputs: unknown[] = [];
    outputs.push(await e.call("hf-search", { query: "tiny" }));
    const view = await e.call("hf-repo", { repo: REPO });
    outputs.push(view);
    outputs.push(await e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }));
    // un échec aussi : 429 sur l'API
    e.fake.options.apiRateLimit = { retryAfter: "5" };
    const failure = await e.call("hf-search", { query: "x" }).then(
      () => "",
      (x: Error) => x.message,
    );
    outputs.push(failure);
    expect(e.fake.log.some((l) => l.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(e.fake.log.filter((l) => l.authorization !== undefined && l.authorization !== `Bearer ${TOKEN}`)).toEqual([]);
    expect(cdn.log.length).toBeGreaterThan(0);
    expect(cdn.log.every((l) => l.authorization === undefined)).toBe(true); // jamais au CDN
    const everything = JSON.stringify([outputs, e.confirms, e.sent, log.mock.calls, warn.mock.calls, errorLog.mock.calls]);
    expect(everything).not.toContain(TOKEN);
  });

  it("sans clé du fournisseur : aucun en-tête Authorization", async () => {
    const e = await env({ "m.gguf": SMALL });
    await e.call("hf-search", { query: "tiny" });
    await e.call("hf-repo", { repo: REPO });
    expect(e.fake.log.every((l) => l.authorization === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-H)

describe("(5b-H) destination", () => {
  it("la boîte native choisit : annulée = null et rien d'écrit ; choisie = enregistrée dans localEngine.modelsDir, relue par hf-models-dir ; défaut présélectionné", async () => {
    const preset = tempDir();
    const seen: [string, string | undefined][] = [];
    let answer: string | null = null;
    const e = await env({ "m.gguf": SMALL }, { wiring: { defaultModelsDir: preset }, pick: async (title, defaultPath) => (seen.push([title, defaultPath]), answer) });
    expect(await e.call("hf-pick-models-dir")).toBeNull();
    expect(await e.call("hf-models-dir")).toEqual({ dir: null });
    answer = e.models;
    const picked = await e.call("hf-pick-models-dir");
    expect(picked.dir.toLowerCase()).toBe(e.models.toLowerCase());
    expect((await e.call("hf-models-dir")).dir.toLowerCase()).toBe(e.models.toLowerCase());
    expect((e.app.agent.settings.get("localEngine") as { modelsDir?: string }).modelsDir?.toLowerCase()).toBe(e.models.toLowerCase());
    expect(seen.every(([, d]) => d === preset)).toBe(true); // le dossier par défaut est PRÉSÉLECTIONNÉ, jamais enregistré tel quel
    expect(seen[0]![0]).toMatch(/modèles|models/i);
  });

  it("défaut inexistant : la boîte s'ouvre sans dossier présélectionné", async () => {
    const seen: (string | undefined)[] = [];
    const e = await env({ "m.gguf": SMALL }, { wiring: { defaultModelsDir: join(tmpdir(), "jarod-n-existe-pas-xyz") }, pick: async (_t, d) => (seen.push(d), null) });
    await e.call("hf-pick-models-dir");
    expect(seen).toEqual([undefined]);
  });

  it("défaut inexistant : l'utilisateur choisit dans la boîte et le dossier est enregistré, SANS erreur ; annulée : null, rien d'écrit", async () => {
    const seen: (string | undefined)[] = [];
    let answer: string | null = null;
    const e = await env({ "m.gguf": SMALL }, { wiring: { defaultModelsDir: join(tmpdir(), "jarod-n-existe-pas-xyz") }, pick: async (_t, d) => (seen.push(d), answer) });
    expect(await e.call("hf-pick-models-dir")).toBeNull(); // annulée : ni erreur ni écriture
    expect(await e.call("hf-models-dir")).toEqual({ dir: null });
    answer = e.models;
    const picked = await e.call("hf-pick-models-dir");
    expect(picked.dir.toLowerCase()).toBe(e.models.toLowerCase());
    expect((await e.call("hf-models-dir")).dir.toLowerCase()).toBe(e.models.toLowerCase());
    expect(seen).toEqual([undefined, undefined]);
  });

  it("sans défaut codé : la présélection vient du RÉGLAGE du profil (localEngine.modelsDir)", async () => {
    const seen: (string | undefined)[] = [];
    let answer: string | null = null;
    const e = await env({ "m.gguf": SMALL }, { pick: async (_t, d) => (seen.push(d), answer) });
    // Rien de choisi encore : la boîte s'ouvre SANS présélection — jamais un chemin d'une autre machine
    // (l'ancien `defaultModelsDir: "S:\\Stack-Hermes\\IA\\models"` du main livré).
    expect(await e.call("hf-pick-models-dir")).toBeNull();
    expect(seen).toEqual([undefined]);
    // L'utilisateur choisit : le réglage du profil porte le dossier…
    answer = e.models;
    await e.call("hf-pick-models-dir");
    // …et la boîte SUIVANTE le présélectionne, sans qu'aucun défaut n'ait été câblé.
    await e.call("hf-pick-models-dir");
    expect(seen.at(-1)?.toLowerCase()).toBe(e.models.toLowerCase());
  });

  it("défaut qui est un FICHIER (pas un dossier) : traité comme absent, aucune présélection", async () => {
    const holder = tempDir();
    const asFile = join(holder, "models");
    writeFileSync(asFile, "pas un dossier");
    const seen: (string | undefined)[] = [];
    const e = await env({ "m.gguf": SMALL }, { wiring: { defaultModelsDir: asFile }, pick: async (_t, d) => (seen.push(d), null) });
    expect(await e.call("hf-pick-models-dir")).toBeNull();
    expect(seen).toEqual([undefined]);
  });

  it("refusé avec la raison, rien d'écrit : sous le profil, sous dataRoot, égal à dataRoot, ou via une jonction qui y mène", async () => {
    let answer = "";
    const e = await env({ "m.gguf": SMALL }, { pick: async () => answer });
    const profileDir = join(e.dataRoot, "profiles", "default");
    mkdirSync(join(profileDir, "modeles"), { recursive: true });
    mkdirSync(join(e.dataRoot, "autre"), { recursive: true });
    const link = join(tempDir(), "raccourci");
    symlinkSync(profileDir, link, "junction");
    for (answer of [join(profileDir, "modeles"), profileDir, join(e.dataRoot, "autre"), e.dataRoot, link]) {
      await failsWith(e.call("hf-pick-models-dir"), /^HF_BAD_MODELS_DIR/);
    }
    expect(await e.call("hf-models-dir")).toEqual({ dir: null });
  });

  it("hf-download sans dossier choisi : HF_NO_MODELS_DIR — avant toute requête et toute boîte", async () => {
    const e = await env({ "m.gguf": SMALL });
    const view = await e.call("hf-repo", { repo: REPO });
    const n = e.fake.log.length;
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_NO_MODELS_DIR/);
    expect(e.fake.log.length).toBe(n);
    expect(e.confirms).toHaveLength(0);
  });

  it("un modelsDir écrit à la main sous le profil est refusé AU TRANSFERT (revérifié), sans requête", async () => {
    const e = await env({ "m.gguf": SMALL });
    const sous = join(e.dataRoot, "profiles", "default", "modeles");
    mkdirSync(sous, { recursive: true });
    e.app.agent.settings.set("localEngine", { ...(e.app.agent.settings.get("localEngine") as object), modelsDir: sous } as never);
    const view = await e.call("hf-repo", { repo: REPO });
    const n = e.fake.log.length;
    await failsWith(e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["m.gguf"] }), /^HF_BAD_MODELS_DIR/);
    expect(e.fake.log.length).toBe(n);
    expect(e.confirms).toHaveLength(0);
  });

  it("local-engine-configure refuse toujours modelsDir ; le dossier ne se règle que par la boîte native", async () => {
    const e = await env({ "m.gguf": SMALL });
    await failsWith(e.call("local-engine-configure", { modelsDir: "C:\\Windows" }), /champ|accept/i);
  });

  it("le cache d'analyse vit dans le dossier du profil, JAMAIS dans le dossier des modèles, et ne contient aucun octet d'en-tête", async () => {
    const f = barAFixtures();
    const e = await env({ "standard.gguf": f["standard.gguf"]!.bytes });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    await e.call("hf-fit", { repo: REPO, sha: view.sha, keys: ["standard.gguf"], contextTokens: 8192, cacheType: "f16" });
    const file = join(e.dataRoot, "profiles", "default", "hf-fit-cache.json");
    expect(existsSync(file)).toBe(true);
    expect(listAll(e.models)).toEqual([]);
    const json = JSON.parse(readFileSync(file, "utf8")) as { version: number; entries: unknown[] };
    expect([json.version, json.entries.length]).toEqual([1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- (5b-J)

describe("(5b-J) progression", () => {
  it("hf-progress au plus tous les 250 ms (horloge injectée), champs exacts, dernier événement « finalize »", async () => {
    let t = 0;
    const e = await env({ "big.gguf": BIG }, { fake: { chunk: 64 * 1024 }, wiring: { now: () => (t += 10) } });
    await e.chooseModels();
    const view = await e.call("hf-repo", { repo: REPO });
    await e.call("hf-download", { repo: REPO, sha: view.sha, keys: ["big.gguf"] });
    const events = e.on("hf-progress").map(([p]) => p as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(2);
    for (const p of events) expect(Object.keys(p).sort()).toEqual(["count", "file", "index", "received", "stage", "total"]);
    const downloads = events.filter((p) => p.stage === "download");
    expect(downloads.length).toBeLessThan(40); // sans cadence il y en aurait 64 (un par tranche) : 4 Mio / 64 Kio
    expect(downloads.at(-1)!.received).toBeLessThanOrEqual(BIG.length);
    expect(events.at(-1)!.stage).toBe("finalize");
    expect(events.every((p, i) => i === 0 || (p.received as number) >= 0)).toBe(true);
  });
});
