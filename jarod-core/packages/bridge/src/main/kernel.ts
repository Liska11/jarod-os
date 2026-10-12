/**
 * Ouverture du kernel pour le desktop : portage de `Jarod-one/packages/desktop/src/main/index.ts:206-243`
 * (`openCore`, rév. 2e180305) — `new JarodCore(...)` + `init()` → kernel cordis démarré avec TOUS les
 * plugins découverts, en configuration complète (verrou du profil en mode « desktop », graines, tick
 * planifié, MCP, curator, passerelles activées). Même dossier de données que le CLI (`defaultDataRoot`).
 * Sans Electron : le chiffrement des secrets (`Cipher`) est fourni par l'appelant (safeStorage).
 * Voix (W10) : config du plugin voice lue dans `voice.json` du profil (ou `JAROD_VOICE_CONFIG`) — chemins
 * EXPLICITES (whisper-server, modèle, modèles openWakeWord), jamais devinés ; absent = pas de capture.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BrowserPort, Cipher } from "@jarod/contracts";
import { discoverPlugins, JarodApp, type Started, start, stop } from "@jarod/kernel";
import type { AgentRuntime } from "@jarod/plugin-agent";
import type { GatewayHub } from "@jarod/plugin-gateways";
import { type PersonaService, ProfileManager } from "@jarod/plugin-persona";
import type { Scheduler } from "@jarod/plugin-scheduler";
import type { UpdateService } from "@jarod/plugin-updates";
import type { IsolateSpawner } from "@jarod/plugin-workflows";
import type { VoiceConfig, VoiceService, WorkerExitEvent, WorkerSpawner } from "@jarod/plugin-voice";
import type { AutomationService } from "@jarod/plugin-automation";
import type { EmbeddingsExitEvent } from "./embeddings-journal.js";
import type { DesktopKernel } from "./handlers/context.js";
import type { PermissionsService } from "@jarod/plugin-permissions";

export interface OpenedKernel extends DesktopKernel {
  app: JarodApp;
  dataDir: string;
  dispose(): Promise<void>;
}

export interface OpenKernelOptions {
  dataRoot: string;
  cipher: Cipher;
  appVersion: string;
  /**
   * AV2-001 : dossier des plugins. En développement, `discoverPlugins()` lit `packages/plugins`
   * (calculé depuis `registry.ts`) ; dans une application EMPAQUETÉE, les plugins sont les bundles
   * posés à côté du main (`<app>/out/plugins`) et ce chemin est le seul qui existe. Absent : la
   * découverte du dépôt (le comportement de toujours).
   */
  pluginsDir?: string;
  /** Profil à ouvrir (défaut : le profil actif du `ProfileManager`). */
  profile?: string;
  /**
   * Mode test e2e (`JAROD_TEST_MODE=1` + `JAROD_TEST_PROVIDER_URL`, index.ts:58-59,232-241 de la source) :
   * fournisseur stub OpenAI-compatible, passerelles et minuteurs coupés. Opt-in par l'environnement seul.
   */
  testProvider?: { baseUrl: string; model: string };
  /**
   * Navigateur de l'agent (SPECS-P5-UI-PARITE.md §6) : le port que l'hôte Electron fournit ; les outils `browser_*` n'existent qu'avec lui.
   * Détaché (et fermé) avec le kernel.
   */
  browser?: BrowserPort;
  /**
   * Mode test seulement (avec `testProvider`) : API Bot Telegram locale (`JAROD_TEST_TELEGRAM_API`, stub de l'e2e).
   * En mode test, Telegram n'atteint JAMAIS api.telegram.org : sans stub, adresse locale injoignable.
   */
  testTelegramApiBase?: string;
  /** Fichier de config du plugin voice (défaut : `<profil>/voice.json`). */
  voiceConfigPath?: string;
  /** Fichier de config du plugin rag (défaut : `<profil>/rag.json`) : sidecar du mode fantôme (PLAN §10 phase 1). */
  ragConfigPath?: string;
  /** Fichier de config des embeddings isolés (défaut : `<profil>/embeddings.json`, SPECS-P5-EMBEDDINGS.md). */
  embeddingsConfigPath?: string;
  /** Lanceur du worker d'embeddings (desktop : `utilityProcess`, Q1) ; absent : `child_process.fork`. */
  embeddingsSpawner?: WorkerSpawner;
  /** Observateur des arrêts du worker d'embeddings (desktop : journal JSONL). */
  embeddingsOnExit?: (event: EmbeddingsExitEvent) => void;
  /** Fichier de config du reranker isolé (défaut : `<profil>/reranker.json`, SPECS-P5-RERANKER.md). */
  rerankerConfigPath?: string;
  /** Lanceur du worker du reranker (desktop : `utilityProcess`) ; absent : `child_process.fork`. */
  rerankerSpawner?: WorkerSpawner;
  /** Observateur des arrêts du worker du reranker (desktop : journal JSONL). */
  rerankerOnExit?: (event: EmbeddingsExitEvent) => void;
  /** Dossier d'installeurs par défaut (`JAROD_RELEASE_DIR`, source index.ts:212). */
  updateFolder?: string;
  /** Lanceur des plugins utilisateur isolés (desktop : `utilityProcess`, voir `isolate.ts`). */
  pluginSpawner?: IsolateSpawner;
  /** Lanceur du processus dédié du mot d'activation (desktop : `utilityProcess`, Q9) ; absent : dans le main. */
  wakewordSpawner?: WorkerSpawner;
  /** Observateur des arrêts de ce processus (desktop : fil de déclenchement Q9, `wakeword-tripwire.ts`). */
  wakewordOnExit?: (event: WorkerExitEvent) => void;
}

/** `voice.json` : un objet (sections `whisper`, `wakeword`, `capture`, `piper` du plugin voice). */
export function readVoiceConfig(file: string): VoiceConfig | null {
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} : un objet JSON est attendu`);
  return v as VoiceConfig;
}

/**
 * `rag.json` : `{ "turbovec": { "bin": "<chemin absolu du sidecar>" } }` — chemin EXPLICITE, jamais deviné.
 * Absent : pas de mode fantôme. Le fantôme ne tourne ensuite que si le profil pose `ecosystem.vectorShadow`.
 */
export function readRagConfig(file: string): { turbovec?: { bin: string } } | null {
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, "utf8")) as { turbovec?: { bin?: unknown } } | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} : un objet JSON est attendu`);
  if (v.turbovec === undefined) return {};
  const bin = v.turbovec?.bin;
  if (typeof bin !== "string" || !isAbsolute(bin)) throw new Error(`${file} : turbovec.bin doit être un chemin absolu`);
  return { turbovec: { bin } };
}

/** `embeddings.json` (SPECS-P5-EMBEDDINGS.md §3.1) : le modèle d'embeddings et le port FIXE de son worker isolé. */
export interface EmbeddingsFileConfig {
  modelDir: string;
  port: number;
  devices?: string[];
}

/**
 * `embeddings.json` : `{ "modelDir": "<chemin absolu>", "port": <1-65535>, "devices"?: ["NPU", …] }` — chemins et port EXPLICITES,
 * jamais devinés. Absent : null (rien ne démarre, comportement d'avant). Toute valeur douteuse est refusée nettement.
 */
export function readEmbeddingsConfig(file: string): EmbeddingsFileConfig | null {
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} : un objet JSON est attendu`);
  const { modelDir, port, devices } = v;
  if (typeof modelDir !== "string" || !isAbsolute(modelDir)) throw new Error(`${file} : modelDir doit être un chemin absolu`);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${file} : port doit être un entier de 1 à 65535`);
  if (devices !== undefined && (!Array.isArray(devices) || devices.length === 0 || devices.some((d) => typeof d !== "string" || !d))) {
    throw new Error(`${file} : devices doit être une liste non vide de noms de périphériques`);
  }
  return { modelDir, port, ...(devices ? { devices: devices as string[] } : {}) };
}

/** `reranker.json` (SPECS-P5-RERANKER.md §2.1) : l'IR à formes statiques, le port FIXE du worker isolé et, au besoin, le lot, la longueur et les appareils. */
export interface RerankerFileConfig {
  modelDir: string;
  port: number;
  batch?: number;
  maxLength?: number;
  devices?: string[];
  /** SPECS-P5-RERANKER-PAUSE.md : faux = pas de pause pendant la dictée (condition TÉMOIN du banc) ; défaut vrai. */
  voicePriority?: boolean;
}

/**
 * `reranker.json` : `{ "modelDir": "<chemin absolu de l'IR figée>", "port": <1-65535>, "batch"?: n, "maxLength"?: n, "devices"?: [...] }` —
 * chemins et port EXPLICITES, jamais devinés. Absent : null (rien ne démarre). Toute valeur douteuse ou clé inconnue est refusée nettement.
 */
export function readRerankerConfig(file: string): RerankerFileConfig | null {
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} : un objet JSON est attendu`);
  const known = new Set(["modelDir", "port", "batch", "maxLength", "devices", "voicePriority"]);
  for (const key of Object.keys(v)) if (!known.has(key)) throw new Error(`${file} : clé inconnue « ${key} »`);
  const { modelDir, port, batch, maxLength, devices, voicePriority } = v;
  if (typeof modelDir !== "string" || !isAbsolute(modelDir)) throw new Error(`${file} : modelDir doit être un chemin absolu`);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${file} : port doit être un entier de 1 à 65535`);
  if (voicePriority !== undefined && typeof voicePriority !== "boolean") throw new Error(`${file} : voicePriority doit être un booléen`);
  for (const [name, val] of [["batch", batch], ["maxLength", maxLength]] as const) {
    if (val !== undefined && (typeof val !== "number" || !Number.isInteger(val) || val < 1)) throw new Error(`${file} : ${name} doit être un entier positif`);
  }
  if (devices !== undefined && (!Array.isArray(devices) || devices.length === 0 || devices.some((d) => typeof d !== "string" || !d))) {
    throw new Error(`${file} : devices doit être une liste non vide de noms de périphériques`);
  }
  return {
    modelDir,
    port,
    ...(batch !== undefined ? { batch: batch as number } : {}),
    ...(maxLength !== undefined ? { maxLength: maxLength as number } : {}),
    ...(devices ? { devices: devices as string[] } : {}),
    ...(voicePriority !== undefined ? { voicePriority } : {}),
  };
}

/**
 * Les services du kernel que les handlers atteignent, lus sur une application cordis DÉJÀ démarrée (par `openDesktopKernel` ou, dans Jarod-OS, par
 * `openCore` du CLI). Plugin absent = service absent = canaux correspondants en échec nommé, jamais un succès apparent.
 */
export function desktopKernelOf(app: JarodApp, where: { profile: string; dataRoot: string }): DesktopKernel {
  const k = app as unknown as {
    agent: AgentRuntime;
    scheduler: Scheduler;
    gateways: GatewayHub;
    persona?: PersonaService;
    voice?: VoiceService;
    updates?: UpdateService;
    mcp?: DesktopKernel["mcp"];
    skillsHub?: DesktopKernel["skillsHub"];
    memory?: { portability: NonNullable<DesktopKernel["portability"]> };
    storage?: NonNullable<DesktopKernel["storage"]>;
    kanban?: NonNullable<DesktopKernel["kanban"]>;
    rag?: { rag: NonNullable<DesktopKernel["rag"]> };
    pluginHost?: DesktopKernel["pluginHost"];
    automation?: AutomationService;
    tools?: { sshHosts?: DesktopKernel["sshHosts"] };
    llm?: { engine: NonNullable<DesktopKernel["localEngine"]>["engine"]; localModels?: NonNullable<DesktopKernel["localEngine"]>["models"]; detectHardware(): ReturnType<NonNullable<DesktopKernel["localEngine"]>["hardware"]> };
    permissions?: PermissionsService;
  };
  return {
    agent: k.agent,
    scheduler: k.scheduler,
    gateways: k.gateways,
    ...(k.persona ? { persona: k.persona } : {}),
    ...(k.voice ? { voice: k.voice } : {}),
    ...(k.updates ? { updates: k.updates } : {}),
    ...(k.mcp ? { mcp: k.mcp } : {}),
    ...(k.skillsHub ? { skillsHub: k.skillsHub } : {}),
    ...(k.memory ? { portability: k.memory.portability } : {}),
    ...(k.storage ? { storage: k.storage } : {}),
    ...(k.kanban ? { kanban: k.kanban } : {}),
    ...(k.rag ? { rag: k.rag.rag } : {}),
    ...(k.pluginHost ? { pluginHost: k.pluginHost } : {}),
    ...(k.automation ? { automation: k.automation } : {}),
    ...(k.tools?.sshHosts ? { sshHosts: k.tools.sshHosts } : {}),
    ...(k.permissions ? { permissions: k.permissions } : {}),
    ...(k.llm ? { localEngine: { engine: k.llm.engine, ...(k.llm.localModels ? { models: k.llm.localModels } : {}), hardware: () => k.llm!.detectHardware() } } : {}),
    profile: where.profile,
    dataRoot: where.dataRoot,
  };
}

export async function openDesktopKernel(o: OpenKernelOptions): Promise<OpenedKernel> {
  const profiles = new ProfileManager(o.dataRoot);
  const profile = o.profile ?? profiles.active();
  const dataDir = profiles.dirFor(profile);
  const plugins: Record<string, Record<string, unknown>> = {};
  const entries = discoverPlugins(o.pluginsDir);
  // AV2-001 : un paquet dont les plugins manquent doit ÉCHOUER ICI, en le disant — jamais démarrer
  // avec zéro plugin et tomber plus loin sur un `ctx.agent` absent.
  if (o.pluginsDir && entries.length === 0) throw new Error(`Aucun plugin dans ${o.pluginsDir} : le paquet est incomplet.`);
  for (const p of entries) plugins[p.name] = {};
  plugins.storage = { dataDir, cipher: o.cipher };
  plugins.agent = { runtimeMode: "desktop", appVersion: o.appVersion };
  const voice = readVoiceConfig(o.voiceConfigPath ?? join(dataDir, "voice.json"));
  const rag = readRagConfig(o.ragConfigPath ?? join(dataDir, "rag.json"));
  if (rag?.turbovec) plugins.rag = { turbovec: rag.turbovec };
  // Embeddings : `embeddings.json` → worker ISOLÉ (lancé par le plugin seulement si `rag.enabled`) et URL par défaut du RAG déduite
  // du port FIXE ; sans le fichier, rien ne change.
  const emb = readEmbeddingsConfig(o.embeddingsConfigPath ?? join(dataDir, "embeddings.json"));
  if (emb) {
    plugins.embeddings = {
      modelDir: emb.modelDir,
      port: emb.port,
      ...(emb.devices ? { devices: emb.devices } : {}),
      isolation: { ...(o.embeddingsSpawner ? { spawn: o.embeddingsSpawner } : {}), ...(o.embeddingsOnExit ? { onExit: o.embeddingsOnExit } : {}) },
    };
    plugins.rag = { ...(plugins.rag ?? {}), embeddingsDefaultUrl: `http://127.0.0.1:${emb.port}/v1` };
  }
  // Reranker : `reranker.json` → worker ISOLÉ SÉPARÉ (lancé par le plugin seulement si `rag.enabled` ET `ecosystem.reranker` allumé) ; il vit dans
  // le même paquet que les embeddings mais ne dépend pas de `embeddings.json`. Sans le fichier, rien ne change.
  const rerankerCfg = readRerankerConfig(o.rerankerConfigPath ?? join(dataDir, "reranker.json"));
  if (rerankerCfg) {
    plugins.embeddings = {
      ...(plugins.embeddings ?? {}),
      reranker: {
        ...rerankerCfg,
        isolation: { ...(o.rerankerSpawner ? { spawn: o.rerankerSpawner } : {}), ...(o.rerankerOnExit ? { onExit: o.rerankerOnExit } : {}) },
      },
    };
  }
  if (voice) plugins.voice = { ...voice, ...(o.wakewordSpawner ? { wakewordIsolation: { spawn: o.wakewordSpawner, ...(o.wakewordOnExit ? { onExit: o.wakewordOnExit } : {}) } } : {}) };
  // Mises à jour : vérification périodique hors mode test (source index.ts:430-439 : 15 s puis 10 min).
  if (o.pluginSpawner) plugins.workflows = { spawn: o.pluginSpawner };
  plugins.updates = { appVersion: o.appVersion, timer: !o.testProvider, ...(o.updateFolder ? { updateFolder: o.updateFolder } : {}) };
  if (o.testProvider) {
    plugins.gateways = { autoStart: false, telegramApiBase: o.testTelegramApiBase ?? "http://127.0.0.1:9" };
    plugins.scheduler = { autoStart: false };
    plugins.mcp = { autoSync: false };
    plugins.agent = { ...plugins.agent, curatorTimer: false };
  }
  const app = new JarodApp({ plugins, ...(o.pluginsDir ? { pluginsDir: o.pluginsDir } : {}) });
  const started: Started = await start(app);
  const detachBrowser = o.browser ? (app as unknown as { tools?: { attachBrowser(p: BrowserPort): () => void } }).tools?.attachBrowser(o.browser) : undefined;
  const k = app as unknown as {
    agent: AgentRuntime;
    scheduler: Scheduler;
    gateways: GatewayHub;
    persona?: PersonaService;
    voice?: VoiceService;
    updates?: UpdateService;
    mcp?: DesktopKernel["mcp"];
    skillsHub?: DesktopKernel["skillsHub"];
    memory?: { portability: NonNullable<DesktopKernel["portability"]> };
    storage?: NonNullable<DesktopKernel["storage"]>;
    kanban?: NonNullable<DesktopKernel["kanban"]>;
    rag?: { rag: NonNullable<DesktopKernel["rag"]> };
    pluginHost?: DesktopKernel["pluginHost"];
    automation?: AutomationService;
    tools?: { sshHosts?: DesktopKernel["sshHosts"] };
    llm?: { engine: NonNullable<DesktopKernel["localEngine"]>["engine"]; localModels?: NonNullable<DesktopKernel["localEngine"]>["models"]; detectHardware(): ReturnType<NonNullable<DesktopKernel["localEngine"]>["hardware"]> };
    permissions?: PermissionsService;
  };
  // Initialise le chargement à chaud des règles de permissions depuis le storage
  k.permissions?.initStorage?.(k.agent.settings);
  if (o.testProvider) {
    const { baseUrl, model } = o.testProvider;
    k.agent.settings.patch({
      activeProvider: "custom",
      activeModel: model,
      providerOverrides: { custom: { baseUrl, models: [model] } },
      updates: { ...k.agent.settings.get("updates"), autoCheck: false },
      autoTitle: false,
    });
    // Dictée du test : whisper.cpp local de la config voice, sans clé (comme la gate P3).
    if (voice?.whisper) {
      k.agent.settings.patch({
        voice: { ...k.agent.settings.get("voice"), sttProvider: "local-whisper-cpp", sttModel: "" },
        providerOverrides: {
          ...k.agent.settings.get("providerOverrides"),
          "local-whisper-cpp": { baseUrl: `http://127.0.0.1:${voice.whisper.port ?? 8910}/v1` },
        },
      });
    }
  }
  return {
    app,
    agent: k.agent,
    scheduler: k.scheduler,
    gateways: k.gateways,
    ...(k.persona ? { persona: k.persona } : {}),
    ...(k.voice ? { voice: k.voice } : {}),
    ...(k.updates ? { updates: k.updates } : {}),
    ...(k.mcp ? { mcp: k.mcp } : {}),
    ...(k.skillsHub ? { skillsHub: k.skillsHub } : {}),
    ...(k.memory ? { portability: k.memory.portability } : {}),
    ...(k.storage ? { storage: k.storage } : {}),
    ...(k.kanban ? { kanban: k.kanban } : {}),
    ...(k.rag ? { rag: k.rag.rag } : {}),
    ...(k.pluginHost ? { pluginHost: k.pluginHost } : {}),
    ...(k.automation ? { automation: k.automation } : {}),
    ...(k.tools?.sshHosts ? { sshHosts: k.tools.sshHosts } : {}),
    ...(k.permissions ? { permissions: k.permissions } : {}),
    ...(k.llm ? { localEngine: { engine: k.llm.engine, ...(k.llm.localModels ? { models: k.llm.localModels } : {}), hardware: () => k.llm!.detectHardware() } } : {}),
    profile,
    dataRoot: o.dataRoot,
    dataDir,
    dispose: () => {
      detachBrowser?.();
      return stop(started);
    },
  };
}
