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
 *
 * 2026-10-21 (re-examination of llama-swap, user's request), two things llama-swap does that this did not:
 * - a RESPONSE IN PROGRESS IS NEVER CUT by a swap. Every chat call to a local backend holds a lease (taken in the same queue as the loads, so
 *   no swap slips in between « loaded » and « answering »); before llama-server is stopped or restarted, or an LM Studio model unloaded, the
 *   swap waits until no response runs on it. A wait that lasts too long (`drainMaxMs`, 5 min) refuses the SWAP, never the response.
 * - UNLOAD AFTER INACTIVITY (`localModels.idleUnloadMinutes`, off by default): a local chat model nobody has used for that long is unloaded —
 *   llama-server stopped, or an LM Studio model unloaded, but only one Jarod loaded itself (a model loaded by the user in LM Studio, for other
 *   programs, is never touched), never an embedding model, never a model with a response in progress.
 *
 * OWNERSHIP (2026-10-21, reconciliation after a restart). Every loaded model says who loaded it:
 * - `jarod`: loaded by THIS process (the llama-server child it supervises; an LM Studio instance it loaded since it started);
 * - `incertaine`: an LM Studio instance Jarod loaded before a restart (`localModels.lmstudioLoaded`) and found again — nothing proves it was
 *   not unloaded and loaded again by someone else since (LM Studio gives no load time, and its instance id is often the model key);
 * - `externe`: loaded by someone else (LM Studio's own window, another program); for llama.cpp, a server answering on the port that this
 *   process did not start.
 * Only `jarod` is ever unloaded WITHOUT the user asking (inactivity, hotswap). `incertaine` and `externe` are shown as such; only the user's
 * own « Unload » touches them (and « Adopt » makes an uncertain instance Jarod's again). Records whose instance is gone are forgotten.
 */
import type { SettingsService } from "@jarod/plugin-storage";
import type { EngineService } from "./engine.js";
import { existsSync } from "node:fs";
import { isChatModel, LmStudioClient, type LmStudioModel } from "./lmstudio.js";
import type { ProviderRouter } from "./providers.js";

export type LocalBackend = "llamacpp" | "lmstudio";
export const LOCAL_BACKENDS: readonly LocalBackend[] = ["llamacpp", "lmstudio"];

/** Who loaded a model in memory (see OWNERSHIP above); null when it is not loaded. */
export type LocalModelOwner = "jarod" | "incertaine" | "externe";

export interface LocalModelEntry {
  /** Preset id (llama.cpp) or model key (LM Studio). */
  id: string;
  owner: LocalModelOwner | null;
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

/**
 * The context an LM Studio model is loaded with when nothing was set for it. LM Studio's own default (8192 on the machine this was measured
 * on, 2026-10-15) is smaller than the tool list alone (~5700 tokens) plus a system prompt and a question, so the first turn that called a
 * tool failed. 16384 leaves room for a conversation without the memory cost of the model's full window; a model that accepts less is
 * loaded at its own maximum. A length set for the model (`setContextLength`) always wins. It applies to the loads made here, never to a
 * model already in memory (see `lmStale`).
 */
export const DEFAULT_LM_CONTEXT = 16_384;

export function defaultLmContext(model: { maxContext: number | null }): number {
  return model.maxContext !== null && model.maxContext > 0 ? Math.min(DEFAULT_LM_CONTEXT, model.maxContext) : DEFAULT_LM_CONTEXT;
}

export interface LocalBackendView {
  /** llama.cpp: a server answers on the engine's port that this process did not start (never stopped by Jarod). */
  foreign?: boolean;
  /** False: the server does not answer (LM Studio closed) or is not set up (llama.cpp engine not installed). */
  available: boolean;
  reason: string | null;
  models: LocalModelEntry[];
}

export interface LocalModelsView {
  hotswap: boolean;
  /** Unload after this many minutes without use; 0 = never. */
  idleUnloadMinutes: number;
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
  /** Why an unload happened when the user did not ask for it: `inactivité`. */
  reason?: "inactivité";
}

/** The longest a swap waits for a response in progress on the model it would unload; past it, the swap is refused (the response goes on). */
export const DRAIN_MAX_MS = 5 * 60_000;
/** The longest idle delay that can be set (a day): beyond it, unloading is something the user does. */
export const MAX_IDLE_UNLOAD_MINUTES = 1440;

export class LocalModelsService {
  readonly lmstudio: LmStudioClient;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(a: LocalModelActivity) => void>();
  private seq = 0;
  /** Responses in progress, per `backend:model`. */
  private readonly busy = new Map<string, number>();
  /** When each `backend:model` was last loaded or last answered. */
  private readonly lastUsed = new Map<string, number>();
  /** Called whenever a response ends: a waiting swap looks again. */
  private readonly waiters = new Set<() => void>();
  /** LM Studio models Jarod loaded itself: the only ones inactivity may unload. */
  private readonly ours = new Set<string>();
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private idleQueued = false;

  constructor(
    private readonly d: {
      settings: SettingsService;
      engine: EngineService;
      providers: ProviderRouter;
      fetchImpl?: typeof fetch;
      /** Tests: a shorter wait for a response in progress, a shorter « minute », a faster inactivity check, a clock. */
      drainMaxMs?: number;
      minuteMs?: number;
      idleCheckMs?: number;
      now?: () => number;
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
    this.idleTimer = setInterval(() => void this.idleCheck(), d.idleCheckMs ?? 30_000);
    this.idleTimer.unref?.();
  }

  /** Stops the inactivity check (the service is going away). */
  dispose(): void {
    clearInterval(this.idleTimer);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** A response starts on `backend:model`: the returned function ends it (once). */
  private enter(backend: LocalBackend, model: string): () => void {
    const key = `${backend}:${model}`;
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.busy.get(key) ?? 1) - 1;
      if (n > 0) this.busy.set(key, n);
      else this.busy.delete(key);
      this.lastUsed.set(key, this.now());
      for (const w of [...this.waiters]) w();
    };
  }

  /** Responses in progress, by `backend:model` (what the screen and the tests can see). */
  inFlight(): Record<string, number> {
    return Object.fromEntries(this.busy);
  }

  /**
   * Waits until no response runs on what `covers` designates. Past `drainMaxMs` the wait is given up with an error: the caller (a swap, an
   * unload) then does NOTHING — the response is never cut.
   */
  private async drain(covers: (key: string) => boolean, signal?: AbortSignal): Promise<void> {
    const running = () => [...this.busy].filter(([k, n]) => n > 0 && covers(k)).map(([k]) => k);
    if (!running().length) return;
    const max = this.d.drainMaxMs ?? DRAIN_MAX_MS;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
      };
      const check = () => {
        if (running().length) return;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Bascule annulée."));
      };
      const timer = setTimeout(() => {
        const names = running().map((k) => `« ${k.slice(k.indexOf(":") + 1)} »`).join(", ");
        cleanup();
        reject(new Error(`Une réponse est encore en cours sur ${names} après ${Math.round(max / 1000)} s : rien n'a été déchargé, pour ne pas la couper. Réessayer quand elle sera finie.`));
      }, max);
      this.waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Unload after `minutes` without use (0 = never). Applies from the next check (every 30 s). */
  async setIdleUnload(minutes: number): Promise<LocalModelsView> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_IDLE_UNLOAD_MINUTES) throw new Error(`Déchargement après inactivité : entier de 0 (jamais) à ${MAX_IDLE_UNLOAD_MINUTES} minutes attendu.`);
    this.d.settings.set("localModels", { ...this.d.settings.get("localModels"), idleUnloadMinutes: minutes });
    return this.list();
  }

  idleUnloadMinutes(): number {
    const n = this.d.settings.get("localModels")?.idleUnloadMinutes;
    return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= MAX_IDLE_UNLOAD_MINUTES ? n : 0;
  }

  /**
   * The inactivity check: in the same queue as loads (it never races a swap), at most one waiting at a time. A model is idle when no response
   * runs on it and its last use (or, never used, the first time this check saw it loaded) is older than the delay.
   */
  idleCheck(): Promise<void> {
    const minutes = this.idleUnloadMinutes();
    if (!minutes || this.idleQueued) return Promise.resolve();
    this.idleQueued = true;
    const limit = minutes * (this.d.minuteMs ?? 60_000);
    return this.exclusive(async () => {
      this.idleQueued = false;
      const now = this.now();
      const idle = (key: string): boolean => {
        if ((this.busy.get(key) ?? 0) > 0) return false;
        const last = this.lastUsed.get(key);
        if (last === undefined) {
          this.lastUsed.set(key, now);
          return false;
        }
        return now - last >= limit;
      };
      const preset = this.d.engine.loadedPreset();
      if (preset && idle(`llamacpp:${preset.name}`)) await this.stopLlama("inactivité");
      if (!this.ours.size) return;
      let models: LmStudioModel[];
      try {
        models = await this.lmstudio.list();
      } catch {
        return; // LM Studio closed: nothing of ours is loaded there any more
      }
      this.reconcile(models);
      for (const m of models) {
        // Only what THIS process loaded: an uncertain or external model is never unloaded for inactivity.
        if (this.ownerOf(m) !== "jarod") continue;
        if (isChatModel(m) && idle(`lmstudio:${m.key}`)) await this.unloadLm(m, "inactivité");
      }
    }).catch(() => undefined);
  }

  /** Every load and unload, as it starts and as it ends. Returns the unsubscribe. */
  onActivity(listener: (a: LocalModelActivity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async track<T>(action: LocalModelActivity["action"], backend: LocalBackend, model: string, run: () => Promise<T>, reason?: LocalModelActivity["reason"]): Promise<T> {
    const id = ++this.seq;
    const at = Date.now();
    const emit = (a: LocalModelActivity) => {
      for (const l of this.listeners) {
        try {
          l(a);
        } catch {}
      }
    };
    const why = reason ? { reason } : {};
    emit({ id, action, phase: "start", backend, model, at, ...why });
    try {
      const result = await run();
      emit({ id, action, phase: "done", backend, model, at, durationMs: Date.now() - at, ...why });
      return result;
    } catch (e) {
      emit({ id, action, phase: "error", backend, model, at, durationMs: Date.now() - at, error: (e as Error).message, ...why });
      throw e;
    }
  }

  /** Stops llama-server once no response runs on it (whatever preset it serves). */
  private async stopLlama(reason?: LocalModelActivity["reason"]): Promise<unknown> {
    const loaded = this.d.engine.loadedPreset();
    if (!loaded) return;
    await this.drain((k) => k.startsWith("llamacpp:"));
    return this.track("unload", "llamacpp", loaded.name, () => this.d.engine.stop(), reason);
  }

  /** Unloads an LM Studio model once no response runs on it. */
  private async unloadLm(m: LmStudioModel, reason?: LocalModelActivity["reason"]): Promise<void> {
    if (!m.instances.length) return;
    await this.drain((k) => k === `lmstudio:${m.key}`);
    await this.track(
      "unload",
      "lmstudio",
      m.key,
      async () => {
        for (const instance of m.instances) await this.lmstudio.unload(instance);
      },
      reason,
    );
    this.ours.delete(m.key);
    this.setRecorded(this.recorded().filter((r) => r.key !== m.key));
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
        // The server this process supervises: always Jarod's.
        owner: loaded?.id === p.id ? ("jarod" as const) : null,
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
    this.reconcile(models);
    return {
      available: true,
      reason: null,
      models: models.map((m) => ({
        id: m.key,
        owner: this.ownerOf(m),
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
    const llamacpp = this.llamaView();
    if (!this.d.engine.loadedPreset() && (await this.d.engine.foreignServer?.())) llamacpp.foreign = true;
    return { hotswap: this.hotswap(), idleUnloadMinutes: this.idleUnloadMinutes(), backends: { llamacpp, lmstudio: await this.lmView() } };
  }

  /** The LM Studio instances Jarod loaded, as recorded in the profile (kept across restarts). */
  private recorded(): { key: string; instance: string; context: number | null; at: number }[] {
    const list = this.d.settings.get("localModels")?.lmstudioLoaded;
    return Array.isArray(list) ? list.filter((r) => r && typeof r.key === "string" && typeof r.instance === "string") : [];
  }

  private setRecorded(list: { key: string; instance: string; context: number | null; at: number }[]): void {
    const cur = this.d.settings.get("localModels");
    if (JSON.stringify(cur?.lmstudioLoaded ?? []) === JSON.stringify(list)) return;
    this.d.settings.set("localModels", { ...cur, lmstudioLoaded: list });
  }

  /** Who loaded this LM Studio model (null: not loaded). */
  ownerOf(m: LmStudioModel): LocalModelOwner | null {
    if (!m.instances.length) return null;
    if (this.ours.has(m.key)) return "jarod";
    return this.recorded().some((r) => r.key === m.key && m.instances.includes(r.instance)) ? "incertaine" : "externe";
  }

  /** Forgets the records whose instance is no longer loaded (unloaded by anyone, LM Studio restarted). */
  private reconcile(models: LmStudioModel[]): void {
    const loaded = new Set(models.flatMap((m) => m.instances.map((i) => `${m.key}\u0000${i}`)));
    this.setRecorded(this.recorded().filter((r) => loaded.has(`${r.key}\u0000${r.instance}`)));
    for (const key of [...this.ours]) if (!models.some((m) => m.key === key && m.instances.length)) this.ours.delete(key);
  }

  /**
   * The user says an UNCERTAIN instance is Jarod's (« Adopt »): from then on, inactivity and hotswap may unload it. An external model cannot be
   * adopted this way (nothing says Jarod ever loaded it); the user unloads it, or loads it again from here.
   */
  adopt(key: string): Promise<LocalModelsView> {
    return this.exclusive(async () => {
      const m = (await this.lmstudio.list()).find((x) => x.key === key);
      if (!m || this.ownerOf(m) !== "incertaine") throw new Error(`« ${key} » n'est pas un modèle chargé par Jarod avant le redémarrage : rien à reprendre.`);
      this.ours.add(key);
      return this.list();
    });
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
      if (this.d.engine.loadedPreset()?.id !== id) {
        // Starting another preset restarts llama-server: the response it is giving ends first.
        if (this.d.engine.loadedPreset()) await this.drain((k) => k.startsWith("llamacpp:"), signal);
        await this.track("load", "llamacpp", preset.name, () => this.d.engine.start(id));
        this.lastUsed.set(`llamacpp:${preset.name}`, this.now());
      }
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
    const context = this.lmContext(id) ?? defaultLmContext(target);
    if (target.instances.length === 0 || stale) {
      const instance = await this.track("load", "lmstudio", id, () => this.lmstudio.load(id, signal, context));
      this.ours.add(id);
      this.setRecorded([...this.recorded().filter((r) => r.key !== id), { key: id, instance, context, at: Date.now() }]);
      this.lastUsed.set(`lmstudio:${id}`, this.now());
    }
  }

  /** Unloads every LM Studio chat model Jarod loaded itself but `keep`. LM Studio closed = nothing loaded there: not an error. */
  private async unloadLmStudioChat(keep: string | null, known?: LmStudioModel[]): Promise<void> {
    let models = known;
    if (!models) {
      try {
        models = await this.lmstudio.list();
      } catch {
        return;
      }
    }
    // Only Jarod's own: a model loaded by someone else, or whose ownership is uncertain after a restart, stays (it is shown as such).
    for (const m of models) if (m.key !== keep && isChatModel(m) && this.ownerOf(m) === "jarod") await this.unloadLm(m);
  }

  /**
   * Run before every chat call to llama.cpp or LM Studio. With hotswap, the model the call names is loaded first, the others unloaded (a name
   * that is not one of ours is left alone, and so is a model already loaded). Always, a LEASE is taken on `backend:model` in the same queue
   * as the loads — returned, and released by the router once the call is over: a swap waits for it.
   */
  prepare(backend: LocalBackend, model: string, signal?: AbortSignal): Promise<() => void> {
    return this.exclusive(async () => {
      if (this.hotswap() && model) await this.swapFor(backend, model, signal);
      return this.enter(backend, model);
    });
  }

  private async swapFor(backend: LocalBackend, model: string, signal?: AbortSignal): Promise<void> {
    if (backend === "llamacpp") {
      const preset = this.d.engine.config().presets.find((p) => p.name === model);
      if (!preset) return;
      const loaded = this.d.engine.loadedPreset();
      if (loaded?.name === model) return;
      await this.loadNow("llamacpp", preset.id, signal);
      return;
    }
    let models: LmStudioModel[];
    try {
      models = await this.lmstudio.list(signal);
    } catch {
      return; // LM Studio does not answer: the call itself will say so.
    }
    const target = models.find((m) => m.key === model);
    if (!target || !isChatModel(target)) return;
    const others = models.some((m) => m.key !== model && isChatModel(m) && this.ownerOf(m) === "jarod");
    if (target.instances.length > 0 && !others && !this.d.engine.loadedPreset() && !this.lmStale(target)) return;
    await this.loadNow("lmstudio", model, signal);
  }
}
