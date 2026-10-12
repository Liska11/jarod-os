import { describe, expect, it } from "vitest";
import {
  ChunkId,
  Code,
  DEFAULT_ECOSYSTEM_FLAGS,
  DEFAULT_SETTINGS,
  DecisionAnswer,
  type DecisionEngine,
  DecisionLogEntry,
  DecisionQuestion,
  DecisionResult,
  DocumentManifest,
  type DocumentParser,
  EcosystemFlags,
  type EmbeddingModelSpec,
  EmbeddingModelSpec as EmbeddingModelSpecSchema,
  type EmbeddingProvider,
  IndexCheckpoint,
  RerankerConfig,
  RerankShadowEntry,
  IndexHealth,
  IndexSpec,
  type RerankerProvider,
  type SparseVector,
  type VectorIndexProvider,
  ecosystemFlags,
  embeddingGeneration,
} from "../src/index.js";

const SHA = "a".repeat(64);
const BGE_M3: EmbeddingModelSpec = {
  model: "bge-m3-int8-ov", kind: "dense", dim: 1024, strategy: "symmetric", pooling: "cls", normalize: true, quantization: "int8", tokenizerSha256: null,
};
const ENGINE = { name: "memory", version: "1", device: "CPU" };

describe("écosystème — communs", () => {
  it("ChunkId : entier JSON sûr, jamais négatif ni fractionnaire", () => {
    for (const ok of [0, 1, Number.MAX_SAFE_INTEGER]) expect(ChunkId.safeParse(ok).success).toBe(true);
    for (const ko of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(ChunkId.safeParse(ko).success).toBe(false);
  });

  it("Code : identifiant machine — ni espace, ni phrase, 128 caractères au plus", () => {
    for (const ok of ["bge-m3-int8-ov", "GPU.0", "dim-mismatch", "a".repeat(128), "x@1.2+b/c:d_e"]) expect(Code.safeParse(ok).success).toBe(true);
    for (const ko of ["", "deux mots", "a".repeat(129), "-tiret-initial", "quelle heure est-il ?"]) expect(Code.safeParse(ko).success).toBe(false);
  });
});

describe("EmbeddingProvider", () => {
  it("génération déterministe ; chaque champ de la spécification la change", () => {
    const g = embeddingGeneration(BGE_M3);
    expect(embeddingGeneration({ ...BGE_M3 })).toBe(g);
    const variants: Partial<EmbeddingModelSpec>[] = [
      { model: "e5-large" }, { kind: "sparse", dim: null }, { dim: 768 }, { strategy: "query-passage" }, { pooling: "mean" },
      { normalize: false }, { quantization: "fp16" }, { tokenizerSha256: SHA },
    ];
    const seen = new Set([g]);
    for (const v of variants) seen.add(embeddingGeneration({ ...BGE_M3, ...v }));
    expect(seen.size).toBe(variants.length + 1);
  });

  it("spécification stricte : champ inconnu ou dimension invalide refusés", () => {
    expect(EmbeddingModelSpecSchema.safeParse({ ...BGE_M3, extra: 1 }).success).toBe(false);
    expect(EmbeddingModelSpecSchema.safeParse({ ...BGE_M3, dim: 0 }).success).toBe(false);
    expect(EmbeddingModelSpecSchema.safeParse({ ...BGE_M3, tokenizerSha256: "ABC" }).success).toBe(false);
    expect(() => embeddingGeneration({ ...BGE_M3, model: "nom avec espace" })).toThrow();
  });

  it("dense → Float32Array, creux → SparseVector (forme vérifiée à la compilation)", async () => {
    const dense: EmbeddingProvider = {
      kind: "dense", available: true, describe: () => BGE_M3, info: () => ENGINE,
      embed: async (texts) => texts.map(() => new Float32Array(1024)),
    };
    const sparse: EmbeddingProvider<"sparse"> = {
      kind: "sparse", available: true, describe: () => ({ ...BGE_M3, kind: "sparse", dim: null }), info: () => ENGINE,
      embed: async (texts) => texts.map((): SparseVector => ({ indices: new Uint32Array([3]), values: new Float32Array([0.5]) })),
    };
    expect((await dense.embed(["a", "b"], "query"))[1]).toHaveLength(1024);
    expect((await sparse.embed(["a"], "passage"))[0]!.indices[0]).toBe(3);
  });
});

describe("VectorIndexProvider", () => {
  it("IndexSpec porte la génération d'embeddings ; métrique fermée", () => {
    expect(IndexSpec.parse({ indexId: "rag-default", embedding: BGE_M3, metric: "cosine" }).embedding).toEqual(BGE_M3);
    expect(IndexSpec.safeParse({ indexId: "rag-default", embedding: BGE_M3, metric: "l2" }).success).toBe(false);
  });

  it("point de reprise et santé : nombres et codes, jamais de message libre", () => {
    expect(IndexCheckpoint.parse({ indexId: "i", generation: "g", size: 3, at: 1 })).toEqual({ indexId: "i", generation: "g", size: 3, at: 1 });
    expect(IndexCheckpoint.safeParse({ indexId: "i", generation: "", size: 3, at: 1 }).success).toBe(false);
    expect(IndexHealth.safeParse({ indexId: "i", ok: false, size: 0, generation: null, error: "corrupt" }).success).toBe(true);
    expect(IndexHealth.safeParse({ indexId: "i", ok: false, size: 0, generation: null, error: "index illisible sur disque" }).success).toBe(false);
  });

  it("interface : identifiants et vecteurs seulement (forme vérifiée à la compilation)", async () => {
    const cp = { indexId: "i", generation: embeddingGeneration(BGE_M3), size: 0, at: 0 };
    const idx: VectorIndexProvider = {
      kind: "memory", info: () => ENGINE, create: async () => {}, upsert: async () => {}, remove: async () => {},
      search: async (req) => (req.allow?.length === 0 ? [] : [{ id: 1, score: 0.9 }]),
      sync: async () => cp, verify: async () => ({ indexId: "i", ok: true, size: 0, generation: cp.generation }),
      rebuild: async () => cp, close: async () => {},
    };
    expect(await idx.search({ indexId: "i", vector: new Float32Array(2), k: 5, allow: [] })).toEqual([]);
    expect(IndexCheckpoint.parse(await idx.rebuild(IndexSpec.parse({ indexId: "i", embedding: BGE_M3, metric: "dot" }), []))).toEqual(cp);
  });
});

describe("RerankerProvider", () => {
  it("candidats déjà fusionnés, top-N et budget de latence (forme vérifiée à la compilation)", async () => {
    const rr: RerankerProvider = {
      available: true, maxCandidates: 32, info: () => ({ name: "bge-reranker-v2-m3", version: "int8", device: "NPU" }),
      rerank: async (req) => req.candidates.slice(0, req.topN).map((c, i) => ({ id: c.id, score: 1 - i / 10 })),
    };
    const hits = await rr.rerank({ query: "q", candidates: [{ id: 7, text: "a" }, { id: 9, text: "b" }], topN: 1, deadlineMs: 150 });
    expect(hits).toEqual([{ id: 7, score: 1 }]);
  });
});

describe("DocumentParser", () => {
  const manifest = {
    manifestVersion: 1, parser: { name: "builtin", version: "1" }, source: { sha256: SHA, bytes: 12, mime: "text/plain" },
    language: "fr", pages: null, sections: [{ start: 0, end: 5, page: null, level: 1, title: "Titre" }], tables: [], images: [],
    errors: [{ code: "ocr-absent", page: 2 }],
  };

  it("manifeste versionné et strict ; empreinte SHA-256 minuscule exigée", () => {
    expect(DocumentManifest.parse(manifest)).toEqual(manifest);
    expect(DocumentManifest.safeParse({ ...manifest, manifestVersion: 2 }).success).toBe(false);
    expect(DocumentManifest.safeParse({ ...manifest, source: { ...manifest.source, sha256: SHA.toUpperCase() } }).success).toBe(false);
    expect(DocumentManifest.safeParse({ ...manifest, text: "le texte n'a pas sa place dans le manifeste" }).success).toBe(false);
    expect(DocumentManifest.safeParse({ ...manifest, errors: [{ code: "page 3 illisible", page: 3 }] }).success).toBe(false);
  });

  it("interface : fichier ou octets en entrée (forme vérifiée à la compilation)", async () => {
    const p: DocumentParser = {
      available: true, info: () => ({ name: "builtin", version: "1" }), accepts: (name) => name.endsWith(".txt"),
      parse: async () => ({ manifest: DocumentManifest.parse(manifest), text: "Titre\n" }),
    };
    expect(p.accepts("a.txt")).toBe(true);
    expect((await p.parse({ bytes: new Uint8Array(1), name: "a.txt" })).manifest.parser.name).toBe("builtin");
  });
});

describe("DecisionEngine", () => {
  it("questions : choice ≥ 2 options, score ≥ 2 niveaux, noul ; forme inconnue refusée", () => {
    expect(DecisionQuestion.safeParse({ id: "intent", type: "choice", options: ["chat", "outil"], instructions: "i" }).success).toBe(true);
    expect(DecisionQuestion.safeParse({ id: "intent", type: "choice", options: ["chat"], instructions: "i" }).success).toBe(false);
    expect(DecisionQuestion.safeParse({ id: "urgence", type: "score", levels: 1, instructions: "i" }).success).toBe(false);
    expect(DecisionQuestion.safeParse({ id: "risque", type: "noul", instructions: "i" }).success).toBe(true);
    expect(DecisionQuestion.safeParse({ id: "x", type: "texte", instructions: "i" }).success).toBe(false);
  });

  it("réponses : abstention = null ; probabilités dans [0, 1]", () => {
    expect(DecisionAnswer.safeParse({ id: "intent", type: "choice", value: null, probabilities: [0.5, 0.5] }).success).toBe(true);
    expect(DecisionAnswer.safeParse({ id: "intent", type: "choice", value: "outil", probabilities: [1.2, 0] }).success).toBe(false);
    expect(DecisionAnswer.safeParse({ id: "risque", type: "noul", value: true, probability: 0.9 }).success).toBe(true);
    expect(DecisionAnswer.safeParse({ id: "risque", type: "noul", value: "oui", probability: 0.9 }).success).toBe(false);
  });

  it("le moteur rend des données, jamais une action (forme vérifiée à la compilation)", async () => {
    const de: DecisionEngine = {
      available: true, info: () => ({ name: "laya", version: "0" }),
      decide: async (req) => ({ answers: req.questions.map((q) => ({ id: q.id, type: "noul" as const, value: null, probability: 0 })), engine: { name: "laya", version: "0" }, ms: 1, timedOut: false }),
    };
    const r = await de.decide({ state: "s", questions: [{ id: "risque", type: "noul", instructions: "i" }], deadlineMs: 50 });
    expect(DecisionResult.parse(r)).toEqual(r);
    expect(DecisionResult.safeParse({ ...r, action: "run" }).success).toBe(false);
  });
});

describe("drapeaux par profil (réglage ecosystem)", () => {
  it("défaut = pile actuelle, tout éteint, aucun budget", () => {
    expect(DEFAULT_ECOSYSTEM_FLAGS).toEqual({
      vectorIndex: "memory", vectorShadow: null, documentParser: "builtin", sparseEmbeddings: "off", reranker: "off", rerankMode: "shadow", hybrid: "off",
      decisionEngine: "off", decisionMode: "shadow", decisionLog: true,
    });
    expect(DEFAULT_SETTINGS.ecosystem).toEqual(DEFAULT_ECOSYSTEM_FLAGS);
  });

  it("hybrid (SPECS-P5-HYBRID.md) : éteint par défaut, « on » explicite, toute autre valeur refusée puis ramenée au défaut", () => {
    expect(DEFAULT_ECOSYSTEM_FLAGS.hybrid).toBe("off");
    expect(EcosystemFlags.parse({ hybrid: "on" }).hybrid).toBe("on");
    expect(EcosystemFlags.safeParse({ hybrid: "oui" }).success).toBe(false);
    expect(ecosystemFlags({ hybrid: "oui" })).toEqual(DEFAULT_ECOSYSTEM_FLAGS);
    expect(ecosystemFlags({ hybrid: "on" }).hybrid).toBe("on");
  });

  it("lecture tolérante : valeur invalide ou inconnue → défauts, jamais une erreur", () => {
    for (const raw of [undefined, null, "x", 3, { vectorIndex: "faiss" }, { inconnu: true }, { rerankTopN: 0 }]) {
      expect(ecosystemFlags(raw)).toEqual(DEFAULT_ECOSYSTEM_FLAGS);
    }
    expect(ecosystemFlags({ vectorShadow: "turbovec" })).toEqual({ ...DEFAULT_ECOSYSTEM_FLAGS, vectorShadow: "turbovec" });
    expect(EcosystemFlags.parse({ reranker: "bge-reranker-v2-m3-npu", rerankTopN: 20, rerankDeadlineMs: 150 }).rerankTopN).toBe(20);
  });
});

describe("journal de décision", () => {
  const entry = { t: 1, profile: "default", stage: "reranker", engine: ENGINE, ms: 12.5, outcome: "fallback", reason: "deadline", counts: { candidates: 40 } };

  it("codes, nombres, booléens : entrée valide acceptée", () => {
    expect(DecisionLogEntry.parse(entry)).toEqual(entry);
    expect(DecisionLogEntry.safeParse({ ...entry, stage: "decision", decision: { question: "intent", value: null, confidence: 0.2 } }).success).toBe(true);
  });

  it("aucun texte libre : requête, message ou phrase refusés", () => {
    expect(DecisionLogEntry.safeParse({ ...entry, query: "quelle heure est-il" }).success).toBe(false);
    expect(DecisionLogEntry.safeParse({ ...entry, reason: "délai dépassé de 12 ms" }).success).toBe(false);
    expect(DecisionLogEntry.safeParse({ ...entry, generation: "bge m3" }).success).toBe(false);
    expect(DecisionLogEntry.safeParse({ ...entry, counts: { "mots de la requête": 3 } }).success).toBe(false);
    expect(DecisionLogEntry.safeParse({ ...entry, decision: { question: "intent", value: "réponse libre" } }).success).toBe(false);
    expect(DecisionLogEntry.safeParse({ ...entry, engine: { ...ENGINE, note: "x" } }).success).toBe(false);
  });
});

describe("reranker (SPECS-P5-RERANKER.md)", () => {
  it("rerankMode : fantôme par défaut, `active` explicite, autre valeur refusée", () => {
    expect(DEFAULT_ECOSYSTEM_FLAGS.rerankMode).toBe("shadow");
    expect(EcosystemFlags.parse({ rerankMode: "active" }).rerankMode).toBe("active");
    expect(EcosystemFlags.safeParse({ rerankMode: "on" }).success).toBe(false);
    expect(ecosystemFlags({ rerankMode: "on" })).toEqual(DEFAULT_ECOSYSTEM_FLAGS);
  });

  it("RerankerConfig : modelDir absolu, port fixe, lot entier, longueur 512 par défaut", () => {
    const ok = RerankerConfig.parse({ modelDir: "S:/m", port: 8930 });
    expect(ok).toMatchObject({ modelDir: "S:/m", port: 8930, batch: 8, maxLength: 512, devices: ["NPU", "GPU.0", "CPU"] });
    for (const bad of [{ modelDir: "S:/m" }, { port: 8930 }, { modelDir: "S:/m", port: 0 }, { modelDir: "S:/m", port: 70000 }, { modelDir: "S:/m", port: 8930, batch: 0 }, { modelDir: "S:/m", port: 8930, batch: 2.5 }, { modelDir: "S:/m", port: 8930, devices: [] }]) {
      expect(RerankerConfig.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("RerankShadowEntry : identifiants et nombres seulement, aucun texte, aucune clé inconnue", () => {
    const e = { t: 1, profile: "default", engine: ENGINE, ms: 1500.5, outcome: "ok", mode: "shadow", candidates: [4, 9, 2], reranked: [9, 2, 4] };
    expect(RerankShadowEntry.parse(e)).toEqual(e);
    expect(RerankShadowEntry.safeParse({ ...e, query: "texte" }).success).toBe(false);
    expect(RerankShadowEntry.safeParse({ ...e, candidates: ["a"] }).success).toBe(false);
    expect(RerankShadowEntry.safeParse({ ...e, outcome: "délai dépassé" }).success).toBe(false);
    expect(RerankShadowEntry.safeParse({ ...e, reranked: [1, 1.5] }).success).toBe(false);
    // repli : pas de classement, une raison en code
    expect(RerankShadowEntry.safeParse({ ...e, outcome: "timeout", reason: "deadline", reranked: [] }).success).toBe(true);
  });

  it("SPECS-P5-RERANKER-PAUSE.md : issues `paused` et `stale` du rapport, voicePriority (défaut true) de reranker.json", () => {
    const e = { t: 1, profile: "default", engine: ENGINE, ms: 0, outcome: "paused", mode: "shadow", reason: "RERANKER_PAUSED", candidates: [4, 9], reranked: [] };
    expect(RerankShadowEntry.safeParse(e).success).toBe(true);
    expect(RerankShadowEntry.safeParse({ ...e, outcome: "stale" }).success).toBe(true);
    expect(RerankerConfig.parse({ modelDir: "S:/m", port: 8930 }).voicePriority).toBe(true);
    expect(RerankerConfig.parse({ modelDir: "S:/m", port: 8930, voicePriority: false }).voicePriority).toBe(false);
    expect(RerankerConfig.safeParse({ modelDir: "S:/m", port: 8930, voicePriority: "non" }).success).toBe(false);
  });
});
