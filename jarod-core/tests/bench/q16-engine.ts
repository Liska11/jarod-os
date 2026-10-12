/**
 * Prototype Q16 : `DecisionEngine` au-dessus de `@receptron/laya` (accord B18). Jarod-cordis — nouveau.
 *
 * `modelDir` EXPLICITE et obligatoire : jamais d'appel sans lui (sinon Laya téléchargerait vers
 * `~/.cache/receptron-laya`, exclu par l'accord B18). CPU par défaut ; DirectML seulement sur le graphe
 * dérivé `allowzero=0` (DECISIONS 2026-09-29) — le graphe publié y échoue (`Reshape` `node_view`).
 *
 * Le résultat est une DONNÉE (contrat `DecisionResult`) : aucune abstention n'est décidée ici (aucun seuil
 * de confiance sans décision) ; hors délai → toutes les valeurs à `null`, `timedOut: true`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DecisionAnswer, type DecisionEngine, type DecisionRequest, DecisionResult, type EngineInfo } from "@jarod/contracts";
import { Laya, type Question } from "@receptron/laya";

export type LayaDevice = "cpu" | "dml";

export interface LayaEngineConfig {
  /** Dossier local : laya.onnx, laya.onnx.data, laya_config.json, tokenizer/. */
  modelDir: string;
  device?: LayaDevice;
  /** Registre fermé : question → option (ou niveau `0`, `1`…) → description courte. */
  descriptions?: Record<string, Record<string, string>>;
  /** Révision du modèle (EngineInfo.version). */
  version?: string;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export class LayaDecisionEngine implements DecisionEngine {
  private closed = false;

  private constructor(
    private readonly laya: Laya,
    private readonly cfg: LayaEngineConfig,
  ) {}

  static async load(cfg: LayaEngineConfig): Promise<LayaDecisionEngine> {
    for (const f of ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"])
      if (!existsSync(join(cfg.modelDir, f))) throw new Error(`LAYA_MISSING: ${f} absent de modelDir`);
    const laya = await Laya.load({ modelDir: cfg.modelDir, executionProviders: [cfg.device ?? "cpu"] });
    return new LayaDecisionEngine(laya, cfg);
  }

  get available(): boolean {
    return !this.closed;
  }

  /** Limites de contexte du checkpoint (laya_config.json). */
  get limits(): { maxLen: number; headMaxLen: number } {
    return { maxLen: this.laya.config.max_len, headMaxLen: this.laya.config.head_max_len };
  }

  info(): EngineInfo {
    return { name: "laya", version: this.cfg.version ?? "laya-onnx", device: this.cfg.device === "dml" ? "DirectML" : "CPU" };
  }

  private toLaya(req: DecisionRequest): Record<string, Question> {
    const out: Record<string, Question> = {};
    for (const q of req.questions) {
      const d = this.cfg.descriptions?.[q.id] ?? {};
      if (q.type === "choice") out[q.id] = { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o, d[o] ?? null])) };
      else if (q.type === "score")
        out[q.id] = { type: "score", instructions: q.instructions, criteria: Array.from({ length: q.levels }, (_, i) => d[String(i)] ?? `level ${i}`) };
      else out[q.id] = { type: "noul", instructions: q.instructions, ...(d.true || d.false ? { criteria: { true: d.true, false: d.false } } : {}) };
    }
    return out;
  }

  /** Tokens d'entrée du dernier appel (contrôle de la limite de contexte). */
  lastInputTokens = 0;

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    if (this.closed) throw new Error("LAYA_CLOSED: moteur fermé");
    req.signal?.throwIfAborted();
    const t0 = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), req.deadlineMs);
    });
    const res = await Promise.race([this.laya.systemOne(req.state, this.toLaya(req)), late]).finally(() => clearTimeout(timer));
    const ms = performance.now() - t0;
    if (res) this.lastInputTokens = res.usage.input_tokens;
    const answers: DecisionAnswer[] = req.questions.map((q): DecisionAnswer => {
      const a = res?.answers[q.id];
      if (q.type === "choice") {
        const c = a?.type === "choice" ? a : null;
        return { id: q.id, type: "choice", value: c?.choice ?? null, probabilities: c ? q.options.map((o) => c.probabilities[o] ?? 0) : [] };
      }
      if (q.type === "score") {
        const s = a?.type === "score" ? a : null;
        return {
          id: q.id,
          type: "score",
          value: s ? Math.round(s.score) : null,
          probabilities: s ? Array.from({ length: q.levels }, (_, i) => s.probabilities[String(i)] ?? 0) : [],
        };
      }
      const n = a?.type === "noul" ? a : null;
      return { id: q.id, type: "noul", value: n ? n.noul >= 0.5 : null, probability: n ? round4(n.noul) : 0 };
    });
    return DecisionResult.parse({ answers, engine: this.info(), ms, timedOut: !res });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.laya.close();
  }
}
