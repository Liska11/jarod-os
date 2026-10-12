/**
 * @jarod/plugin-embeddings — `ctx.embeddings` : embeddings locaux sur NPU (OpenVINO), et un point
 * d'accès OpenAI-compatible `/v1/embeddings` sur 127.0.0.1 : `rag.ts` (réglage `rag.embeddingsUrl`)
 * s'en sert sans une ligne changée, et tout autre outil local aussi (Hermes compris).
 * Jarod-cordis — nouveau (PLAN §5.1, gate P2).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ecosystemFlags, EmbeddingsConfig, type EmbeddingsMetrics, RerankerConfig, type VoicePriority } from "@jarod/contracts";
import type { Context } from "cordis";
import { type EmbeddingsWorkerEvent, type EmbeddingsWorkerSpawner, EMBEDDINGS_WORKER_PATH, EmbeddingsWorkerError, forkEmbeddingsSpawner, IsolatedEmbeddings } from "./isolated.js";
import { OpenVinoEmbedder } from "./openvino.js";
import { IsolatedReranker, RERANKER_WORKER_PATH, type RerankerWorkerEvent, type RerankerWorkerSpawner } from "./reranker-isolated.js";
import { RerankerService } from "./reranker-service.js";

export * from "./isolated.js";
export * from "./openvino.js";
export * from "./reranker.js";
export * from "./reranker-isolated.js";
export * from "./reranker-service.js";

/** Ce que le service attend d'un moteur d'embeddings : le moteur OpenVINO en processus, ou l'hôte du worker isolé. */
export interface EmbeddingsEngine {
  readonly available: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
  tokens(text: string): Promise<number>;
  warmup(): Promise<void>;
  metrics(): EmbeddingsMetrics;
}

/**
 * Isolation (SPECS-P5-EMBEDDINGS.md) : avec `isolation`, OpenVINO tourne dans un processus dédié, lancé SEULEMENT si `modelDir` et un
 * `port` fixe sont donnés ET que `rag.enabled` est vrai dans le profil (lu au démarrage : un changement demande un redémarrage).
 */
export interface EmbeddingsIsolation {
  /** Lanceur de processus (desktop : `utilityProcess`) ; défaut : `child_process.fork`. */
  spawn?: EmbeddingsWorkerSpawner;
  /** Défaut : `EMBEDDINGS_WORKER_PATH`. */
  script?: string;
  onExit?: (event: EmbeddingsWorkerEvent) => void;
}
/**
 * Reranker (SPECS-P5-RERANKER.md) : worker ISOLÉ séparé de celui des embeddings, lancé SEULEMENT si cette clé est donnée (reranker.json),
 * que `rag.enabled` est vrai ET que `ecosystem.reranker` n'est pas « off » (lus au démarrage : un changement demande un redémarrage).
 */
export type RerankerPluginConfig = RerankerConfig & {
  isolation?: { spawn?: RerankerWorkerSpawner; script?: string; onExit?: (event: RerankerWorkerEvent) => void };
};
export type EmbeddingsPluginConfig = EmbeddingsConfig & { isolation?: EmbeddingsIsolation; reranker?: RerankerPluginConfig };

declare module "cordis" {
  interface Context {
    embeddings: EmbeddingsService;
    /** Présent seulement si la configuration `reranker` est donnée ; peut être inactif (la raison est dans `metrics().lastError`). */
    reranker: RerankerService;
  }
}

/** Taille maximale d'une requête HTTP (les lots de rag.ts font 32 textes). */
const MAX_BODY = 8 * 1024 * 1024;

export const name = "embeddings";
// `passthrough` : la clé `isolation` (lanceur de processus, fonctions) doit traverser le schéma de configuration du plugin.
export const Config = EmbeddingsConfig.passthrough();

/** Asynchrone : le kernel n'est prêt qu'une fois le point d'accès en écoute (un effet async n'est pas attendu). */
export async function apply(ctx: Context, input: EmbeddingsPluginConfig = {}): Promise<void> {
  const cfg = EmbeddingsConfig.parse(input ?? {});
  const logger = ctx.logger("embeddings");
  applyReranker(ctx, input?.reranker);
  if (input?.isolation) return applyIsolated(ctx, cfg, input.isolation);
  const service = new EmbeddingsService(new OpenVinoEmbedder(cfg, (line) => logger.info(line)));
  if (cfg.port !== undefined) {
    const server = createServer((req, res) => void service.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, "127.0.0.1", () => resolve());
    });
    service.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    ctx.effect(() => () => void server.close(), "embeddings:http");
  }
  if (cfg.warmup && service.available) void service.engine.warmup().catch(() => {});
  ctx.provide("embeddings", service);
}

/** Moteur d'un service qui ne tourne pas (isolation demandée mais non lancée) : dit pourquoi, n'échoue jamais en silence. */
class InactiveEngine implements EmbeddingsEngine {
  readonly available = false;
  constructor(private readonly reason: string) {}
  embed(): Promise<Float32Array[]> {
    return Promise.reject(new EmbeddingsWorkerError("EMBEDDINGS_UNAVAILABLE", this.reason));
  }
  tokens(): Promise<number> {
    return Promise.reject(new EmbeddingsWorkerError("EMBEDDINGS_UNAVAILABLE", this.reason));
  }
  async warmup(): Promise<void> {}
  metrics(): EmbeddingsMetrics {
    return { available: false, requested: [], device: {}, attempts: [], calls: 0, texts: 0, p50Ms: null, p95Ms: null, lastError: this.reason };
  }
}

function applyIsolated(ctx: Context, cfg: EmbeddingsConfig, iso: EmbeddingsIsolation): void {
  const logger = ctx.logger("embeddings");
  // `storage` est lu par le contexte RACINE (le plugin ne l'injecte pas : Cordis interdit de lire un service non déclaré) ; il se
  // charge avant ce plugin (ordre 10 contre 35).
  const settings = (ctx.root as unknown as { storage?: { settings: { get(k: "rag"): { enabled: boolean } } } }).storage?.settings;
  const ragOn = settings?.get("rag").enabled === true;
  const { modelDir, port } = cfg;
  let host: IsolatedEmbeddings | null = null;
  let inactive: string | null = null;
  if (!modelDir || port === undefined || port < 1) inactive = "embeddings isolé : modelDir et un port FIXE (≥ 1) sont requis (embeddings.json) ; aucun processus lancé.";
  else if (!ragOn) inactive = "RAG éteint (rag.enabled faux) : worker d'embeddings non lancé ; redémarrer l'application après l'avoir allumé.";
  if (inactive) logger.info(inactive);
  else {
    host = new IsolatedEmbeddings({
      spawn: iso.spawn ?? forkEmbeddingsSpawner(),
      script: iso.script ?? EMBEDDINGS_WORKER_PATH,
      config: { modelDir: modelDir!, port: port!, devices: cfg.devices, queryMaxLength: cfg.queryMaxLength, docMaxLength: cfg.docMaxLength, pooling: cfg.pooling, normalize: cfg.normalize },
      log: (line) => logger.info(line),
      ...(iso.onExit ? { onExit: iso.onExit } : {}),
    });
    host.start();
    const h = host;
    ctx.effect(() => () => void h.stop(), "embeddings:worker");
  }
  const service = new EmbeddingsService(host ?? new InactiveEngine(inactive!), host);
  if (host) service.url = host.url;
  ctx.provide("embeddings", service);
}

/** Le worker du reranker (SPECS-P5-RERANKER.md §2.2) : jamais lancé sans les trois conditions ; sinon un service inactif qui dit pourquoi. */
function applyReranker(ctx: Context, raw: RerankerPluginConfig | undefined): void {
  if (!raw) return;
  const logger = ctx.logger("reranker");
  const { isolation, ...rest } = raw;
  const parsed = RerankerConfig.safeParse(rest);
  const settings = (ctx.root as unknown as { storage?: { settings: { get(k: "rag"): { enabled: boolean }; get(k: "ecosystem"): unknown } } }).storage?.settings;
  const ragOn = settings?.get("rag").enabled === true;
  const flags = ecosystemFlags(settings?.get("ecosystem"));
  // La priorité de la voix est lue PARESSEUSEMENT (le plugin `voice` peut se charger après celui-ci) ; absente = pas de pause.
  const voice = (): VoicePriority | undefined => (ctx.root as unknown as { voice?: { priority?: VoicePriority } }).voice?.priority;
  const voicePriority = parsed.success ? parsed.data.voicePriority : true;
  let host: IsolatedReranker | null = null;
  let inactive: string | null = null;
  if (!parsed.success) inactive = `reranker.json invalide (${parsed.error.issues.map((i) => i.path.join(".") || "(racine)").join(", ")}) ; aucun processus lancé.`;
  else if (!ragOn) inactive = "RAG éteint (rag.enabled faux) : worker du reranker non lancé ; redémarrer l'application après l'avoir allumé.";
  else if (flags.reranker === "off") inactive = "ecosystem.reranker éteint : worker du reranker non lancé ; redémarrer l'application après l'avoir allumé.";
  if (inactive) logger.info(inactive);
  else {
    host = new IsolatedReranker({
      spawn: isolation?.spawn ?? forkEmbeddingsSpawner(),
      script: isolation?.script ?? RERANKER_WORKER_PATH,
      config: parsed.data!,
      log: (line) => logger.info(line),
      ...(isolation?.onExit ? { onExit: isolation.onExit } : {}),
      // La voix est prioritaire (SPECS-P5-RERANKER-PAUSE.md §3) : pas de compilation du modèle pendant une dictée.
      ...(voicePriority ? { beforeLaunch: () => voice()?.whenIdle() ?? Promise.resolve() } : {}),
    });
    host.start();
    const h = host;
    ctx.effect(() => () => void h.stop(), "reranker:worker");
  }
  const shape = parsed.success ? { batch: parsed.data.batch, maxLength: parsed.data.maxLength } : { batch: 8, maxLength: 512 };
  ctx.provide("reranker", new RerankerService(host, shape, inactive, { voice, voicePriority, log: (line) => logger.info(line) }));
}

export class EmbeddingsService {
  /** URL de base OpenAI-compatible (`…/v1`) quand le point d'accès écoute. */
  url: string | null = null;

  constructor(
    readonly engine: EmbeddingsEngine,
    /** Hôte du worker isolé, si le service tourne en mode isolé ; sinon null. */
    readonly host: IsolatedEmbeddings | null = null,
  ) {}

  get available(): boolean {
    return this.engine.available;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this.engine.embed(texts);
  }

  metrics(): EmbeddingsMetrics {
    return this.engine.metrics();
  }

  async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        return reply(200, { object: "list", data: [{ id: "openvino-embeddings", object: "model" }] });
      }
      if (req.method !== "POST" || req.url !== "/v1/embeddings") return reply(404, { error: { message: "introuvable" } });
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return reply(413, { error: { message: "requête trop volumineuse" } });
        chunks.push(c as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: unknown; model?: string };
      const input = typeof body.input === "string" ? [body.input] : body.input;
      if (!Array.isArray(input) || !input.every((t) => typeof t === "string")) {
        return reply(400, { error: { message: "`input` doit être un texte ou une liste de textes" } });
      }
      const vectors = await this.engine.embed(input as string[]);
      let tokens = 0;
      for (const t of input as string[]) tokens += await this.engine.tokens(t);
      return reply(200, {
        object: "list",
        model: body.model ?? "openvino-embeddings",
        data: vectors.map((v, index) => ({ object: "embedding", index, embedding: Array.from(v) })),
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      });
    } catch (e) {
      return reply(500, { error: { message: (e as Error).message } });
    }
  }
}

