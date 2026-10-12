// Chantier 4 de SPECS-P5-MODELS.md : (4-D) lecteur de métadonnées de la fiche (`?blobs=true`, repli `tree` avec `lfs.oid` et curseur `Link`) et (4-E) regroupement des
// fragments `-00001-of-0000N.gguf`. Barres figées dans DECISIONS le 2026-10-03 AVANT ce code. Serveur factice local ; `guardedFetch` rend rouge tout accès réel.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { type HfRepoFile, entryDownloadFiles, groupGgufFiles } from "../src/hf-repo.js";
import { HuggingFaceService } from "../src/huggingface.js";
import { type FakeHf, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";

const REPO = "acme/tiny-GGUF";
const H = (c: string) => c.repeat(64);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const servers: FakeHf[] = [];
afterEach(async () => {
  await cleanup();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function start(options: Parameters<typeof startFakeHf>[0], deps: { token?: string } = {}) {
  const fake = await startFakeHf(options);
  servers.push(fake);
  const guarded = guardedFetch([fake.origin]);
  const service = new HuggingFaceService({ baseUrl: fake.origin, fetchImpl: guarded.fetch, journal: () => undefined, freeBytes: () => Number.MAX_SAFE_INTEGER, ...deps });
  return { fake, guarded, service };
}
async function failure(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("aucun rejet");
}

describe("(4-D) lecteur de métadonnées : la fiche avec blobs=true", () => {
  const fiche = {
    sha: SHA,
    gated: false,
    cardData: { license: "apache-2.0" },
    tags: ["gguf", "license:apache-2.0"],
    gguf: { total: 1, context_length: 987654, architecture: "qwen2" },
    siblings: [
      { rfilename: "README.md", size: 10 },
      { rfilename: "model-Q4_K_M.gguf", size: 491_400_032, lfs: { sha256: H("a"), size: 491_400_032, pointerSize: 134 } },
      { rfilename: "small.gguf", size: 500 },
      { rfilename: "../evil.gguf", size: 1 },
      { rfilename: "CON.gguf", size: 1 },
    ],
  };

  it("UNE requête, avec blobs=true ; tailles et SHA-256 de lfs.sha256 ; non-LFS ⇒ empreinte null ; noms hostiles écartés ; le résumé gguf n'apparaît nulle part", async () => {
    const { fake, service } = await start({ files: {}, models: { [REPO]: fiche } });
    const skipped: string[] = [];
    const info = await service.repoInfo(REPO, { onSkipped: (name) => skipped.push(String(name)) });
    expect(fake.log).toHaveLength(1);
    expect(fake.log[0]!.path).toBe(`/api/models/${REPO}`);
    expect(fake.log[0]!.search).toContain("blobs=true");
    expect(info).toMatchObject({ repo: REPO, sha: SHA, gated: false, license: "apache-2.0", truncated: false, source: "blobs" });
    expect(info.entries.map((e) => e.key)).toEqual(["model-Q4_K_M.gguf", "small.gguf"]);
    expect(info.entries[0]!.files).toEqual([{ name: "model-Q4_K_M.gguf", size: 491_400_032, sha256: H("a") }]);
    expect(info.entries[1]!.files).toEqual([{ name: "small.gguf", size: 500, sha256: null }]);
    expect(skipped.sort()).toEqual(["../evil.gguf", "CON.gguf"]);
    // (g) : le verdict ne vient jamais de la fiche — son résumé `gguf` ne figure pas dans le résultat
    expect(JSON.stringify(info)).not.toContain("987654");
    expect(JSON.stringify(info)).not.toContain("qwen2");
  });

  it("gated : false, « manual » et toute valeur non fausse ; licence de cardData puis de l'étiquette", async () => {
    const cases: [unknown, false | string][] = [
      [false, false],
      [undefined, false],
      ["manual", "manual"],
      ["auto", "auto"],
      [true, "true"],
    ];
    for (const [gated, expected] of cases) {
      const { service } = await start({ files: {}, models: { [REPO]: { ...fiche, gated } } });
      expect((await service.repoInfo(REPO)).gated, String(gated)).toBe(expected);
    }
    const { service } = await start({ files: {}, models: { [REPO]: { sha: SHA, tags: ["gguf", "license:llama3.2"], siblings: [] } } });
    expect((await service.repoInfo(REPO)).license).toBe("llama3.2");
    const none = await start({ files: {}, models: { [REPO]: { sha: SHA, siblings: [] } } });
    expect((await none.service.repoInfo(REPO)).license).toBeNull();
  });

  it("réponses inexploitables : sha illisible, siblings absents, corps non JSON ⇒ BAD_RESPONSE ; > 5 Mio ⇒ TOO_LARGE ; 404 ⇒ HUGGINGFACE_FAILED", async () => {
    for (const model of [
      { sha: "main", siblings: [] },
      { sha: SHA.toUpperCase(), siblings: [] },
      { siblings: [] },
      { sha: SHA, siblings: "non" as unknown as unknown[] },
      { sha: SHA, siblings: [], raw: "ceci n'est pas du JSON" },
      { sha: SHA, siblings: [], raw: "null" },
    ]) {
      const { service } = await start({ files: {}, models: { [REPO]: model } });
      expect((await failure(service.repoInfo(REPO))).code, JSON.stringify(model)).toBe("BAD_RESPONSE");
    }
    const huge = await start({ files: {}, models: { [REPO]: { sha: SHA, siblings: [], raw: `[${"1,".repeat(2_800_000)}1]` } } });
    expect((await failure(huge.service.repoInfo(REPO))).code).toBe("TOO_LARGE");
    const missing = await start({ files: {} });
    const notFound = await failure(missing.service.repoInfo(REPO));
    expect(notFound.code).toBe("HTTP");
    expect(notFound.message).toMatch(/HUGGINGFACE_FAILED/);
  });

  it("le jeton part à l'hôte de base ; un identifiant de dépôt piégé n'envoie rien", async () => {
    const { fake, service } = await start({ files: {}, models: { [REPO]: fiche } }, { token: "T0KEN" });
    await service.repoInfo(REPO);
    expect(fake.log[0]!.authorization).toBe("Bearer T0KEN");
    fake.log.length = 0;
    expect((await failure(service.repoInfo("../x"))).code).toBe("INVALID_REPO");
    expect(fake.log).toHaveLength(0);
  });
});

describe("(4-D) repli tree : révision ÉPINGLÉE, pagination par l'en-tête Link, lfs.oid", () => {
  const entry = (path: string, size: number, oid?: string) => ({ type: "file", oid: "gitoid", size, path, ...(oid ? { lfs: { oid, size, pointerSize: 134 } } : {}) });
  const tree = [entry("README.md", 10), { type: "directory", path: "BF16" }, entry("a.gguf", 1000, H("1")), entry("BF16/b.gguf", 2000, H("2")), entry("c.gguf", 300), entry("d.gguf", 4000, H("4")), entry("../e.gguf", 5, H("5"))];
  const fiche = { sha: SHA, siblings: ["a.gguf", "BF16/b.gguf", "c.gguf", "d.gguf"].map((rfilename) => ({ rfilename })) }; // blobs sans taille ⇒ repli

  it("une taille manque ⇒ tree/<sha>?recursive=true, 3 pages suivies par Link, lfs.oid pris comme SHA-256, jamais tree/main", async () => {
    const { fake, service } = await start({ files: {}, models: { [REPO]: { ...fiche, tree, pageSize: 3 } } });
    const skipped: string[] = [];
    const info = await service.repoInfo(REPO, { onSkipped: (name) => skipped.push(String(name)) });
    expect(info.source).toBe("tree");
    expect(info.entries.map((e) => e.files[0])).toEqual([
      { name: "BF16/b.gguf", size: 2000, sha256: H("2") },
      { name: "a.gguf", size: 1000, sha256: H("1") },
      { name: "c.gguf", size: 300, sha256: null },
      { name: "d.gguf", size: 4000, sha256: H("4") },
    ]);
    expect(skipped).toEqual(["../e.gguf"]);
    const treeCalls = fake.log.filter((l) => l.path.includes("/tree/"));
    expect(treeCalls).toHaveLength(3);
    expect(treeCalls.every((l) => l.path === `/api/models/${REPO}/tree/${SHA}`)).toBe(true);
    expect(treeCalls[0]!.search).toContain("recursive=true");
    expect(treeCalls[1]!.search).toContain("cursor=3");
    expect(fake.log.some((l) => l.path.includes("/tree/main"))).toBe(false);
    expect(fake.log).toHaveLength(4); // la fiche + 3 pages
  });

  it("un Link vers un hôte interdit est REFUSÉ, jamais suivi", async () => {
    const { fake, guarded, service } = await start({ files: {}, models: { [REPO]: { ...fiche, tree, pageSize: 2, linkHost: "https://evil.example" } } });
    const error = await failure(service.repoInfo(REPO));
    expect(error.code).toBe("HOST_REFUSED");
    expect(guarded.calls.every((u) => u.startsWith(fake.origin))).toBe(true);
    expect(fake.log.filter((l) => l.path.includes("/tree/"))).toHaveLength(1);
  });

  it("plus de 20 pages ⇒ arrêt (TOO_MANY_PAGES), 20 requêtes tree au plus", async () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`f${i}.gguf`, 10 + i, H("7")));
    const { fake, service } = await start({ files: {}, models: { [REPO]: { sha: SHA, siblings: [{ rfilename: "f0.gguf" }], tree: many, pageSize: 1 } } });
    const error = await failure(service.repoInfo(REPO));
    expect(error.code).toBe("TOO_MANY_PAGES");
    expect(fake.log.filter((l) => l.path.includes("/tree/"))).toHaveLength(20);
  });

  it("une entrée tree sans taille est écartée avec sa raison", async () => {
    const odd = [{ type: "file", path: "x.gguf" }, entry("y.gguf", 8, H("8"))];
    const { service } = await start({ files: {}, models: { [REPO]: { sha: SHA, siblings: [{ rfilename: "x.gguf" }], tree: odd } } });
    const skipped: [string, string][] = [];
    const info = await service.repoInfo(REPO, { onSkipped: (name, reason) => skipped.push([String(name), reason]) });
    expect(info.entries.map((e) => e.key)).toEqual(["y.gguf"]);
    expect(skipped[0]![0]).toBe("x.gguf");
    expect(skipped[0]![1]).toMatch(/taille/);
  });
});

describe("(4-E) regroupement des fragments", () => {
  const f = (name: string, size = 100): HfRepoFile => ({ name, size, sha256: H("c") });
  const shards = (prefix: string, n: number, over = (i: number) => 100 * i) => Array.from({ length: n }, (_, i) => f(`${prefix}-${String(i + 1).padStart(5, "0")}-of-${String(n).padStart(5, "0")}.gguf`, over(i + 1)));

  it("3 fragments ⇒ UNE entrée : somme des tailles, fichiers ordonnés, complète", () => {
    const { entries } = groupGgufFiles([...shards("m", 3)].reverse());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ complete: true, missing: [], shardCount: 3, totalBytes: 600 });
    expect(entries[0]!.files.map((x) => x.name)).toEqual(["m-00001-of-00003.gguf", "m-00002-of-00003.gguf", "m-00003-of-00003.gguf"]);
  });

  it("deux jeux et un modèle simple dans des sous-dossiers ⇒ 3 entrées, jamais fusionnées d'un dossier à l'autre", () => {
    const { entries } = groupGgufFiles([...shards("Q8_0/m", 2), ...shards("BF16/m", 2), f("single.GGUF")]);
    expect(entries.map((e) => e.key)).toEqual(["BF16/m-of-00002", "Q8_0/m-of-00002", "single.GGUF"]);
    expect(entries.map((e) => e.files.length)).toEqual([2, 2, 1]);
  });

  it("un fragment manquant ⇒ incomplète, le dit ; entryDownloadFiles rejette (INCOMPLETE_SET)", () => {
    const set = shards("m", 3).filter((x) => !x.name.includes("00002"));
    const { entries } = groupGgufFiles(set);
    expect(entries[0]).toMatchObject({ complete: false, missing: [2], totalBytes: 400 });
    expect(() => entryDownloadFiles(entries[0]!)).toThrow(/INCOMPLETE_SET/);
  });

  it("des totaux différents ne se fusionnent jamais ; un indice 00000 ou au-delà du total est un fichier simple", () => {
    const { entries } = groupGgufFiles([...shards("m", 3), ...shards("m", 5), f("x-00000-of-00003.gguf"), f("y-00004-of-00003.gguf")]);
    expect(entries.map((e) => e.key)).toEqual(["m-of-00003", "m-of-00005", "x-00000-of-00003.gguf", "y-00004-of-00003.gguf"]);
    expect(entries.map((e) => e.files.length)).toEqual([3, 5, 1, 1]);
    expect(entries[2]!.shardCount).toBeNull();
  });

  it("le plafond de 500 compte des ENTRÉES : 600 fichiers simples ⇒ 500 + tronqué ; 300 jeux de 2 fragments ⇒ 300, non tronqué", () => {
    const plain = groupGgufFiles(Array.from({ length: 600 }, (_, i) => f(`m${String(i).padStart(4, "0")}.gguf`)));
    expect(plain.entries).toHaveLength(500);
    expect(plain.truncated).toBe(true);
    const sets = groupGgufFiles(Array.from({ length: 300 }, (_, i) => shards(`s${String(i).padStart(3, "0")}`, 2)).flat());
    expect(sets.entries).toHaveLength(300);
    expect(sets.truncated).toBe(false);
  });

  it("l'ordre ne dépend pas de l'ordre d'entrée", () => {
    const input = [...shards("b", 2), f("a.gguf"), ...shards("c", 3)];
    const a = groupGgufFiles(input).entries.map((e) => e.key);
    const b = groupGgufFiles([...input].reverse()).entries.map((e) => e.key);
    expect(a).toEqual(b);
    expect(a).toEqual(["a.gguf", "b-of-00002", "c-of-00003"]);
  });

  it("downloadEntry d'un jeu complet : N fichiers téléchargés, vérifiés, renommés", async () => {
    const parts = [0, 1, 2].map((i) => Buffer.alloc(20_000 + i * 500, i + 1));
    const names = parts.map((_, i) => `m-0000${i + 1}-of-00003.gguf`);
    const model = { sha: SHA, siblings: names.map((rfilename, i) => ({ rfilename, size: parts[i]!.length, lfs: { sha256: sha256(parts[i]!), size: parts[i]!.length, pointerSize: 134 } })) };
    const { fake, service } = await start({ files: Object.fromEntries(names.map((n, i) => [n, parts[i]!])), models: { [REPO]: model } });
    const info = await service.repoInfo(REPO);
    expect(info.entries).toHaveLength(1);
    const dest = tempDir();
    const done = await service.downloadEntry({ repo: REPO, revision: info.sha, entry: info.entries[0]!, destDir: dest });
    expect(done.map((d) => d.verified)).toEqual(["sha256", "sha256", "sha256"]);
    expect(readdirSync(dest).sort()).toEqual(names);
    expect(fake.log.filter((l) => l.path.includes("/resolve/")).every((l) => l.path.includes(`/resolve/${SHA}/`))).toBe(true);
  });

  it("downloadEntry d'un jeu incomplet : rejet AVANT toute requête, rien d'écrit", async () => {
    const { fake, service } = await start({ files: {} });
    const { entries } = groupGgufFiles(shards("m", 3).filter((x) => !x.name.includes("m-00003-of")));
    const dest = join(tempDir(), "jamais");
    const error = await failure(service.downloadEntry({ repo: REPO, revision: SHA, entry: entries[0]!, destDir: dest }));
    expect(error.code).toBe("INCOMPLETE_SET");
    expect(fake.log).toHaveLength(0);
    expect(existsSync(dest)).toBe(false);
  });
});
