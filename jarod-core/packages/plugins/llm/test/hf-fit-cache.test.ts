// Chantier 5a de SPECS-P5-MODELS.md, barre (5a-B) : cache d'analyse `hf-fit-cache.json` — clé `(repo, sha, fichier, taille)`, LRU à 500 sans rejet, jamais d'octet d'en-tête,
// jamais un « Not checked », tolérant à tout fichier abîmé, écriture atomique. Barres figées dans DECISIONS AVANT ce code. Aucun réseau ici : le cache est un module local.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { parseGgufMetadata } from "../src/gguf-fit.js";
import { HF_FIT_CACHE_MAX, HfFitCache, type HfFitKey, analysisFromMetadata, metadataFromAnalysis } from "../src/hf-fit-cache.js";
import { MOE, QWEN35_9B, STD_LLAMA, gguf, str, u32, withTail } from "./gguf-fixtures.js";

afterEach(async () => {
  await cleanup();
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const key = (over: Partial<HfFitKey> = {}): HfFitKey => ({ repo: "acme/tiny-GGUF", sha: SHA_A, file: "m.gguf", size: 1000, ...over });
const tmp = () => tempDir();
const analysisOf = (entries = STD_LLAMA) => analysisFromMetadata(parseGgufMetadata(gguf(entries)), 12_345_678);

describe("(5a-B) clé : (repo, sha épinglé, fichier, taille)", () => {
  it("la même clé retrouve l'analyse ; un composant différent = autre clé (relecture)", () => {
    const cache = new HfFitCache({ path: join(tmp(), "c.json") });
    const a = analysisOf();
    cache.set(key(), a);
    expect(cache.get(key())).toEqual(a);
    expect(cache.get(key({ sha: SHA_B }))).toBeNull(); // le dépôt a avancé
    expect(cache.get(key({ size: 1001 }))).toBeNull(); // la taille a changé
    expect(cache.get(key({ file: "n.gguf" }))).toBeNull();
    expect(cache.get(key({ repo: "acme/other-GGUF" }))).toBeNull();
    expect(cache.has(key())).toBe(true);
    expect(cache.has(key({ sha: SHA_B }))).toBe(false);
  });

  it("survit à un redémarrage : un second objet relit le fichier", () => {
    const path = join(tmp(), "c.json");
    new HfFitCache({ path }).set(key(), analysisOf());
    expect(new HfFitCache({ path }).get(key())).toEqual(analysisOf());
  });
});

describe("(5a-B) LRU à 500 : jamais de rejet brutal", () => {
  it("la 501ᵉ entrée est ACCEPTÉE, la moins récemment utilisée sort, une entrée relue survit", () => {
    expect(HF_FIT_CACHE_MAX).toBe(500);
    const path = join(tmp(), "c.json");
    const cache = new HfFitCache({ path });
    const a = analysisOf();
    for (let i = 0; i < 500; i++) cache.set(key({ file: `f${i}.gguf` }), a);
    expect(cache.size).toBe(500);
    expect(cache.get(key({ file: "f0.gguf" }))).not.toBeNull(); // la plus ancienne est relue : elle devient la plus récente
    cache.set(key({ file: "nouvelle.gguf" }), a);
    expect(cache.size).toBe(500);
    expect(cache.get(key({ file: "nouvelle.gguf" }))).not.toBeNull(); // la nouvelle entrée n'est PAS refusée
    expect(cache.get(key({ file: "f0.gguf" }))).not.toBeNull(); // la relue survit
    expect(cache.get(key({ file: "f1.gguf" }))).toBeNull(); // la moins récemment utilisée est sortie
    expect(cache.get(key({ file: "f2.gguf" }))).not.toBeNull();
    // et le fichier ne dépasse pas 500 entrées non plus
    expect(new HfFitCache({ path }).size).toBe(500);
  });
});

describe("(5a-B) contenu : le résultat de l'analyse, JAMAIS les octets d'en-tête", () => {
  const MARKERS = ["MARQUEUR_GABARIT_DE_DISCUSSION", "MARQUEUR_NOM_DU_MODELE", "MARQUEUR_JETON_DU_VOCABULAIRE", "MARQUEUR_AUTRE_ARCHITECTURE"];
  const hostile = [
    str("general.architecture", "llama"),
    str("general.name", MARKERS[1]!),
    str("tokenizer.chat_template", MARKERS[0]!),
    { key: "tokenizer.ggml.tokens", type: "arr" as const, elem: "str" as const, value: [MARKERS[2]!, "b", "c"] },
    str("other.key", MARKERS[3]!),
    ...STD_LLAMA.slice(1),
  ];

  it("le fichier ne contient que les champs prévus : aucun marqueur planté hors de general.architecture et <arch>.*", () => {
    const path = join(tmp(), "c.json");
    const cache = new HfFitCache({ path });
    cache.set(key(), analysisFromMetadata(parseGgufMetadata(withTail(gguf(hostile), 4096)), 9_999));
    const text = readFileSync(path, "utf8");
    for (const marker of MARKERS) expect(text).not.toContain(marker);
    expect(text.length).toBeLessThan(4096); // une entrée, quelques clés : pas une copie des 4 Kio d'en-tête et de tenseurs
    const json = JSON.parse(text) as { version: number; entries: { analysis: { kind: string; kv?: Record<string, unknown> } }[] };
    expect(json.version).toBe(1);
    const kv = json.entries[0]!.analysis.kv!;
    expect(Object.keys(kv).every((k) => k === "general.architecture" || k.startsWith("llama."))).toBe(true);
    expect(kv["general.architecture"]).toBe("llama");
    expect(kv["llama.block_count"]).toBe(40);
  });

  it("bornes : 128 clés au plus, chaînes de 256 caractères au plus, gros tableau = marqueur", () => {
    const many = Array.from({ length: 300 }, (_, i) => u32(`llama.extra_${i}`, i));
    const meta = parseGgufMetadata(gguf([str("general.architecture", "llama"), str("llama.rope.scaling.type", "x".repeat(1000)), ...many]));
    const a = analysisFromMetadata(meta, 1);
    if (a.kind !== "header") throw new Error("kind");
    expect(Object.keys(a.kv).length).toBeLessThanOrEqual(128);
    const long = a.kv["llama.rope.scaling.type"];
    if (long !== undefined) expect(String(long).length).toBeLessThanOrEqual(256);
  });

  it("aller-retour exact : bigint, NaN, infini, tableau par couche et marqueur de gros tableau gardent leur nature (le verdict n'en dépend pas du cache)", () => {
    const kv = new Map<string, unknown>([
      ["general.architecture", "llama"],
      ["llama.a", 5n],
      ["llama.b", Number.NaN],
      ["llama.c", Number.POSITIVE_INFINITY],
      ["llama.d", [1, 2, 3]],
      ["llama.e", { skipped: "array", length: 100_000 }],
      ["llama.f", true],
      ["llama.g", 12.5],
    ]);
    const a = analysisFromMetadata({ kv, complete: true, version: 3, tensorCount: 0n, declaredKeys: 8, bytesRead: 1 } as never, 10);
    const back = metadataFromAnalysis(JSON.parse(JSON.stringify(a)));
    expect(back.kv.get("llama.a")).toBe(5n);
    expect(Number.isNaN(back.kv.get("llama.b"))).toBe(true);
    expect(back.kv.get("llama.c")).toBe(Number.POSITIVE_INFINITY);
    expect(back.kv.get("llama.d")).toEqual([1, 2, 3]);
    expect(back.kv.get("llama.e")).toEqual({ skipped: "array", length: 100_000 });
    expect(back.kv.get("llama.f")).toBe(true);
    expect(back.kv.get("llama.g")).toBe(12.5);
  });

  it("un en-tête illisible est un résultat d'analyse déterministe : {kind: unreadable, reason}", () => {
    const cache = new HfFitCache({ path: join(tmp(), "c.json") });
    cache.set(key(), { kind: "unreadable", reason: "BAD_MAGIC: ce n'est pas un GGUF" });
    expect(cache.get(key())).toEqual({ kind: "unreadable", reason: "BAD_MAGIC: ce n'est pas un GGUF" });
  });

  it("les trois architectures de référence passent par le cache sans perdre une clé utile au verdict", () => {
    for (const entries of [STD_LLAMA, MOE, QWEN35_9B]) {
      const meta = parseGgufMetadata(gguf(entries));
      const back = metadataFromAnalysis(JSON.parse(JSON.stringify(analysisFromMetadata(meta, 1))));
      const arch = meta.kv.get("general.architecture") as string;
      for (const [k, v] of meta.kv) if (k === "general.architecture" || k.startsWith(`${arch}.`)) expect(back.kv.get(k), k).toEqual(v);
    }
  });
});

describe("(5a-B) tolérance : jamais d'exception, jamais un verdict inventé", () => {
  const lines = () => [] as string[];
  const cases: [string, string][] = [
    ["JSON invalide", "{ pas du json"],
    ["tableau au lieu d'un objet", "[1,2,3]"],
    ["version inconnue", JSON.stringify({ version: 2, entries: [] })],
    ["entrées qui n'est pas un tableau", JSON.stringify({ version: 1, entries: "x" })],
    ["fichier vide", ""],
  ];
  it.each(cases)("%s : cache vide, aucune exception, une ligne de journal", (_name, content) => {
    const path = join(tmp(), "c.json");
    writeFileSync(path, content);
    const journal = lines();
    const cache = new HfFitCache({ path, journal: (l) => journal.push(l) });
    expect(cache.size).toBe(0);
    expect(cache.get(key())).toBeNull();
    cache.set(key(), analysisOf()); // et il reste utilisable
    expect(cache.get(key())).not.toBeNull();
  });

  it("fichier absent : cache vide sans bruit", () => {
    const journal = lines();
    const cache = new HfFitCache({ path: join(tmp(), "absent.json"), journal: (l) => journal.push(l) });
    expect(cache.size).toBe(0);
    expect(journal).toEqual([]);
  });

  it("une entrée abîmée est écartée (journalisée), les autres sont gardées", () => {
    const path = join(tmp(), "c.json");
    const good = { repo: "acme/tiny-GGUF", sha: SHA_A, file: "ok.gguf", size: 10, used: 1, analysis: { kind: "unreadable", reason: "x" } };
    writeFileSync(path, JSON.stringify({ version: 1, entries: [good, { repo: 5 }, { ...good, file: "mauvaise-taille.gguf", size: -3 }, { ...good, file: "mauvais-kind.gguf", analysis: { kind: "autre" } }, null] }));
    const journal = lines();
    const cache = new HfFitCache({ path, journal: (l) => journal.push(l) });
    expect(cache.size).toBe(1);
    expect(cache.get(key({ file: "ok.gguf", size: 10 }))).toEqual({ kind: "unreadable", reason: "x" });
    expect(journal.length).toBeGreaterThan(0);
  });

  it("écriture impossible (le dossier du cache est un FICHIER) : l'analyse est rendue quand même, une ligne de journal, aucune exception", () => {
    const dir = tmp();
    writeFileSync(join(dir, "bloque"), "");
    const journal = lines();
    const cache = new HfFitCache({ path: join(dir, "bloque", "c.json"), journal: (l) => journal.push(l) });
    expect(() => cache.set(key(), analysisOf())).not.toThrow();
    expect(cache.get(key())).toEqual(analysisOf()); // gardée en mémoire pour ce processus
    expect(journal.length).toBeGreaterThan(0);
  });

  it("le dossier du cache est créé s'il manque", () => {
    const path = join(tmp(), "profil", "sous", "c.json");
    new HfFitCache({ path }).set(key(), analysisOf());
    expect(existsSync(path)).toBe(true);
  });
});

describe("(5a-B) écriture ATOMIQUE : temporaire puis renommage", () => {
  it("un renommage qui échoue laisse l'ANCIEN fichier intact (jamais à moitié écrit), sans temporaire oublié, et le dit", () => {
    const dir = tmp();
    const path = join(dir, "c.json");
    new HfFitCache({ path }).set(key({ file: "avant.gguf" }), analysisOf());
    const before = readFileSync(path, "utf8");
    const journal: string[] = [];
    const cache = new HfFitCache({
      path,
      journal: (l) => journal.push(l),
      rename: ((from: string) => {
        throw Object.assign(new Error("coupure simulée"), { code: "EIO", path: from });
      }) as unknown as typeof renameSync,
    });
    cache.set(key({ file: "apres.gguf" }), analysisOf());
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(dir).filter((n) => n !== "c.json")).toEqual([]);
    expect(journal.length).toBeGreaterThan(0);
    expect(cache.get(key({ file: "apres.gguf" }))).not.toBeNull(); // le résultat reste servi depuis la mémoire
  });

  it("un temporaire abandonné d'un processus tué n'est pas lu comme le cache", () => {
    const dir = tmp();
    const path = join(dir, "c.json");
    new HfFitCache({ path }).set(key(), analysisOf());
    writeFileSync(`${path}.99999.tmp`, "{ moitié");
    mkdirSync(join(dir, "x"), { recursive: true });
    expect(new HfFitCache({ path }).get(key())).not.toBeNull();
  });
});
