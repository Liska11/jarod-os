// R1 (SPECS-P5-GGUF-FIT.md) : analyseur d'en-tête GGUF et estimation mémoire. FIXTURES D'EN-TÊTE SEULEMENT (décision du 2026-10-03, Q-FIT2) :
// aucun fichier de modèle réel, aucun GPU. Les valeurs des fixtures reprennent celles lues le 2026-10-02 sur deux en-têtes locaux (Qwen3.5 9B).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  GgufError,
  KV_BYTES_PER_ELEMENT,
  PROVISIONAL_COMPUTE_HEADROOM_BYTES,
  estimateGgufFile,
  estimateGgufMemory,
  maxContextThatFits,
  parseGgufMetadata,
  readGgufFile,
  reportGgufFit,
  renderFit,
} from "../src/gguf-fit.js";

// ---------------------------------------------------------------------------------------------------- constructeur d'en-têtes

type Entry =
  | { key: string; type: "u32" | "i32" | "u64" | "i64" | "f32" | "u8"; value: number | bigint }
  | { key: string; type: "bool"; value: boolean }
  | { key: string; type: "str"; value: string }
  | { key: string; type: "arr"; elem: "u32" | "str" | "f32"; value: (number | string)[] };

const TYPE_ID = { u8: 0, i32: 5, u32: 4, f32: 6, bool: 7, str: 8, arr: 9, u64: 10, i64: 11 } as const;

class W {
  parts: number[] = [];
  u8(n: number) {
    this.parts.push(n & 0xff);
  }
  u32(n: number) {
    for (let i = 0; i < 4; i++) this.parts.push((n >>> (8 * i)) & 0xff);
  }
  u64(n: bigint | number) {
    let v = BigInt(n);
    for (let i = 0; i < 8; i++) {
      this.parts.push(Number(v & 0xffn));
      v >>= 8n;
    }
  }
  f32(n: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, n, true);
    for (let i = 0; i < 4; i++) this.parts.push(b.getUint8(i));
  }
  str(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.u64(bytes.length);
    for (const b of bytes) this.parts.push(b);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function writeScalar(w: W, type: "u32" | "i32" | "u64" | "i64" | "f32" | "u8", value: number | bigint) {
  if (type === "u32" || type === "i32") w.u32(Number(value) >>> 0);
  else if (type === "u64" || type === "i64") w.u64(typeof value === "bigint" ? BigInt.asUintN(64, value) : BigInt(value));
  else if (type === "f32") w.f32(Number(value));
  else w.u8(Number(value));
}

function gguf(entries: Entry[], over: { version?: number; declared?: number | bigint } = {}): Uint8Array {
  const w = new W();
  for (const c of "GGUF") w.u8(c.charCodeAt(0));
  w.u32(over.version ?? 3);
  w.u64(0); // nombre de tenseurs
  w.u64(over.declared ?? entries.length);
  for (const e of entries) {
    w.str(e.key);
    w.u32(TYPE_ID[e.type]);
    if (e.type === "str") w.str(e.value);
    else if (e.type === "bool") w.u8(e.value ? 1 : 0);
    else if (e.type === "arr") {
      w.u32(TYPE_ID[e.elem]);
      w.u64(e.value.length);
      for (const v of e.value) {
        if (e.elem === "str") w.str(String(v));
        else if (e.elem === "f32") w.f32(Number(v));
        else w.u32(Number(v));
      }
    } else writeScalar(w, e.type, e.value);
  }
  return w.bytes();
}

const u32 = (key: string, value: number): Entry => ({ key, type: "u32", value });
const str = (key: string, value: string): Entry => ({ key, type: "str", value });

/** En-tête de Qwen3.5 9B (valeurs lues le 2026-10-02) + un faux vocabulaire de 200 chaînes + un petit tableau gardé. */
const QWEN35_9B: Entry[] = [
  str("general.architecture", "qwen35"),
  str("general.name", "Qwen3.5 9B"),
  u32("qwen35.block_count", 32),
  u32("qwen35.context_length", 262144),
  u32("qwen35.embedding_length", 4096),
  u32("qwen35.attention.head_count", 16),
  u32("qwen35.attention.head_count_kv", 4),
  u32("qwen35.attention.key_length", 256),
  u32("qwen35.attention.value_length", 256),
  { key: "qwen35.rope.dimension_sections", type: "arr", elem: "u32", value: [11, 11, 10, 0] },
  u32("qwen35.ssm.conv_kernel", 4),
  u32("qwen35.ssm.state_size", 128),
  u32("qwen35.ssm.group_count", 16),
  u32("qwen35.ssm.time_step_rank", 32),
  u32("qwen35.ssm.inner_size", 4096),
  u32("qwen35.full_attention_interval", 4),
  { key: "tokenizer.ggml.tokens", type: "arr", elem: "str", value: Array.from({ length: 200 }, (_, i) => `tok${i}`) },
];

/** Architecture standard à têtes groupées : 40 couches, 40 têtes, 8 têtes KV, dimension 5120/40 = 128 (clés de longueur absentes). */
const STD_LLAMA: Entry[] = [
  str("general.architecture", "llama"),
  u32("llama.block_count", 40),
  u32("llama.context_length", 131072),
  u32("llama.embedding_length", 5120),
  u32("llama.attention.head_count", 40),
  u32("llama.attention.head_count_kv", 8),
];

const GIB = 1024 ** 3;
const FILE_9B = 10_480_000_000;
const withEntries = (base: Entry[], drop: string[] = [], add: Entry[] = []): Entry[] => [...base.filter((e) => !drop.includes(e.key)), ...add];
const meta = (entries: Entry[]) => parseGgufMetadata(gguf(entries));

// ---------------------------------------------------------------------------------------------------- analyseur

describe("parseGgufMetadata — lecture", () => {
  it("lit les clés, garde les petits tableaux, saute les gros sans les garder", () => {
    const m = meta(QWEN35_9B);
    expect(m.version).toBe(3);
    expect(m.complete).toBe(true);
    expect(m.declaredKeys).toBe(QWEN35_9B.length);
    expect(m.kv.get("general.architecture")).toBe("qwen35");
    expect(m.kv.get("qwen35.block_count")).toBe(32);
    expect(m.kv.get("qwen35.rope.dimension_sections")).toEqual([11, 11, 10, 0]);
    expect(m.kv.get("tokenizer.ggml.tokens")).toEqual({ skipped: "array", length: 200 });
  });

  it("types scalaires : flottant, booléen, octet, entiers 64 bits sûrs en nombre et dangereux en bigint", () => {
    const m = meta([
      { key: "a.f", type: "f32", value: 0.5 },
      { key: "a.b", type: "bool", value: true },
      { key: "a.u8", type: "u8", value: 200 },
      { key: "a.safe", type: "u64", value: 12345n },
      { key: "a.huge", type: "u64", value: 2n ** 63n },
      { key: "a.neg", type: "i64", value: -5n },
    ]);
    expect(m.kv.get("a.f")).toBe(0.5);
    expect(m.kv.get("a.b")).toBe(true);
    expect(m.kv.get("a.u8")).toBe(200);
    expect(m.kv.get("a.safe")).toBe(12345);
    expect(m.kv.get("a.huge")).toBe(2n ** 63n);
    expect(typeof m.kv.get("a.neg")).not.toBe("string");
  });

  it("une fenêtre TRONQUÉE au milieu des métadonnées rend les paires entières déjà lues, complete = false, bytesRead à la fin de la dernière entière", () => {
    const full = gguf(QWEN35_9B);
    const upTo = gguf(QWEN35_9B.slice(0, 4)).byteLength; // octets des 4 premières paires
    for (const cut of [upTo + 1, upTo + 7, upTo + 20]) {
      const m = parseGgufMetadata(full.subarray(0, cut));
      expect(m.complete).toBe(false);
      expect([...m.kv.keys()]).toEqual(QWEN35_9B.slice(0, 4).map((e) => e.key));
      expect(m.bytesRead).toBe(upTo);
    }
  });

  it("zéro paire : en-tête valide, complet", () => {
    expect(meta([]).kv.size).toBe(0);
    expect(meta([]).complete).toBe(true);
  });
});

describe("parseGgufMetadata — fichiers invalides ou hostiles : erreurs typées, jamais de boucle", () => {
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return e instanceof GgufError ? e.code : `AUTRE:${(e as Error).message}`;
    }
    return "AUCUNE";
  };

  it("magie fausse, fichier vide, moins de 4 octets", () => {
    expect(code(() => parseGgufMetadata(new Uint8Array(0)))).toBe("BAD_MAGIC");
    expect(code(() => parseGgufMetadata(Uint8Array.of(0x47, 0x47)))).toBe("BAD_MAGIC");
    expect(code(() => parseGgufMetadata(new TextEncoder().encode("PK\u0003\u0004 pas un gguf, du tout")))).toBe("BAD_MAGIC");
  });

  it("versions 1, 2 et 4 refusées ; gros-boutiste reconnu", () => {
    for (const v of [1, 2, 4]) expect(code(() => parseGgufMetadata(gguf([], { version: v })))).toBe("BAD_VERSION");
    const be = Uint8Array.of(0x47, 0x47, 0x55, 0x46, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(code(() => parseGgufMetadata(be))).toBe("BIG_ENDIAN");
  });

  it("magie correcte mais en-tête fixe tronqué", () => {
    expect(code(() => parseGgufMetadata(Uint8Array.of(0x47, 0x47, 0x55, 0x46)))).toBe("TRUNCATED_HEADER");
    expect(code(() => parseGgufMetadata(gguf([]).subarray(0, 15)))).toBe("TRUNCATED_HEADER");
  });

  it("10⁹ paires annoncées : plafond, sans boucler", () => {
    const t0 = Date.now();
    expect(code(() => parseGgufMetadata(gguf([], { declared: 1_000_000_000 })))).toBe("LIMIT");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("chaîne de 2⁶² octets : plafond, aucune allocation", () => {
    const w = new W();
    for (const c of "GGUF") w.u8(c.charCodeAt(0));
    w.u32(3);
    w.u64(0);
    w.u64(1);
    w.u64(2n ** 62n); // longueur de la clé
    expect(code(() => parseGgufMetadata(w.bytes()))).toBe("LIMIT");
  });

  it("tableau de chaînes annonçant 16 millions d'éléments sur 40 octets : tronqué, pas de boucle", () => {
    const w = new W();
    for (const c of "GGUF") w.u8(c.charCodeAt(0));
    w.u32(3);
    w.u64(0);
    w.u64(1);
    w.str("tokenizer.x");
    w.u32(9);
    w.u32(8); // éléments : chaînes
    w.u64(1 << 23); // sous le plafond, très au-delà de la fenêtre
    const t0 = Date.now();
    const m = parseGgufMetadata(w.bytes());
    expect(m.complete).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("tableau au-delà du plafond d'éléments, type de valeur inconnu, tableaux trop imbriqués", () => {
    const arr = (n: bigint, elem = 4) => {
      const w = new W();
      for (const c of "GGUF") w.u8(c.charCodeAt(0));
      w.u32(3);
      w.u64(0);
      w.u64(1);
      w.str("k");
      w.u32(9);
      w.u32(elem);
      w.u64(n);
      return w.bytes();
    };
    expect(code(() => parseGgufMetadata(arr(2n ** 40n)))).toBe("LIMIT");
    expect(code(() => parseGgufMetadata(arr(1n, 77)))).toBe("BAD_TYPE");
    const nested = new W();
    for (const c of "GGUF") nested.u8(c.charCodeAt(0));
    nested.u32(3);
    nested.u64(0);
    nested.u64(1);
    nested.str("k");
    for (let i = 0; i < 4; i++) {
      nested.u32(9); // type : tableau
      nested.u32(9); // éléments : tableaux
      nested.u64(1);
    }
    expect(code(() => parseGgufMetadata(nested.bytes()))).toBe("LIMIT");
    const bad = new W();
    for (const c of "GGUF") bad.u8(c.charCodeAt(0));
    bad.u32(3);
    bad.u64(0);
    bad.u64(1);
    bad.str("k");
    bad.u32(99);
    expect(code(() => parseGgufMetadata(bad.bytes()))).toBe("BAD_TYPE");
  });

  it("plafonds réglables : une chaîne de 10 octets refusée à 4", () => {
    expect(() => parseGgufMetadata(gguf([str("general.architecture", "0123456789")]), { maxStringBytes: 4 })).toThrow(/LIMIT/);
  });
});

// ---------------------------------------------------------------------------------------------------- estimation

describe("estimateGgufMemory — Qwen3.5 hybride : 8 couches d'attention sur 32", () => {
  it("32 768 octets de KV par jeton à 16 bits (2 × 8 × 4 × 256 × 2)", () => {
    const r = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 1, fileBytes: FILE_9B });
    expect(r.attentionLayers).toBe(8);
    expect(r.totalLayers).toBe(32);
    expect(r.kvBytesPerToken).toBe(32768);
    expect(r.breakdown!.kvBytes).toBe(32768);
  });

  it("le cache KV suit le contexte : 4 096 jetons → 128 Mio ; 262 144 jetons → 8 Gio (8 589 934 592 octets)", () => {
    const small = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 4096, fileBytes: FILE_9B });
    const full = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 262144, fileBytes: FILE_9B });
    expect(small.breakdown!.kvBytes).toBe(4096 * 32768);
    expect(full.breakdown!.kvBytes).toBe(8_589_934_592);
    // La règle « taille × 1,2 » donnait la même réponse aux deux contextes ; l'estimation, non.
    expect(full.breakdown!.kvBytes).toBeGreaterThan(small.breakdown!.kvBytes * 60);
    expect(full.status).toBe("estimated");
  });

  it("état récurrent : 24 couches × (état + convolution) en f32 = 52 690 944 octets par séquence, multiplié par les créneaux", () => {
    const one = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 4096, fileBytes: FILE_9B });
    const four = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 4096, fileBytes: FILE_9B, parallelSlots: 4 });
    expect(one.breakdown!.stateBytes).toBe(52_690_944);
    expect(four.breakdown!.stateBytes).toBe(4 * 52_690_944);
    expect(four.breakdown!.kvBytes).toBe(one.breakdown!.kvBytes); // KV unifié compté une fois
    expect(one.assumptions.join(" ")).toMatch(/état récurrent qwen35/);
  });

  it("KV quantifié : q8_0 = 17 408 octets par jeton, q4_0 = 9 216", () => {
    const q8 = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 1, fileBytes: FILE_9B, kvTypeK: "q8_0", kvTypeV: "q8_0" });
    const q4 = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 1, fileBytes: FILE_9B, kvTypeK: "q4_0", kvTypeV: "q4_0" });
    expect(q8.kvBytesPerToken).toBeCloseTo(8 * 4 * (256 * KV_BYTES_PER_ELEMENT.q8_0 * 2), 6);
    expect(q8.kvBytesPerToken).toBe(17408);
    expect(q4.kvBytesPerToken).toBe(9216);
  });

  it("K et V de types différents", () => {
    const r = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 1, fileBytes: FILE_9B, kvTypeK: "q8_0", kvTypeV: "f16" });
    expect(r.kvBytesPerToken).toBe(8 * 4 * (256 * 1.0625 + 256 * 2));
  });
});

describe("estimateGgufMemory — attention standard", () => {
  it("40 couches × 8 têtes KV × (128 + 128) × 2 octets = 163 840 octets par jeton ; longueur de tête déduite de embedding_length / head_count", () => {
    const r = estimateGgufMemory(meta(STD_LLAMA), { contextTokens: 1000, fileBytes: 12 * GIB });
    expect(r.attentionLayers).toBe(40);
    expect(r.kvBytesPerToken).toBe(163_840);
    expect(r.breakdown!.kvBytes).toBe(163_840_000);
    expect(r.breakdown!.stateBytes).toBe(0);
  });

  it("head_count_kv absente = autant de têtes KV que de têtes (pas de regroupement)", () => {
    const r = estimateGgufMemory(meta(withEntries(STD_LLAMA, ["llama.attention.head_count_kv"])), { contextTokens: 1, fileBytes: GIB });
    expect(r.kvBytesPerToken).toBe(40 * 40 * (128 * 2 + 128 * 2));
  });

  it("les familles qwen2, qwen3 et qwen3moe sont prises en charge", () => {
    for (const arch of ["qwen2", "qwen3", "qwen3moe"]) {
      const e = STD_LLAMA.map((x) => ({ ...x, key: x.key.replace(/^llama/, arch) }) as Entry).map((x) => (x.key === "general.architecture" ? str(x.key, arch) : x));
      expect(estimateGgufMemory(meta(e), { contextTokens: 1, fileBytes: GIB }).status).toBe("estimated");
    }
  });
});

describe("estimateGgufMemory — jamais d'invention : `not-estimated`, sans chiffre", () => {
  const ne = (entries: Entry[], opts: Partial<Parameters<typeof estimateGgufMemory>[1]> = {}) =>
    estimateGgufMemory(meta(entries), { contextTokens: 4096, fileBytes: GIB, ...opts });

  it("architecture absente", () => {
    const r = ne([u32("llama.block_count", 4)]);
    expect(r.status).toBe("not-estimated");
    expect(r.breakdown).toBeNull();
    expect(r.reason).toMatch(/general\.architecture/);
  });

  it("architecture non prise en charge (fenêtre glissante, attention latente, etc.)", () => {
    for (const arch of ["gpt-oss", "gemma3", "deepseek2", "mamba"]) {
      const r = ne([str("general.architecture", arch), u32(`${arch}.block_count`, 24), u32(`${arch}.attention.head_count`, 16)]);
      expect(r.status).toBe("not-estimated");
      expect(r.breakdown).toBeNull();
      expect(r.kvBytesPerToken).toBeNull();
      expect(r.reason).toMatch(new RegExp(arch));
    }
  });

  it("clés manquantes : nombre de couches, de têtes, longueur de tête, intervalle d'attention, clés SSM", () => {
    expect(ne(withEntries(STD_LLAMA, ["llama.block_count"])).reason).toMatch(/block_count/);
    expect(ne(withEntries(STD_LLAMA, ["llama.attention.head_count"])).reason).toMatch(/head_count/);
    expect(ne(withEntries(STD_LLAMA, ["llama.embedding_length"])).reason).toMatch(/longueur des têtes/);
    expect(ne(withEntries(QWEN35_9B, ["qwen35.full_attention_interval"])).reason).toMatch(/full_attention_interval/);
    expect(ne(withEntries(QWEN35_9B, ["qwen35.ssm.inner_size"])).reason).toMatch(/ssm/);
  });

  it("valeurs absurdes : zéro, négatif, texte, tableau par couche", () => {
    expect(ne(withEntries(STD_LLAMA, ["llama.block_count"], [u32("llama.block_count", 0)])).status).toBe("not-estimated");
    expect(ne(withEntries(STD_LLAMA, ["llama.attention.head_count"], [str("llama.attention.head_count", "seize")])).status).toBe("not-estimated");
    const perLayer = withEntries(STD_LLAMA, ["llama.attention.head_count_kv"], [{ key: "llama.attention.head_count_kv", type: "arr", elem: "u32", value: [8, 8, 4] }]);
    const r = ne(perLayer);
    expect(r.status).toBe("not-estimated");
    expect(r.reason).toMatch(/tableau par couche/);
  });

  it("contexte et taille de fichier invalides", () => {
    for (const contextTokens of [0, -1, 1.5, Number.NaN]) expect(ne(STD_LLAMA, { contextTokens }).status).toBe("not-estimated");
    for (const fileBytes of [0, -5, Number.NaN]) expect(ne(STD_LLAMA, { fileBytes }).status).toBe("not-estimated");
  });

  it("en-tête dont la fenêtre est tronquée AVANT les clés de l'architecture : non estimé, pas de valeur par défaut", () => {
    const cut = parseGgufMetadata(gguf([str("general.architecture", "qwen35"), str("general.name", "x".repeat(500))]).subarray(0, 80));
    expect(cut.complete).toBe(false);
    const r = estimateGgufMemory(cut, { contextTokens: 4096, fileBytes: GIB });
    expect(r.status).toBe("not-estimated");
    expect(r.breakdown).toBeNull();
  });
});

describe("estimateGgufMemory — décision de tenue et contexte natif", () => {
  it("avec une mémoire GPU : fits / does-not-fit sur poids + KV + état + marge", () => {
    const need = FILE_9B + 8 * 32768 * 1024 + 52_690_944 + PROVISIONAL_COMPUTE_HEADROOM_BYTES; // contexte de 8 192 jetons
    const base = { contextTokens: 8192, fileBytes: FILE_9B };
    expect(estimateGgufMemory(meta(QWEN35_9B), { ...base, gpuBytes: need }).status).toBe("fits");
    expect(estimateGgufMemory(meta(QWEN35_9B), { ...base, gpuBytes: need - 1 }).status).toBe("does-not-fit");
  });

  it("sans mémoire GPU connue : `estimated`, jamais `fits` par défaut", () => {
    expect(estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 4096, fileBytes: FILE_9B }).status).toBe("estimated");
    expect(estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 4096, fileBytes: FILE_9B, gpuBytes: null }).status).toBe("estimated");
  });

  it("la marge peut être remplacée ; sinon l'hypothèse « provisoire » est annoncée", () => {
    const def = estimateGgufMemory(meta(STD_LLAMA), { contextTokens: 1, fileBytes: GIB });
    const own = estimateGgufMemory(meta(STD_LLAMA), { contextTokens: 1, fileBytes: GIB, headroomBytes: 123 });
    expect(def.breakdown!.headroomBytes).toBe(PROVISIONAL_COMPUTE_HEADROOM_BYTES);
    expect(def.assumptions.join(" ")).toMatch(/provisoire/);
    expect(own.breakdown!.headroomBytes).toBe(123);
    expect(own.assumptions.join(" ")).not.toMatch(/marge de tampons/);
  });

  it("262 144 jetons exactement : dans le contexte natif ; 262 145 : `beyond-native-context`, KV calculé et affiché quand même", () => {
    const at = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 262144, fileBytes: FILE_9B, gpuBytes: 1e15 });
    const over = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 262145, fileBytes: FILE_9B, gpuBytes: 1e15 });
    expect(at.status).toBe("fits");
    expect(over.status).toBe("beyond-native-context");
    expect(over.nativeContextTokens).toBe(262144);
    expect(over.breakdown!.kvBytes).toBe(262145 * 32768);
    expect(over.reason).toMatch(/262145/);
    expect(over.reason).toMatch(/contexte natif/);
  });
});

describe("Q-FIT5 — le cache KV est toujours affiché à part, jamais un chiffre unique", () => {
  const ctxs = [1, 4096, 65536, 262144, 262145, 1_000_000];

  it("le résultat ne porte aucun total isolé : poids, KV, état et marge sont des champs séparés", () => {
    for (const contextTokens of ctxs) {
      const r = estimateGgufMemory(meta(QWEN35_9B), { contextTokens, fileBytes: FILE_9B });
      expect(Object.keys(r.breakdown!).sort()).toEqual(["headroomBytes", "kvBytes", "stateBytes", "weightsBytes"]);
      expect(Object.keys(r)).not.toContain("totalBytes");
      expect(Object.keys(r)).not.toContain("bytes");
    }
  });

  it("l'affichage a toujours une ligne « cache KV » distincte de la ligne « poids du fichier », au-delà de 262 144 jetons compris", () => {
    for (const contextTokens of ctxs) {
      const text = renderFit(estimateGgufMemory(meta(QWEN35_9B), { contextTokens, fileBytes: FILE_9B }));
      const lines = text.split("\n");
      expect(lines.filter((l) => l.startsWith("poids du fichier")).length).toBe(1);
      const kv = lines.filter((l) => l.startsWith("cache KV"));
      expect(kv.length).toBe(1);
      expect(kv[0]).toContain(`${contextTokens} jetons`);
      expect(kv[0]).toContain("8/32 couches d'attention");
    }
  });

  it("au-delà du contexte natif, l'affichage dit pourquoi la tenue n'est pas affirmée", () => {
    expect(renderFit(estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 300000, fileBytes: FILE_9B }))).toMatch(/contexte natif/);
  });

  it("non estimé : l'affichage dit « non estimé » et la raison, aucun chiffre", () => {
    const text = renderFit(estimateGgufMemory(meta([str("general.architecture", "mamba")]), { contextTokens: 4096, fileBytes: GIB }));
    expect(text).toMatch(/^non estimé — /);
    expect(text).not.toMatch(/Gio/);
  });

  it("les valeurs sont exactes à l'octet : 262 144 jetons = 8,00 Gio de KV pour 10,48 Go de poids (affichage en Gio)", () => {
    const text = renderFit(estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 262144, fileBytes: FILE_9B }));
    expect(text).toContain("cache KV (262144 jetons, 8/32 couches d'attention) : 8.00 Gio");
    expect(text).toContain("poids du fichier : 9.76 Gio");
  });
});

// ---------------------------------------------------------------------------------------------------- lecture d'un fichier

describe("readGgufFile — fenêtre bornée, jamais le fichier entier", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-gguf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fileOf = (name: string, header: Uint8Array, tailBytes: number): string => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.concat([header, Buffer.alloc(tailBytes, 7)]));
    return path;
  };

  it("les clés de l'architecture sont en tête : une seule fenêtre suffit, même si le fichier est énorme après", async () => {
    const path = fileOf("a.gguf", gguf(QWEN35_9B), 5 * 1024 * 1024);
    const r = await readGgufFile(path, { windowBytes: 4096 });
    expect(r.metadata.complete).toBe(true);
    expect(r.windowBytes).toBeLessThanOrEqual(4096 + 1024 * 1024);
    expect(r.fileBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(r.metadata.kv.get("qwen35.block_count")).toBe(32);
  });

  it("la fenêtre est doublée seulement si les clés de l'architecture manquent, et s'arrête dès qu'elles sont lues", async () => {
    // Les clés `<arch>.*` viennent APRÈS un gros bloc : la première fenêtre ne les voit pas.
    const bigName = str("general.name", "n".repeat(3000));
    const entries = [str("general.architecture", "llama"), bigName, ...STD_LLAMA.filter((e) => e.key !== "general.architecture")];
    const path = fileOf("b.gguf", gguf(entries), 100_000);
    const r = await readGgufFile(path, { windowBytes: 512 });
    expect(r.metadata.kv.get("llama.block_count")).toBe(40);
    expect(r.windowBytes).toBeGreaterThan(512);
    expect(r.windowBytes).toBeLessThan(16 * 1024 * 1024);
  });

  it("plafond de lecture respecté : clés introuvables, on s'arrête à maxBytes et on rend l'en-tête partiel", async () => {
    const entries = [str("general.architecture", "llama"), str("general.name", "n".repeat(50_000)), ...STD_LLAMA.slice(1)];
    const path = fileOf("c.gguf", gguf(entries), 10);
    const r = await readGgufFile(path, { windowBytes: 1024, maxBytes: 4096 });
    expect(r.windowBytes).toBeLessThanOrEqual(4096);
    expect(r.metadata.kv.has("llama.block_count")).toBe(false);
    expect(estimateGgufMemory(r.metadata, { contextTokens: 1, fileBytes: r.fileBytes }).status).toBe("not-estimated");
  });

  it("fichier plus court que la fenêtre ; fichier qui n'est pas un GGUF ; fichier vide", async () => {
    expect((await readGgufFile(fileOf("d.gguf", gguf(STD_LLAMA), 0))).metadata.complete).toBe(true);
    await expect(readGgufFile(fileOf("e.gguf", new TextEncoder().encode("PK pas un gguf"), 100))).rejects.toThrow(/BAD_MAGIC/);
    await expect(readGgufFile(fileOf("f.gguf", new Uint8Array(0), 0))).rejects.toThrow(/BAD_MAGIC/);
  });

  it("n'écrit rien : le fichier lu est identique avant et après", async () => {
    const path = fileOf("g.gguf", gguf(STD_LLAMA), 1000);
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(path);
    await readGgufFile(path);
    expect(Buffer.compare(before, readFileSync(path))).toBe(0);
  });
});

describe("estimateGgufFile — depuis un fichier, sans jamais jeter", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-gguf-file-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fileOf = (name: string, bytes: Uint8Array, padding = 0): string => {
    const path = join(dir, name);
    const out = new Uint8Array(bytes.length + padding);
    out.set(bytes);
    writeFileSync(path, out);
    return path;
  };

  it("fichier valide : poids = taille du fichier, KV à part, résultat identique à l'estimation sur l'en-tête", async () => {
    const path = fileOf("a.gguf", gguf(QWEN35_9B), 4_000_000);
    const { fit, fileBytes } = await estimateGgufFile(path, { contextTokens: 10_000 });
    expect(fileBytes).toBe(gguf(QWEN35_9B).byteLength + 4_000_000);
    expect(fit.status).toBe("estimated");
    expect(fit.breakdown!.weightsBytes).toBe(fileBytes);
    expect(fit.breakdown!.kvBytes).toBe(32_768 * 10_000);
    expect(fit).toEqual(estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 10_000, fileBytes: fileBytes! }));
  });

  it("élargit la fenêtre jusqu'à ce que l'estimateur ait ses clés (clés ssm placées après un long nom)", async () => {
    const entries = [str("general.architecture", "qwen35"), str("general.name", "n".repeat(300_000)), ...QWEN35_9B.slice(1)];
    const { fit } = await estimateGgufFile(fileOf("b.gguf", gguf(entries), 1000), { contextTokens: 4096 });
    expect(fit.status).toBe("estimated");
  });

  it("architecture inconnue : non estimé tout de suite (la fenêtre n'est pas agrandie pour rien), jamais un chiffre", async () => {
    const entries = [str("general.architecture", "gemma3"), u32("gemma3.block_count", 30), str("general.name", "n".repeat(400_000))];
    const { fit } = await estimateGgufFile(fileOf("c.gguf", gguf(entries), 10), { contextTokens: 4096 });
    expect(fit.status).toBe("not-estimated");
    expect(fit.breakdown).toBeNull();
    expect(fit.reason).toMatch(/gemma3/);
  });

  it("fichier absent, vide, ou qui n'est pas un GGUF : non estimé avec la raison, aucune exception", async () => {
    const missing = await estimateGgufFile(join(dir, "absent.gguf"), { contextTokens: 4096 });
    expect(missing.fit.status).toBe("not-estimated");
    expect(missing.fit.reason).toMatch(/illisible/);
    expect(missing.fileBytes).toBeNull();
    const empty = await estimateGgufFile(fileOf("d.gguf", new Uint8Array(0)), { contextTokens: 4096 });
    expect(empty.fit.reason).toMatch(/BAD_MAGIC/);
    const text = await estimateGgufFile(fileOf("e.gguf", new TextEncoder().encode("PK pas un gguf du tout"), 100), { contextTokens: 4096 });
    expect(text.fit.status).toBe("not-estimated");
  });

  it("contexte invalide : non estimé (pas de division, pas de NaN)", async () => {
    const { fit } = await estimateGgufFile(fileOf("f.gguf", gguf(STD_LLAMA), 1000), { contextTokens: 0 });
    expect(fit.status).toBe("not-estimated");
  });
});

describe("maxContextThatFits — l'inverse exact de l'estimation", () => {
  const std = meta(STD_LLAMA); // 40 couches × 8 têtes KV × (128 + 128) × 2 octets = 163 840 octets par jeton
  const base = { fileBytes: 4 * GIB, gpuBytes: 24 * GIB };

  it("propriété : le contexte rendu tient ; borné par la mémoire, le suivant ne tient plus ; borné par le contexte natif, c'est le natif", () => {
    const limits = new Set<string | null>();
    for (const gpuGib of [6, 8, 12, 16, 24]) {
      for (const kvType of ["f16", "q8_0", "q4_0"] as const) {
        const opts = { ...base, gpuBytes: gpuGib * GIB, kvTypeK: kvType, kvTypeV: kvType };
        const r = maxContextThatFits(std, opts);
        limits.add(r.limitedBy);
        expect(r.contextTokens).not.toBeNull();
        expect(estimateGgufMemory(std, { ...opts, contextTokens: r.contextTokens! }).status).toBe("fits");
        if (r.limitedBy === "memory") expect(estimateGgufMemory(std, { ...opts, contextTokens: r.contextTokens! + 1 }).status).toBe("does-not-fit");
        else expect(r.contextTokens).toBe(131072);
      }
    }
    expect(limits).toEqual(new Set(["memory", "native-context"])); // les deux branches sont exercées
  });

  it("plafonné par le contexte natif quand la mémoire est abondante", () => {
    const r = maxContextThatFits(std, { ...base, gpuBytes: 512 * GIB });
    expect(r).toEqual({ contextTokens: 131072, limitedBy: "native-context" });
  });

  it("Qwen3.5 hybride : l'état récurrent compte et l'invariant tient aussi", () => {
    const m = meta(QWEN35_9B);
    const opts = { fileBytes: FILE_9B, gpuBytes: 16 * GIB, parallelSlots: 4 };
    const r = maxContextThatFits(m, opts);
    expect(r.limitedBy).toBe("memory");
    expect(estimateGgufMemory(m, { ...opts, contextTokens: r.contextTokens! }).status).toBe("fits");
    expect(estimateGgufMemory(m, { ...opts, contextTokens: r.contextTokens! + 1 }).status).toBe("does-not-fit");
  });

  it("le poids seul dépasse la mémoire : aucun contexte, avec la raison (jamais zéro)", () => {
    const r = maxContextThatFits(std, { ...base, fileBytes: 30 * GIB });
    expect(r.contextTokens).toBeNull();
    expect(r.reason).toMatch(/dépassent/);
  });

  it("architecture inconnue ou mémoire inconnue : null avec la raison", () => {
    expect(maxContextThatFits(meta([str("general.architecture", "gemma3")]), base).reason).toMatch(/gemma3/);
    expect(maxContextThatFits(std, { ...base, gpuBytes: 0 }).reason).toMatch(/inconnue/);
    expect(maxContextThatFits(std, { ...base, gpuBytes: Number.NaN }).contextTokens).toBeNull();
  });
});

describe("attention HYBRIDE à couches d'attention minoritaires (en-tête réel d'un Qwen3.8-27B : 65 couches, intervalle 4, une couche MTP)", () => {
  // Valeurs lues le 2026-10-03 sur un en-tête local (métadonnées seulement).
  const QWEN38_27B: Entry[] = withEntries(
    QWEN35_9B,
    ["qwen35.block_count", "qwen35.embedding_length", "qwen35.attention.head_count", "qwen35.ssm.time_step_rank", "qwen35.ssm.inner_size"],
    [u32("qwen35.block_count", 65), u32("qwen35.embedding_length", 5120), u32("qwen35.attention.head_count", 24), u32("qwen35.ssm.time_step_rank", 48), u32("qwen35.ssm.inner_size", 6144), u32("qwen35.nextn_predict_layers", 1)],
  );
  const m = meta(QWEN38_27B);
  const FILE = 16_713_148_000;

  it("seules les couches d'attention comptent pour le cache KV : 16 sur 65, 65 536 octets par jeton à 16 bits — pas les 65 couches", () => {
    const r = estimateGgufMemory(m, { contextTokens: 8192, fileBytes: FILE });
    expect(r.attentionLayers).toBe(16);
    expect(r.totalLayers).toBe(65);
    expect(r.kvBytesPerToken).toBe(16 * 4 * (256 + 256) * 2);
    expect(r.breakdown!.kvBytes).toBe(65_536 * 8192);
  });

  it("contexte maximal : ~4× celui qu'on obtiendrait en comptant TOUTES les couches (rapport 65/16), et l'invariant « tient / ne tient plus » vaut", () => {
    const gpuBytes = 24 * GIB;
    const opts = { fileBytes: FILE, gpuBytes, parallelSlots: 1 };
    const hybrid = maxContextThatFits(m, opts);
    expect(hybrid.limitedBy).toBe("memory");
    // Le même modèle compté comme une attention standard à 65 couches (le défaut qu'on craint) :
    const std = withEntries(
      [str("general.architecture", "llama"), u32("llama.block_count", 65), u32("llama.context_length", 262144), u32("llama.embedding_length", 5120), u32("llama.attention.head_count", 20), u32("llama.attention.head_count_kv", 4), u32("llama.attention.key_length", 256), u32("llama.attention.value_length", 256)],
    );
    const naive = maxContextThatFits(meta(std), opts);
    expect(estimateGgufMemory(meta(std), { contextTokens: 1, fileBytes: FILE }).kvBytesPerToken).toBe(65 * 4 * 512 * 2);
    // Valeurs exactes : mémoire − poids − état − marge, divisée par les octets de cache PAR JETON (16 couches d'un côté, 65 de l'autre).
    const stateBytes = estimateGgufMemory(m, { contextTokens: 1, fileBytes: FILE }).breakdown!.stateBytes;
    expect(stateBytes).toBeGreaterThan(0);
    expect(hybrid.contextTokens).toBe(Math.floor((gpuBytes - FILE - stateBytes - PROVISIONAL_COMPUTE_HEADROOM_BYTES) / 65_536));
    expect(naive.contextTokens).toBe(Math.floor((gpuBytes - FILE - PROVISIONAL_COMPUTE_HEADROOM_BYTES) / 266_240));
    // Compter les 65 couches aurait proposé ~4× MOINS de contexte (l'état récurrent du hybride rogne un peu le rapport 65/16 ≈ 4,06).
    expect(hybrid.contextTokens! / naive.contextTokens!).toBeGreaterThan(3.8);
    expect(hybrid.contextTokens! / naive.contextTokens!).toBeLessThan(4.1);
    expect(estimateGgufMemory(m, { ...opts, contextTokens: hybrid.contextTokens! }).status).toBe("fits");
    expect(estimateGgufMemory(m, { ...opts, contextTokens: hybrid.contextTokens! + 1 }).status).toBe("does-not-fit");
  });

  it("la couche MTP (`nextn_predict_layers`) est annoncée comme hypothèse, avec son effet (1/16 de cache en plus si elle en garde un), sans changer le chiffre", () => {
    const r = estimateGgufMemory(m, { contextTokens: 8192, fileBytes: FILE });
    const note = r.assumptions.find((a) => a.includes("nextn_predict_layers"));
    expect(note).toMatch(/1\/16/);
    expect(note).toMatch(/16 → 17/);
    const without = estimateGgufMemory(meta(QWEN35_9B), { contextTokens: 8192, fileBytes: FILE });
    expect(without.assumptions.some((a) => a.includes("nextn_predict_layers"))).toBe(false);
    expect(estimateGgufMemory(m, { contextTokens: 8192, fileBytes: FILE }).kvBytesPerToken).toBe(65_536);
  });
});

describe("reportGgufFit — le rapport d'un préréglage, en une lecture", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-gguf-report-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fileOf = (name: string, entries: Entry[], padding: number): string => {
    const head = gguf(entries);
    const path = join(dir, name);
    writeFileSync(path, Buffer.concat([head, Buffer.alloc(padding, 7)]));
    return path;
  };

  it("décharge complète : verdict, contexte maximal cohérent avec l'estimation, KV et type de cache pris en compte", async () => {
    const path = fileOf("a.gguf", STD_LLAMA, 4 * 1024 * 1024);
    const r = await reportGgufFit(path, { contextTokens: 8192, cacheType: "q8_0", parallelSlots: 1, gpuBytes: 8 * GIB, gpuLayers: -1 });
    expect(r.fit.status).toBe("fits");
    expect(r.fit.breakdown!.kvBytes).toBe(Math.round(163_840 * (17 / 32) * 8192));
    expect(r.maxContext!.limitedBy).toBe("memory");
    expect(r.notes).toEqual([]);
    const again = await reportGgufFit(path, { contextTokens: r.maxContext!.contextTokens! + 1, cacheType: "q8_0", parallelSlots: 1, gpuBytes: 8 * GIB, gpuLayers: -1 });
    expect(again.fit.status).toBe("does-not-fit");
  });

  it("décharge PARTIELLE : pas de verdict ni de contexte maximal, le KV reste calculé, note `partial-offload` ; 'toutes les couches' = complète", async () => {
    const path = fileOf("b.gguf", STD_LLAMA, 1_000_000);
    const partial = await reportGgufFit(path, { contextTokens: 4096, gpuBytes: 1, gpuLayers: 20 });
    expect(partial.fit.status).toBe("estimated");
    expect(partial.fit.breakdown!.kvBytes).toBe(163_840 * 4096);
    expect(partial.maxContext).toBeNull();
    expect(partial.notes).toContain("partial-offload");
    for (const gpuLayers of [40, 999, -1]) {
      const full = await reportGgufFit(path, { contextTokens: 4096, gpuBytes: 8 * GIB, gpuLayers });
      expect(full.notes).not.toContain("partial-offload");
      expect(full.fit.status).toBe("fits");
    }
  });

  it("notes d'hypothèses : brouillon non compté, créneaux au défaut du serveur", async () => {
    const path = fileOf("c.gguf", STD_LLAMA, 1000);
    expect((await reportGgufFit(path, { contextTokens: 4096, draftModel: true, parallelSlots: 2 })).notes).toEqual(["draft-model-not-counted"]);
    expect((await reportGgufFit(path, { contextTokens: 4096, parallelSlots: null })).notes).toEqual(["parallel-slots-default"]);
  });

  it("mémoire inconnue : estimé sans verdict ; fichier illisible : non estimé, aucune exception, notes conservées", async () => {
    const path = fileOf("d.gguf", STD_LLAMA, 1000);
    const unknown = await reportGgufFit(path, { contextTokens: 4096, parallelSlots: 1, gpuBytes: null });
    expect(unknown.fit.status).toBe("estimated");
    expect(unknown.maxContext).toBeNull();
    const bad = await reportGgufFit(join(dir, "absent.gguf"), { contextTokens: 4096, draftModel: true });
    expect(bad.fit.status).toBe("not-estimated");
    expect(bad.fileBytes).toBeNull();
    expect(bad.notes).toContain("draft-model-not-counted");
  });
});
