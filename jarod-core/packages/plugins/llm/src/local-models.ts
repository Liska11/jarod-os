/**
 * Local models in memory, whatever serves them: the llama.cpp server Jarod drives (one preset at a time, `EngineService`) and LM Studio (its REST
 * API, `LmStudioClient`). One list, two gestures (load, unload) and the hotswap switch (`localModels.hotswap`):
 *
 * - hotswap OFF (default): nothing loads or unloads unless the user asks in the screen. Loading in LM Studio adds a model next to the others;
 *   loading a llama.cpp preset replaces the previous preset (one server, one model: that has always been so).
 * - hotswap ON: one local CHAT model in memory at a time. Loading one unloads the other chat models of both servers first (they share the same
 *   GPU memory), and a chat call that names a local model that is not loaded loads it before it is sent (`ProviderRouter.setPreparer`), so
 *   choosing a model in the chat's picker is enough. Embedding models are never unloaded: the document search uses them.
 *
 * Loads and unloads run one after the other (two swaps at once would each unload what the other loads).
 */
import type { SettingsService } from "@jarod/plugin-storage";
import type { EngineService } from "./engine.js";
import { existsSync } from "node:fs";
import { isChatModel, LmStudioClient, type LmStudioModel } from "./lmstudio.js";
import type { ProviderRouter } from "./providers.js";

export type LocalBackend = "llamacpp" | "lmstudio";
export const LOCAL_BACKENDS: readonly LocalBackend[] = ["llamacpp", "lmstudio"];

export interface LocalModelEntry {
  /** Preset id (llama.cpp) or model key (LM Studio). */
  id: string;
  name: string;
  /** What the chat names: the preset's name (its `--alias`) or LM Studio's key. */
  model: string;
  kind: "chat" | "embedding";
  loaded: boolean;
  /** False when it cannot be loaded as is (llama.cpp: engine not installed, model file missing). */
  loadable: boolean;
  sizeBytes: number | null;
  /** The context length a load asks for: the preset's `ctxSize` (llama.cpp), the one set here (LM Studio; null = LM Studio's own). */
  contextLength: number | null;
  /** The context it is in memory with, when the server says (LM Studio); null otherwise. */
  loadedContext: number | null;
  /** The largest context the model takes (LM Studio's `max_context_length`). */
  maxContext: number | null;
}

/** Below this, the agent's tool list alone does not fit. */
export const MIN_CONTEXT_LENGTH = 512;

export interface LocalBackendView {
  /** False: the server does not answer (LM Studio closed) or is not set up (llama.cpp engine not installed). */
  available: boolean;
  reason: string | null;
  models: LocalModelEntry[];
}

export interface LocalModelsView {
  hotswap: boolean;
  backends: Record<LocalBackend, LocalBackendView>;
}

/**
 * One load or unload, wherever it came from (the screen, the chat's hotswap, the unloads a hotswap does first): `start`, then `done` or
 * `error` with the same `id`. What the window shows while a model loads, and when it is ready.
 */
export interface LocalModelActivity {
  id: number;
  action: "load" | "unload";
  phase: "start" | "done" | "error";
  backend: LocalBackend;
  /** What the chat names: the preset's name, or LM Studio's key. */
  model: string;
  at: number;
  /** `done` and `error`: how long it took. */
  durationMs?: number;
  error?: string;
}

export class LocalModelsService {
  readonly lmstudio: LmStudioClient;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(a: LocalModelActivity) => void>();
  private seq = 0;

  constructor(
    private readonly d: {
      settings: SettingsService;
      engine: EngineService;
      providers: ProviderRouter;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.lmstudio = new LmStudioClient({
      endpoint: () => {
        const key = d.providers.apiKeys("lmstudio")[0];
        return { baseUrl: d.providers.def("lmstudio").baseUrl, ...(key ? { key } : {}) };
      },
      ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
    });
    const prepare = (backend: LocalBackend) => (model: string, signal?: AbortSignal) => this.prepare(backend, model, signal);
    for (const b of LOCAL_BACKENDS) d.providers.setPreparer(b, prepare(b));
  }

  /** Every load and unload, as it starts and as it ends. Returns the unsubscribe. */
  onActivity(listener: (a: LocalModelActivity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async track<T>(action: LocalModelActivity["action"], backend: LocalBackend, model: string, run: () => Promise<T>): Promise<T> {
    const id = ++this.seq;
    const at = Date.now();
    const emit = (a: LocalModelActivity) => {
      for (const l of this.listeners) {
        try {
          l(a);
        } catch {}
      }
    };
    emit({ id, action, phase: "start", backend, model, at });
    try {
      const result = await run();
      emit({ id, action, phase: "done", backend, model, at, durationMs: Date.now() - at });
      return result;
    } catch (e) {
      emit({ id, action, phase: "error", backend, model, at, durationMs: Date.now() - at, error: (e as Error).message });
      throw e;
    }
  }

  private stopLlama(): Promise<unknown> {
    const loaded = this.d.engine.loadedPreset();
    return loaded ? this.track("unload", "llamacpp", loaded.name, () => this.d.engine.stop()) : Promise.resolve();
  }

  private async unloadLm(m: LmStudioModel): Promise<void> {
    if (!m.instances.length) return;
    await this.track("unload", "lmstudio", m.key, async () => {
      for (const instance of m.instances) await this.lmstudio.unload(instance);
    });
  }

  hotswap(): boolean {
    return Boolean(this.d.settings.get("localModels")?.hotswap);
  }

  /** Turns hotswap on or off; the chat's picker follows at once (llama.cpp: every preset, or only the loaded one). */
  async setHotswap(on: boolean): Promise<LocalModelsView> {
    if (typeof on !== "boolean") throw new Error("Hotswap : booléen attendu.");
    this.d.settings.set("localModels", { ...this.d.settings.get("localModels"), hotswap: on });
    this.d.engine.publishModels();
    return this.list();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private llamaView(): LocalBackendView {
    const cfg = this.d.engine.config();
    const installed = Boolean(cfg.installed && existsSync(cfg.installed.bin));
    const loaded = this.d.engine.loadedPreset();
    return {
      available: installed,
      reason: installed ? null : "moteur llama.cpp non installé",
      models: cfg.presets.map((p) => ({
        id: p.id,
        name: p.name,
        model: p.name,
        kind: "chat",
        loaded: loaded?.id === p.id,
        loadable: installed && Boolean(p.model) && existsSync(p.model),
        sizeBytes: null,
        contextLength: p.ctxSize > 0 ? p.ctxSize : null,
        loadedContext: null,
        maxContext: null,
      })),
    };
  }

  private async lmView(): Promise<LocalBackendView> {
    let models: LmStudioModel[];
    try {
      models = await this.lmstudio.list();
    } catch (e) {
      return { available: false, reason: (e as Error).message, models: [] };
    }
    if (this.hotswap()) this.publishLmStudio(models);
    return {
      available: true,
      reason: null,
      models: models.map((m) => ({
        id: m.key,
        name: m.name,
        model: m.key,
        kind: isChatModel(m) ? "chat" : "embedding",
        loaded: m.instances.length > 0,
        loadable: true,
        sizeBytes: m.sizeBytes,
        contextLength: this.lmContext(m.key),
        loadedContext: m.instances.length > 0 ? m.loadedContext : null,
        maxContext: m.maxContext,
      })),
    };
  }

  /** The context length set here for an LM Studio model; null = let LM Studio choose. */
  private lmContext(key: string): number | null {
    const n = this.d.settings.get("localModels")?.lmstudioContext?.[key];
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
  }

  /** In memory with another context than the one set here: loading it again reloads it at the right size. */
  private lmStale(m: LmStudioModel): boolean {
    const want = this.lmContext(m.key);
    return want !== null && m.instances.length > 0 && m.loadedContext !== want;
  }

  /**
   * The context length LM Studio loads `model` with, from its next load (`null`: LM Studio's own). Not applied to a model already in memory:
   * « Load » (or the chat's hotswap) reloads it at that size.
   */
  async setContextLength(model: string, tokens: number | null): Promise<LocalModelsView> {
    if (tokens !== null && (!Number.isInteger(tokens) || tokens < MIN_CONTEXT_LENGTH)) throw new Error(`Longueur de contexte : entier d'au moins ${MIN_CONTEXT_LENGTH} attendu.`);
    const m = (await this.lmstudio.list()).find((x) => x.key === model);
    if (!m) throw new Error(`LM Studio ne connaît pas le modèle « ${model} ».`);
    if (tokens !== null && m.maxContext !== null && tokens > m.maxContext) throw new Error(`Longueur de contexte : « ${model} » en accepte au plus ${m.maxContext}.`);
    const cur = this.d.settings.get("localModels");
    const map = { ...cur?.lmstudioContext };
    if (tokens === null) delete map[model];
    else map[model] = tokens;
    this.d.settings.set("localModels", { ...cur, lmstudioContext: map });
    return this.list();
  }

  /** With hotswap, the chat's picker lists every LM Studio chat model (choosing one loads it). */
  private publishLmStudio(models: LmStudioModel[]): void {
    const names = models.filter(isChatModel).map((m) => m.key);
    const overrides = { ...this.d.settings.get("providerOverrides") };
    if (JSON.stringify(overrides.lmstudio?.models ?? []) === JSON.stringify(names)) return;
    overrides.lmstudio = { ...overrides.lmstudio, models: names };
    this.d.settings.set("providerOverrides", overrides);
  }

  async list(): Promise<LocalModelsView> {
    return { hotswap: this.hotswap(), backends: { llamacpp: this.llamaView(), lmstudio: await this.lmView() } };
  }

  /** Loads a model. With hotswap, the other local chat models are unloaded first (both servers). */
  load(backend: LocalBackend, id: string, signal?: AbortSignal): Promise<LocalModelsView> {
    return this.exclusive(async () => {
      await this.loadNow(backend, id, signal);
      return this.list();
    });
  }

  unload(backend: LocalBackend, id: string): Promise<LocalModelsView> {
    return this.exclusive(async () => {
      if (backend === "llamacpp") {
        if (this.d.engine.loadedPreset()?.id === id) await this.stopLlama();
      } else {
        const m = (await this.lmstudio.list()).find((x) => x.key === id);
        if (!m) throw new Error(`LM Studio ne connaît pas le modèle « ${id} ».`);
        await this.unloadLm(m);
      }
      return this.list();
    });
  }

  private async loadNow(backend: LocalBackend, id: string, signal?: AbortSignal): Promise<void> {
    if (backend === "llamacpp") {
      const preset = this.d.engine.config().presets.find((p) => p.id === id);
      if (!preset) throw new Error("Préréglage llama.cpp inconnu.");
      if (this.hotswap()) await this.unloadLmStudioChat(null);
      if (this.d.engine.loadedPreset()?.id !== id) await this.track("load", "llamacpp", preset.name, () => this.d.engine.start(id));
      return;
    }
    const models = await this.lmstudio.list(signal);
    const target = models.find((m) => m.key === id);
    if (!target) throw new Error(`LM Studio ne connaît pas le modèle « ${id} ».`);
    if (this.hotswap() && isChatModel(target)) {
      await this.stopLlama();
      await this.unloadLmStudioChat(id, models);
    }
    // In memory at another context than the one set here: unloaded, then loaded again at that size.
    const stale = this.lmStale(target);
    if (stale) await this.unloadLm(target);
    const context = this.lmContext(id) ?? undefined;
    if (target.instances.length === 0 || stale) await this.track("load", "lmstudio", id, () => this.lmstudio.load(id, signal, context));
  }

  /** Unloads every LM Studio chat model but `keep`. LM Studio closed = nothing loaded there: not an error. */
  private async unloadLmStudioChat(keep: string | null, known?: LmStudioModel[]): Promise<void> {
    let models = known;
    if (!models) {
      try {
        models = await this.lmstudio.list();
      } catch {
        return;
      }
    }
    for (const m of models) if (m.key !== keep && isChatModel(m)) await this.unloadLm(m);
  }

  /**
   * Run before a chat call to llama.cpp or LM Studio (hotswap only): the model the call names is loaded first, the others unloaded. A name that
   * is not one of ours (a server Jarod does not know of) is left alone, and so is a model already loaded.
   */
  async prepare(backend: LocalBackend, model: string, signal?: AbortSignal): Promise<void> {
    if (!this.hotswap() || !model) return;
    if (backend === "llamacpp") {
      const preset = this.d.engine.config().presets.find((p) => p.name === model);
      if (!preset) return;
      const loaded = this.d.engine.loadedPreset();
      if (loaded?.name === model) return;
      await this.exclusive(() => this.loadNow("llamacpp", preset.id, signal));
      return;
    }
    await this.exclusive(async () => {
      let models: LmStudioModel[];
      try {
        models = await this.lmstudio.list(signal);
      } catch {
        return; // LM Studio does not answer: the call itself will say so.
      }
      const target = models.find((m) => m.key === model);
      if (!target || !isChatModel(target)) return;
      const others = models.some((m) => m.key !== model && isChatModel(m) && m.instances.length > 0);
      if (target.instances.length > 0 && !others && !this.d.engine.loadedPreset() && !this.lmStale(target)) return;
      await this.loadNow("lmstudio", model, signal);
    });
  }
}
