/**
 * G2 — traces LOCALES par le SDK OpenTelemetry JS (open-telemetry/opentelemetry-js) : tour de conversation → appel au modèle → appel
 * d'outil (attente d'accord, exécution, annulation), corrélés par trace et parent.
 *
 *  - Destination : des fichiers JSONL dans `<profil>/traces/` ; AUCUN exporteur réseau n'est construit ici, aucun fournisseur global
 *    n'est enregistré (`trace.setGlobalTracerProvider` n'est jamais appelé : une bibliothèque tierce ne peut pas s'y brancher).
 *  - Contenu : l'épurateur R3 (`scrubAttributes`, liste blanche par nom ET par forme) s'applique deux fois — au début de la trace et à
 *    l'export ; un nom de trace hors de `SPAN_NAMES` n'est pas écrit. Jamais un argument, un prompt, une réponse ni un chemin.
 *  - Réglage `localTraces` relu à CHAQUE trace : éteint = rien n'est mesuré ni écrit. Rotation par taille, rétention par âge et par
 *    nombre de fichiers ; seuls les fichiers `spans-AAAAMMJJ-N.jsonl` de ce dossier sont jamais supprimés.
 *
 * L'exporteur local n'existe pas tel quel dans le SDK : il est écrit et testé ici (exporteur JSONL + `SimpleSpanProcessor`).
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, type ReadableSpan, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { SPAN_NAMES, scrubAttributes } from "../telemetry.js";

export interface LocalTracesConfig {
  enabled: boolean;
  /** Fichiers plus anciens supprimés (jours, ≥ 1). */
  retentionDays: number;
  /** Taille d'un fichier avant rotation (octets). */
  maxFileBytes: number;
  /** Nombre maximal de fichiers gardés (les plus anciens partent d'abord). */
  maxFiles: number;
}

export const DEFAULT_LOCAL_TRACES: LocalTracesConfig = { enabled: false, retentionDays: 7, maxFileBytes: 5 * 1024 * 1024, maxFiles: 20 };

/** Valeurs bornées : une configuration absurde ne remplit pas le disque et n'efface pas tout. */
export function normalizeTracesConfig(raw: unknown): LocalTracesConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof LocalTracesConfig, unknown>>;
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : d);
  return {
    enabled: r.enabled === true,
    retentionDays: num(r.retentionDays, DEFAULT_LOCAL_TRACES.retentionDays, 1, 90),
    maxFileBytes: num(r.maxFileBytes, DEFAULT_LOCAL_TRACES.maxFileBytes, 64 * 1024, 50 * 1024 * 1024),
    maxFiles: num(r.maxFiles, DEFAULT_LOCAL_TRACES.maxFiles, 1, 200),
  };
}

/** Une ligne écrite : ce qu'un lecteur du fichier voit, et rien de plus. */
export interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Début, en ms depuis l'époque. */
  start: number;
  durationMs: number;
  status: "ok" | "error" | "denied" | "cancelled";
  attributes: Record<string, string | number>;
  /** Attributs écartés par l'épurateur (compte seulement). */
  dropped: number;
}

const FILE = /^spans-(\d{8})-(\d+)\.jsonl$/;
const KNOWN = new Set<string>(SPAN_NAMES);
const hrMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

export function toRecord(span: ReadableSpan): SpanRecord | null {
  if (!KNOWN.has(span.name)) return null;
  const { attributes, dropped } = scrubAttributes(span.attributes as Record<string, unknown>);
  const raw = attributes.status;
  const status = raw === "denied" || raw === "cancelled" || raw === "error" ? raw : span.status.code === SpanStatusCode.ERROR ? "error" : "ok";
  delete attributes.status;
  const ctx = span.spanContext();
  const parent = (span as ReadableSpan & { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId;
  return {
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(parent ? { parentSpanId: parent } : {}),
    start: Math.round(hrMs(span.startTime)),
    durationMs: Math.max(0, Math.round((hrMs(span.endTime) - hrMs(span.startTime)) * 1000) / 1000),
    status,
    attributes,
    dropped,
  };
}

/** Exporteur JSONL local, avec rotation et rétention. N'ouvre aucune connexion. */
export class JsonlSpanExporter implements SpanExporter {
  private stopped = false;
  constructor(
    private readonly dir: string,
    private readonly config: () => LocalTracesConfig,
    private readonly now: () => number = Date.now,
  ) {}

  export(spans: ReadableSpan[], done: (result: { code: number; error?: Error }) => void): void {
    if (this.stopped) return done({ code: 1, error: new Error("exporteur arrêté") });
    try {
      const cfg = this.config();
      if (!cfg.enabled) return done({ code: 0 });
      const lines = spans.map(toRecord).filter((r): r is SpanRecord => r !== null).map((r) => `${JSON.stringify(r)}\n`);
      if (lines.length) {
        mkdirSync(this.dir, { recursive: true });
        for (const line of lines) appendFileSync(this.target(cfg, Buffer.byteLength(line)), line);
        this.prune(cfg);
      }
      done({ code: 0 });
    } catch (e) {
      done({ code: 1, error: e as Error });
    }
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, "");
  }

  /** Le fichier du jour qui a encore la place ; sinon le suivant (rotation). */
  private target(cfg: LocalTracesConfig, bytes: number): string {
    const day = this.day();
    const today = this.files().filter((f) => f.day === day);
    const last = today.at(-1);
    if (last && last.size + bytes <= cfg.maxFileBytes) return join(this.dir, last.name);
    return join(this.dir, `spans-${day}-${last ? last.n + 1 : 1}.jsonl`);
  }

  files(): { name: string; day: string; n: number; size: number; mtime: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => ({ name, m: FILE.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
      .map(({ name, m }) => {
        const st = statSync(join(this.dir, name));
        return { name, day: m[1]!, n: Number(m[2]), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.n - b.n);
  }

  private prune(cfg: LocalTracesConfig): void {
    const cutoff = new Date(this.now() - cfg.retentionDays * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    let files = this.files();
    for (const f of files) if (f.day < cutoff) unlinkSync(join(this.dir, f.name));
    files = this.files();
    for (const f of files.slice(0, Math.max(0, files.length - cfg.maxFiles))) unlinkSync(join(this.dir, f.name));
  }
}

/** Ce que l'agent attend (voir `SpanSink` de plugin-agent) : redéclaré par sa forme pour ne pas dépendre du paquet. */
export type LocalSpanStatus = "ok" | "error" | "denied" | "cancelled";
export interface LocalSpanHandle {
  set(attributes: Record<string, string | number>): void;
  end(status: LocalSpanStatus): void;
}

const NOOP: LocalSpanHandle = { set: () => {}, end: () => {} };

export interface LocalTraces {
  sink: { start(name: string, attributes: Record<string, string | number>, parent?: LocalSpanHandle): LocalSpanHandle };
  exporter: JsonlSpanExporter;
  shutdown(): Promise<void>;
}

/** Le récepteur de traces de Jarod : un fournisseur OpenTelemetry PRIVÉ (non global), un exporteur JSONL, le réglage relu à chaque trace. */
export function createLocalTraces(o: { dir: string; config: () => LocalTracesConfig; now?: () => number }): LocalTraces {
  const exporter = new JsonlSpanExporter(o.dir, o.config, o.now);
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer("jarod-os", "1");
  const spans = new WeakMap<LocalSpanHandle, Span>();
  return {
    exporter,
    sink: {
      start(name, attributes, parent) {
        if (!o.config().enabled || !KNOWN.has(name)) return NOOP;
        const parentSpan = parent ? spans.get(parent) : undefined;
        const ctx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
        const span = tracer.startSpan(name, { attributes: scrubAttributes(attributes).attributes }, ctx);
        let ended = false;
        const handle: LocalSpanHandle = {
          set: (a) => {
            if (!ended) span.setAttributes(scrubAttributes(a).attributes);
          },
          end: (status) => {
            if (ended) return;
            ended = true;
            span.setAttribute("status", status);
            if (status === "error") span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
          },
        };
        spans.set(handle, span);
        return handle;
      },
    },
    shutdown: () => provider.shutdown(),
  };
}
