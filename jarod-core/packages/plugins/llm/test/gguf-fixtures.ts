// Constructeur d'en-têtes GGUF pour les tests de lecture `Range` (même construction que `gguf-fit.test.ts`, dont le fichier reste INCHANGÉ : barre (H)
// de SPECS-P5-MODELS.md). Fixtures d'en-tête seulement : aucun fichier de modèle réel.

export type Entry =
  | { key: string; type: "u32" | "u64"; value: number | bigint }
  | { key: string; type: "str"; value: string }
  | { key: string; type: "arr"; elem: "u32" | "str"; value: (number | string)[] };

const TYPE_ID = { u32: 4, str: 8, arr: 9, u64: 10 } as const;

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
  str(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.u64(bytes.length);
    for (const b of bytes) this.parts.push(b);
  }
}

export function gguf(entries: Entry[], over: { declared?: number } = {}): Uint8Array {
  const w = new W();
  for (const c of "GGUF") w.u8(c.charCodeAt(0));
  w.u32(3);
  w.u64(0);
  w.u64(over.declared ?? entries.length);
  for (const e of entries) {
    w.str(e.key);
    w.u32(TYPE_ID[e.type]);
    if (e.type === "str") w.str(e.value);
    else if (e.type === "arr") {
      w.u32(TYPE_ID[e.elem]);
      w.u64(e.value.length);
      for (const v of e.value) (e.elem === "str" ? w.str(String(v)) : w.u32(Number(v)));
    } else if (e.type === "u64") w.u64(e.value);
    else w.u32(Number(e.value));
  }
  return Uint8Array.from(w.parts);
}

export const u32 = (key: string, value: number): Entry => ({ key, type: "u32", value });
export const str = (key: string, value: string): Entry => ({ key, type: "str", value });

/** Le fichier : l'en-tête suivi de `tail` octets (les « tenseurs » : jamais lus). */
export const withTail = (header: Uint8Array, tail: number): Buffer => Buffer.concat([header, Buffer.alloc(tail, 7)]);

/** Qwen3.5 9B (hybride) — valeurs lues le 2026-10-02 sur un en-tête local, comme dans `gguf-fit.test.ts`. */
export const QWEN35_9B: Entry[] = [
  str("general.architecture", "qwen35"),
  str("general.name", "Qwen3.5 9B"),
  u32("qwen35.block_count", 32),
  u32("qwen35.context_length", 262144),
  u32("qwen35.embedding_length", 4096),
  u32("qwen35.attention.head_count", 16),
  u32("qwen35.attention.head_count_kv", 4),
  u32("qwen35.attention.key_length", 256),
  u32("qwen35.attention.value_length", 256),
  u32("qwen35.ssm.conv_kernel", 4),
  u32("qwen35.ssm.state_size", 128),
  u32("qwen35.ssm.group_count", 16),
  u32("qwen35.ssm.time_step_rank", 32),
  u32("qwen35.ssm.inner_size", 4096),
  u32("qwen35.full_attention_interval", 4),
  { key: "tokenizer.ggml.tokens", type: "arr", elem: "str", value: Array.from({ length: 200 }, (_, i) => `tok${i}`) },
];

/** Architecture standard à têtes groupées : 40 couches, 8 têtes KV, dimension 128. */
export const STD_LLAMA: Entry[] = [
  str("general.architecture", "llama"),
  u32("llama.block_count", 40),
  u32("llama.context_length", 131072),
  u32("llama.embedding_length", 5120),
  u32("llama.attention.head_count", 40),
  u32("llama.attention.head_count_kv", 8),
];

/** Mélange d'experts (famille `qwen3moe`). */
export const MOE: Entry[] = [
  str("general.architecture", "qwen3moe"),
  u32("qwen3moe.block_count", 48),
  u32("qwen3moe.context_length", 40960),
  u32("qwen3moe.embedding_length", 2048),
  u32("qwen3moe.attention.head_count", 32),
  u32("qwen3moe.attention.head_count_kv", 4),
  u32("qwen3moe.attention.key_length", 128),
  u32("qwen3moe.attention.value_length", 128),
];

/** Architecture hors v1 : `not-estimated`, sans chiffre. */
export const UNKNOWN_ARCH: Entry[] = [str("general.architecture", "gemma3"), u32("gemma3.block_count", 26)];

/**
 * Les 6 fixtures de la barre (A) de SPECS-P5-MODELS.md (standard, hybride, MoE, architecture inconnue, tronquée, au-delà du contexte natif), avec le contexte et le statut
 * attendus. `gguf-range.test.ts` (épinglé, INCHANGÉ) en garde sa propre copie en ligne : doublon accepté (T1 de la spec, barre (H)). `tail` : le « poids », jamais lu.
 */
export function barAFixtures(tail = 10_000_000): Record<string, { bytes: Buffer; ctx: number; status: string }> {
  return {
    "standard.gguf": { bytes: withTail(gguf(STD_LLAMA), tail), ctx: 8192, status: "fits" },
    "hybride.gguf": { bytes: withTail(gguf(QWEN35_9B), tail), ctx: 8192, status: "fits" },
    "moe.gguf": { bytes: withTail(gguf(MOE), tail), ctx: 8192, status: "fits" },
    "inconnue.gguf": { bytes: withTail(gguf(UNKNOWN_ARCH), tail), ctx: 8192, status: "not-estimated" },
    "tronque.gguf": { bytes: withTail(gguf([str("general.architecture", "llama")], { declared: 40 }), 0), ctx: 8192, status: "not-estimated" },
    "au-dela.gguf": { bytes: withTail(gguf(STD_LLAMA), tail), ctx: 200_000, status: "beyond-native-context" },
  };
}
