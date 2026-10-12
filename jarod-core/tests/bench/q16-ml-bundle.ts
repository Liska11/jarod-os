/**
 * Q16 multilingue (accord B19) : adaptations DÉRIVÉES du bundle exporté, réservées au banc (`.work/q16/`) ; les fichiers
 * reçus dans `tools/laya-multilingual-onnx/` ne sont jamais modifiés (DECISIONS 2026-09-29, « B19 — reçu, exporté »).
 *
 *   1. jetons spéciaux : `@receptron/laya` 0.1.2 cherche LITTÉRALEMENT `[CLS]`, `[SEP]`, `[MASK]`, `[PAD]` ; le tokenizer de
 *      mmBERT (Gemma 2) les nomme `<bos>` (id 2, `cls_token`), `<eos>` (id 1, `sep_token`), `<mask>` (id 4), `<pad>` (id 0).
 *      La copie dérivée ne change que les NOMS : les ids, le vocabulaire et les règles de découpage sont identiques,
 *      donc les séquences d'entrée du modèle aussi (contrôlé par le test, sur les fixtures FR et EN) ;
 *   2. DirectML : graphe dérivé `allowzero` 1 → 0 sur les `Reshape` (même traitement que le prototype anglais, DECISIONS
 *      2026-09-29), poids non modifiés ; le nombre de `Reshape` touchés est RELEVÉ (il dépend du modèle), jamais présumé.
 */

/** nom du tokenizer mmBERT → nom attendu par le runtime Laya (mêmes ids). */
export const SPECIAL_RENAMES: Readonly<Record<string, string>> = {
  "<bos>": "[CLS]",
  "<eos>": "[SEP]",
  "<mask>": "[MASK]",
  "<pad>": "[PAD]",
};

/** ids attendus derrière ces noms (tokenizer_config.json de laya-multilingual : cls=<bos>, sep=<eos>). */
export const SPECIAL_IDS: Readonly<Record<string, number>> = { "[CLS]": 2, "[SEP]": 1, "[MASK]": 4, "[PAD]": 0 };

/** Renomme, dans tout l'arbre JSON, clés et valeurs EXACTEMENT égales à un des noms ; rend le nombre de remplacements. */
export function renameSpecials<T>(json: T): { json: T; renamed: number } {
  let renamed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = SPECIAL_RENAMES[v];
      if (r !== undefined) {
        renamed++;
        return r;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const nk = SPECIAL_RENAMES[k];
        if (nk !== undefined) renamed++;
        out[nk ?? k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { json: walk(json) as T, renamed };
}

/** `allowzero` 1 → 0 dans un ModelProto sérialisé (AttributeProto : nom, champ 3 varint = 0x18, valeur). Rend le nombre touché. */
export function patchAllowZero(model: Uint8Array): { model: Uint8Array; patched: number } {
  const b = Buffer.from(model);
  let k = -1;
  let patched = 0;
  while ((k = b.indexOf("allowzero", k + 1)) >= 0) {
    if (b[k + 9] === 0x18 && b[k + 10] === 1) {
      b[k + 10] = 0;
      patched++;
    }
  }
  return { model: b, patched };
}
