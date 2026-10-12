/**
 * @jarod/plugin-rag — `ctx.rag` : pièces jointes (chiffrées avec la clé dérivée de la base), coffre
 * de secrets, recherche locale (`rag.ts`). Câblage `core.ts:369-372,378,458`.
 */
import type { RerankerProvider, VoicePriority } from "@jarod/contracts";
import { basename, join } from "node:path";
import type {} from "@jarod/plugin-storage";
import { type Context, Service } from "cordis";
import { AttachmentService } from "./attachments.js";
import { appendJsonl } from "./jsonl-log.js";
import { type ProviderRouter, type RagDeps, RagService } from "./rag.js";
import { VectorShadow } from "./shadow.js";
import { type TurbovecConfig, TurbovecProvider } from "./turbovec.js";
import { VectorIndex } from "./vector-index.js";
import { VaultService } from "./vault.js";

/** Taille maximale du rapport fantôme du reranker avant rotation (≈ 400 octets par recherche). */
const RERANK_REPORT_MAX_BYTES = 5 * 1024 * 1024;

export * from "./attachments.js";
export * from "./chunker.js";
export * from "./parser-builtin.js";
export * from "./parser-fallback.js";
export * from "./parser-route.js";
export * from "./parser-worker.js";
export * from "./rag.js";
export * from "./shadow.js";
export * from "./turbovec.js";
export * from "./vector-index.js";
export * from "./vault.js";
export * from "./zip.js";

declare module "cordis" {
  interface Context {
    rag: RagPluginService;
  }
}

export class RagPluginService extends Service {
  static readonly inject = ["storage", "llm"];
  readonly attachments: AttachmentService;
  readonly vault: VaultService;
  /** Recherche locale (`services/rag.ts`) — câblage core.ts:378. */
  readonly rag: RagService;
  /** Mode fantôme (PLAN §10 phase 1) : présent seulement si le sidecar est configuré ; `report()` pour l'état. */
  readonly shadow: VectorShadow | null;
  /** Un service de plus sur la MÊME base, avec le même câblage ; `over` remplace des dépendances (voir `createService`). */
  private readonly build: (over: Partial<RagDeps>) => RagService;
  private readonly extra: RagService[] = [];

  /**
   * `turbovec` : chemin EXPLICITE du sidecar (jamais deviné). Le fantôme ne tourne que pour les profils
   * qui posent `ecosystem.vectorShadow = "turbovec"` ; sans cette clé, rien ne démarre.
   */
  constructor(ctx: Context, config: { index?: boolean; turbovec?: TurbovecConfig; embeddingsDefaultUrl?: string } = {}) {
    super(ctx, "rag");
    const { db, dataDir, fileKey, settings } = ctx.storage;
    this.attachments = new AttachmentService(db, join(dataDir, "attachments"), fileKey);
    this.vault = new VaultService(settings);
    // `llm` est lu sans importer plugin-llm (qui dépend de ce package) : seul `providers.def` sert.
    const providers = (ctx as unknown as { llm: { providers: ProviderRouter } }).llm.providers;
    // G2 : index vectoriel en mémoire (tests/bench/rag-p95.test.ts) ; `index: false` = balayage d'origine.
    const logger = ctx.logger("rag");
    this.shadow = config?.turbovec?.bin
      ? new VectorShadow(db, "turbovec", new TurbovecProvider(config.turbovec), (line) => logger.info(line))
      : null;
    this.build = (over) =>
      new RagService({
        db,
        settings,
        providers,
        // La voix est lue PARESSEUSEMENT, au moment d'embarquer : le plugin voice peut se charger avant ou après celui-ci. Par le
        // contexte RACINE : Cordis interdit de lire un service non déclaré dans `inject` (« cannot get property without inject »),
        // et une injection optionnelle rendrait ce plugin réactif (rechargé à l'apparition de la voix) — à éviter.
        voice: () => (ctx.root as unknown as { voice?: { priority?: VoicePriority } }).voice?.priority,
        log: (line) => logger.info(line),
        // Reclassement (SPECS-P5-RERANKER.md §3) : service lu PARESSEUSEMENT (même raison que la voix) ; rapport fantôme borné, sans texte.
        reranker: () => (ctx.root as unknown as { reranker?: RerankerProvider }).reranker,
        rerankReport: (entry) => appendJsonl(join(dataDir, "rerank-shadow.jsonl"), entry, RERANK_REPORT_MAX_BYTES),
        profile: basename(dataDir).replace(/[^A-Za-z0-9._-]/g, "_") || "default",
        ...(config?.embeddingsDefaultUrl ? { embeddingsDefaultUrl: config.embeddingsDefaultUrl } : {}),
        ...(config?.index === false ? {} : { index: new VectorIndex(db) }),
        ...(this.shadow ? { shadow: this.shadow } : {}),
        ...over,
      });
    this.rag = this.build({});
    const shadow = this.shadow;
    if (shadow) ctx.effect(() => async () => void (await shadow.close()), "rag:shadow");
    ctx.effect(() => async () => void (await Promise.all([this.rag, ...this.extra].map((s) => s.close()))), "rag:parser");
  }

  /**
   * Un service SUPPLÉMENTAIRE sur la même base et avec le même câblage (voix prioritaire, journal, index) : le drapeau
   * `ecosystem.documentParser` et les chemins des workers sont lus à la construction, donc un service construit APRÈS un
   * changement de réglages les prend en compte. Fermé avec le plugin. `over` remplace des dépendances (p. ex. `voice`).
   */
  createService(over: Partial<RagDeps> = {}): RagService {
    const s = this.build(over);
    this.extra.push(s);
    return s;
  }
}

export default RagPluginService;
