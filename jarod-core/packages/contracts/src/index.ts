/**
 * @jarod/contracts — tout ce qui traverse une frontière (plugin ↔ kernel, main ↔ renderer,
 * core ↔ CLI/relay). Zod : validé à l'exécution, typé à la compilation. Les schémas implémentent
 * Standard Schema, donc cordis les accepte tels quels comme `Config` de plugin.
 */
import { z } from "zod";

// ── Voix prioritaire (SPECS-P5-VOIX-PRIORITAIRE.md, validée le 2026-10-01) ──────────────────────────────

/**
 * Priorité de la voix sur le travail de fond (l'ingestion de documents) : la transcription et le calcul des embeddings se
 * disputent l'iGPU (mesuré : +79 % sur la dictée). Fournie par le plugin `voice` (`voice.priority`), lue par `rag`.
 */
export interface VoicePriority {
  /**
   * Vrai de la détection du mot d'activation à la fin de la transcription, et pendant tout appel de transcription
   * (bouton micro, messages vocaux). Faux pendant l'écoute passive du mot d'activation : elle ne compte jamais.
   */
  readonly active: boolean;
  /** Résout dès que la voix n'est plus active (tout de suite si elle ne l'est pas) ; rejette si le signal est abandonné. */
  whenIdle(signal?: AbortSignal): Promise<void>;
}

// ── Stockage ────────────────────────────────────────────────────────────────────────────────────

/** Magasin de clé de la base (DPAPI, Keychain, libsecret, fichier, mémoire) — voir plugin-storage `dbkey.ts`. */
export interface KeyStoreLike {
  readonly id: "dpapi" | "keychain" | "libsecret" | "file" | "memory";
  readonly label: string;
  load(dataDir: string): string | null;
  save(dataDir: string, key: string): void;
}

export const StorageConfig = z.object({
  /** Dossier du profil : `jarod.db`, `db.key.dpapi`, `skills/`, `attachments/`… (identique à Jarod-One). */
  dataDir: z.string().min(1),
  /** Chiffrement de la base (défaut : oui, comme `core.ts:335`). */
  encryptDb: z.boolean().default(true),
  /** Magasins de clé, du plus sûr au repli (défaut : `defaultKeyStores()`). */
  keyStores: z.array(z.custom<KeyStoreLike>((v) => typeof v === "object" && v !== null && "load" in v)).optional(),
  /** Chemin de l'addon SQLite natif (app empaquetée). */
  nativeBinding: z.string().optional(),
  /** Chiffrement des secrets au repos (desktop : safeStorage ; défaut : `plainCipher`, `types.ts`). */
  cipher: z.custom<{ encrypt(plain: string): string; decrypt(encoded: string): string }>((v) => typeof v === "object" && v !== null && "encrypt" in v).optional(),
  /** Taille maximale du journal d'événements (défaut 100 000, `eventstore.ts`). */
  eventsKeep: z.number().int().positive().optional(),
});
export type StorageConfig = z.input<typeof StorageConfig>;

// ── Planification ───────────────────────────────────────────────────────────────────────────────

/** Miroir exact de `ScheduleSpec` (`services/scheduler.ts:6-13`), stocké en JSON dans `schedules.spec`. */
export const ScheduleSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: z.number() }),
  z.object({ kind: z.literal("daily"), time: z.string(), days: z.array(z.number().int()).optional() }),
  z.object({ kind: z.literal("cron"), expr: z.string() }),
  z.object({ kind: z.literal("once"), at: z.number() }),
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

export const DeliveryGateway = z.enum(["telegram", "discord", "slack", "email", "whatsapp"]);
export const ScheduleDelivery = z.object({ gateway: DeliveryGateway, chatId: z.string() });
export type ScheduleDelivery = z.infer<typeof ScheduleDelivery>;

/** Ce que le planificateur passe à l'exécutant (`Schedule`, `services/scheduler.ts:23`). */
export const ScheduleDto = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  spec: ScheduleSpec,
  sessionId: z.string().nullable(),
  enabled: z.boolean(),
  lastRun: z.number().nullable(),
  nextRun: z.number().nullable(),
  lastStatus: z.string().nullable(),
  deliver: ScheduleDelivery.nullable(),
  createdAt: z.number(),
  /** Mode imposé à ce tour seulement (automation : « plan » par défaut) ; absent = mode de la conversation. */
  mode: z.enum(["plan", "build"]).optional(),
});
export type ScheduleDto = z.infer<typeof ScheduleDto>;

export const ScheduleRunResult = z.object({ sessionId: z.string(), ok: z.boolean(), summary: z.string() });
export type ScheduleRunResult = z.infer<typeof ScheduleRunResult>;

export const JobStatus = z.enum(["pending", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const SchedulerConfig = z.object({
  /** Période du tick (défaut 30 s, `scheduler.ts:235`). */
  tickMs: z.number().int().positive().default(30_000),
  /** Démarre le tick au chargement (les tirs manqués partent une fois au démarrage). */
  autoStart: z.boolean().default(true),
});
export type SchedulerConfig = z.input<typeof SchedulerConfig>;

// ── Automation (SPECS-P5-AUTOMATION.md) ───────────────────────────────────────────────────────────

export const AutomationTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cron: z.string() }),
  z.object({ kind: z.literal("webhook"), hookId: z.string() }),
  z.object({ kind: z.literal("manual") }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), prompt: z.string(), sessionId: z.string().optional(), mode: z.enum(["plan", "build"]).optional() }),
  z.object({ type: z.literal("notify"), title: z.string(), body: z.string() }),
  z.object({ type: z.literal("webhook"), url: z.string(), payload: z.unknown() }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationRule = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: AutomationTrigger,
  actions: z.array(AutomationAction),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

export const AutomationCreateInput = z.object({
  name: z.string().min(1),
  trigger: AutomationTrigger,
  actions: z.array(AutomationAction).min(1),
  enabled: z.boolean().default(true),
});
export type AutomationCreateInput = z.input<typeof AutomationCreateInput>;

export const AutomationUpdateInput = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  trigger: AutomationTrigger.optional(),
  actions: z.array(AutomationAction).optional(),
});
export type AutomationUpdateInput = z.input<typeof AutomationUpdateInput>;

export const AutomationListResponse = z.object({
  rules: z.array(AutomationRule),
});
export type AutomationListResponse = z.infer<typeof AutomationListResponse>;

export const AutomationRunResult = z.object({
  ok: z.boolean(),
  jobId: z.string().optional(),
  error: z.string().optional(),
});
export type AutomationRunResult = z.infer<typeof AutomationRunResult>;

// ── Embeddings (NPU, OpenVINO) ──────────────────────────────────────────────────────────────────

export const EmbeddingsConfig = z.object({
  /** Dossier du modèle OpenVINO IR exporté (`optimum-cli export openvino`, ex. bge-m3 INT8). Absent : service indisponible. */
  modelDir: z.string().optional(),
  /** Ordre d'essai des périphériques (PLAN §7.3) : le premier qui compile sert, l'effectif est journalisé. */
  devices: z.array(z.string()).default(["NPU", "GPU.0", "CPU"]),
  /** Forme statique « requêtes » (NPU : formes fixes) et forme « documents », en tokens. */
  queryMaxLength: z.number().int().positive().default(128),
  docMaxLength: z.number().int().positive().default(512),
  /** Mise en commun et normalisation du modèle (bge-m3 : CLS + L2). */
  pooling: z.enum(["cls", "mean"]).default("cls"),
  normalize: z.boolean().default(true),
  /** Point d'accès OpenAI-compatible `/v1/embeddings` sur 127.0.0.1 (0 = port libre, absent = aucun). */
  port: z.number().int().min(0).max(65535).optional(),
  /** Compiler au démarrage plutôt qu'au premier appel (le CLI ne doit pas payer 13-30 s). */
  warmup: z.boolean().default(false),
});
export type EmbeddingsConfig = z.input<typeof EmbeddingsConfig>;

/** Ce que `ctx.embeddings.metrics()` rapporte : la preuve de l'exécution réelle (gate P2). */
export interface EmbeddingsMetrics {
  available: boolean;
  requested: string[];
  /** Périphérique effectif par forme (`128`, `512`) ; absent tant que la forme n'a pas été compilée. */
  device: Record<string, string>;
  /**
   * `probe` (Q7) : sonde passée par un périphérique hors CPU — `1 − cosinus` max vs CPU, taille du top-k
   * dont l'ordre est identique au CPU, et plus petit écart de score entre voisins consécutifs sur le CPU.
   */
  attempts: { shape: number; device: string; ok: boolean; ms: number; error?: string; probe?: { cosineGap: number; topK: number; margin: number } }[];
  calls: number;
  texts: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lastError: string | null;
}

// ── Permissions ─────────────────────────────────────────────────────────────────────────────────

/** Une règle du garde unifié (portage SANK-AI `agent-host.mjs:36-56`) : `tool` = nom, segment (`fs` → `fs_*`) ou `*`. */
// Cockpit, lot 2 : `target` (motif de cible, `*` = toute suite, casse et séparateurs de chemin ignorés) et `expiresAt` (autorisation
// temporaire, en ms depuis l'époque ; échue, la règle ne joue plus). Les deux sont optionnels : une règle sans eux se lit comme avant.
// Autonomie configurable (2026-10-21) : `autonomous` (avec `allow` seulement) dispense de l'accord DANS le périmètre de la règle ; `operation`
// (motif sur l'opération que l'outil déclare, `ToolDef.operationOf`), `session` (une conversation, une mission) et `uses` (appels restants)
// bornent ce périmètre ; `id`, `note`, `createdAt` et `by` servent à lister, expliquer et révoquer. Tous optionnels : une règle sans eux se lit
// comme avant, et un `allow` sans `autonomous` laisse l'accord des outils sensibles s'appliquer.
export const PermissionRule = z
  .object({
    tool: z.string().min(1),
    decision: z.enum(["allow", "ask", "deny"]),
    target: z.string().min(1).max(260).optional(),
    expiresAt: z.number().int().positive().optional(),
    autonomous: z.literal(true).optional(),
    operation: z.string().min(1).max(64).optional(),
    session: z.string().min(1).max(128).optional(),
    uses: z.number().int().min(0).max(100_000).optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{3,39}$/).optional(),
    note: z.string().max(200).optional(),
    createdAt: z.number().int().positive().optional(),
    by: z.enum(["réglages", "commande"]).optional(),
  })
  .refine((r) => r.autonomous === undefined || r.decision === "allow", { message: "« autonomous » ne s'emploie qu'avec « allow »", path: ["autonomous"] });
export type PermissionRule = z.infer<typeof PermissionRule>;
export type PermissionDecision = PermissionRule["decision"];

export const PermissionsConfig = z.object({
  /** Évaluées dans l'ordre, première qui couvre l'outil gagne ; puis « outil déclaré → allow », puis `* → deny`. */
  rules: z.array(PermissionRule).default([]),
});
export type PermissionsConfig = z.input<typeof PermissionsConfig>;

// ── Passerelles de messagerie ───────────────────────────────────────────────────────────────────

/** Miroir exact de `GatewayStatus` (`services/telegram.ts:3-8`) : ce que l'écran Passerelles affiche. */
export const GatewayStatus = z.object({
  id: DeliveryGateway,
  state: z.enum(["stopped", "running", "error"]),
  error: z.string().optional(),
  botName: z.string().optional(),
});
export type GatewayStatus = z.infer<typeof GatewayStatus>;

export const GatewaysConfig = z.object({
  /** Démarre les passerelles activées au chargement — les `sync*()` de `init()` (`core.ts:684-688`). */
  autoStart: z.boolean().default(true),
  /** Crochets de test de `CoreOptions` (`core.ts:133-140`) : bases d'API alternatives. */
  telegramApiBase: z.string().optional(),
  discordApiBase: z.string().optional(),
  slackApiBase: z.string().optional(),
  whatsappApiBase: z.string().optional(),
});
export type GatewaysConfig = z.input<typeof GatewaysConfig>;

// ── Kernel ──────────────────────────────────────────────────────────────────────────────────────

export const JarodConfig = z.object({
  /** Dossier des plugins locaux (défaut : `packages/plugins`). Jamais un registre distant. */
  pluginsDir: z.string().optional(),
  /** Section de config par plugin ; `false` désactive le plugin. */
  plugins: z.record(z.string(), z.union([z.literal(false), z.record(z.string(), z.unknown())])).default({}),
});
export type JarodConfig = z.input<typeof JarodConfig>;

/**
 * Événements kernel (PLAN §1). `schedule/run` est un point d'extension (`ctx.serial`) : le premier
 * écouteur qui rend un résultat exécute le tir ; `schedule:fired` est une notification.
 */
export interface KernelEvents {
  /** V-17 : `beat` = signe de vie de l'exécution, à appeler pendant le travail (le planificateur repousse alors son bail). */
  "schedule/run"(schedule: ScheduleDto, beat?: () => void): Promise<ScheduleRunResult | undefined> | ScheduleRunResult | undefined;
  "schedule:fired"(schedule: ScheduleDto, result: ScheduleRunResult): void;
  /** Une passerelle change d'état (`core.emit("gateway", st)`, `core.ts:1004-1017`…). */
  "gateway:status"(status: GatewayStatus): void;
  "kernel:ready"(): void;
  /** Mot d'activation détecté (plugin-voice, PLAN §5.3) : `atMs` = position dans le flux audio. */
  "voice:wake"(detection: { model: string; score: number; atMs: number }): void;
  /** Capture continue (plugin-voice `capture.ts`) : écoute → enregistrement → transcription. */
  "voice:state"(state: "listening" | "recording" | "transcribing", info?: { reason?: string }): void;
  /** Commande vocale transcrite après le mot d'activation (PLAN §1 : `voice:transcript`). */
  "voice:transcript"(transcript: {
    text: string;
    wake: { model: string; score: number; atMs: number };
    audioMs: number;
    sttMs: number;
  }): void;
  /** Échec de la capture (détecteur, whisper-server, transcription) : jamais avalé en silence. */
  "voice:error"(error: { message: string }): void;
  /** Nouvelle version trouvée par plugin-updates (canal distant, ou dossier local en repli). */
  "update:available"(
    candidate: { source: "remote"; version: string; releaseNotes: string | null } | { source: "local"; version: string; installer: string; builtAt: number },
  ): void;
  /** Vérification périodique en échec (autre chose qu'un flux injoignable). */
  "update:error"(error: { message: string }): void;
}

// ── Domaine & réglages (portages verbatim, voir en-têtes) ───────────────────────────────────────
export * from "./auto-improvement-config.js";
export * from "./domain.js";
export * from "./browser.js";
export * from "./settings.js";
export * from "./llm.js";
export * from "./secrets.js";
export * from "./ecosystem.js";
