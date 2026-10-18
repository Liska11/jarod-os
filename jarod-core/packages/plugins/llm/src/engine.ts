// Portage de packages/core/src/services/engine.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LlamaServerState, LlamaServerSupervisor } from "./llama-server.js";
import type { Hardware } from "./local.js";
import type { SettingsService } from "@jarod/plugin-storage";
import { extractZip } from "@jarod/plugin-rag";
import { type EngineBackend, type ReasoningMode, type InstalledEngine, type EnginePreset, type LocalEngineConfig } from "@jarod/contracts";
export type { EngineBackend, ReasoningMode, InstalledEngine, EnginePreset, LocalEngineConfig };

/**
 * The local llama.cpp engine, managed the way Ajean does it: installed for this machine's GPU in one
 * click, kept up to date, and driven through presets — each preset is a complete way of loading a
 * model (context, GPU layers, KV cache, flash attention, sampling, reasoning, speculative decoding),
 * so switching presets reloads the model without touching a file.
 *
 * Binaries come from the official ggml-org/llama.cpp releases, never from anywhere else, and are
 * checked against the SHA-256 GitHub publishes for each asset when it is there. Archives are
 * extracted by our own reader, which refuses any path leaving the install folder. The engine only
 * ever listens on 127.0.0.1, and Jarod stops what it started when it quits.
 */

// ReasoningMode : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// EnginePreset : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// InstalledEngine : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// LocalEngineConfig : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

export const DEFAULT_ENGINE_CONFIG: LocalEngineConfig = {
  port: 8080,
  backend: "",
  installed: null,
  presets: [],
  activePreset: "",
  autoStart: false,
};

export const newPreset = (over: Partial<EnginePreset> = {}): EnginePreset => ({
  id: `p${Date.now().toString(36)}`,
  name: "Préréglage",
  model: "",
  draftModel: "",
  ctxSize: 32768,
  gpuLayers: -1,
  flashAttn: "auto",
  cacheType: "f16",
  temperature: null,
  topP: null,
  topK: null,
  minP: null,
  reasoning: "auto",
  extraArgs: [],
  ...over,
});

export const ENGINE_BACKENDS: readonly EngineBackend[] = ["cuda", "vulkan", "hip", "sycl", "metal", "cpu"];

const RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  /** "sha256:<hex>", published by GitHub for release assets. */
  digest?: string | null;
}

/** The backend that suits this machine best, from what the drivers declare. */
export function pickBackend(hw: Pick<Hardware, "gpus" | "appleSilicon">, os: string): EngineBackend {
  if (os === "darwin") return hw.appleSilicon ? "metal" : "cpu";
  const backends = hw.gpus.map((g) => g.backend ?? "");
  if (backends.includes("cuda")) return "cuda";
  if (backends.includes("rocm")) return "hip";
  if (hw.gpus.some((g) => g.kind === "dgpu" || g.kind === "igpu")) return "vulkan";
  return "cpu";
}

/**
 * `[cudart-]llama-[<tag>-]bin-<system>[-<variant>]-<arch>.<zip|tar.gz>`, the way llama.cpp names its
 * archives (b11192, September 2026): `llama-b11192-bin-win-cuda-12.4-x64.zip` with
 * `cudart-llama-bin-win-cuda-12.4-x64.zip`, `llama-b11192-bin-win-rocm-10.0-x64.zip` (formerly
 * `hip-radeon`), `llama-b11192-bin-ubuntu-cuda-12.8-x64.tar.gz`, `llama-b11192-bin-macos-arm64.tar.gz`…
 */
const ASSET_NAME = /^(cudart-)?llama-(?:b\d+-)?bin-([a-z]+)(?:-(.+?))?-(x64|arm64)\.(?:zip|tar\.gz)$/;

/**
 * The release archives to install for a backend: the engine itself, plus the CUDA runtime that
 * llama.cpp ships apart. CUDA 12 builds are preferred: CUDA 13 needs a recent driver.
 */
export function pickAssets(
  assets: ReleaseAsset[],
  backend: EngineBackend,
  os: string,
  arch: string,
): { engine: ReleaseAsset; runtime?: ReleaseAsset } {
  const a = arch === "arm64" ? "arm64" : "x64";
  const sys = os === "win32" ? "win" : os === "darwin" ? "macos" : "ubuntu";
  const parsed = assets.flatMap((asset) => {
    const m = ASSET_NAME.exec(asset.name);
    return m && m[2] === sys && m[4] === a ? [{ asset, runtime: Boolean(m[1]), variant: m[3] ?? "" }] : [];
  });
  const wanted: (v: string) => boolean =
    sys === "macos"
      ? (v) => v === ""
      : backend === "cuda"
        ? (v) => /^cuda-[\d.]+$/.test(v)
        : backend === "hip"
          ? (v) => /^(rocm-[\d.]+|hip-radeon)$/.test(v)
          : backend === "sycl"
            ? (v) => v === (sys === "win" ? "sycl" : "sycl-fp16")
            : backend === "vulkan"
              ? (v) => v === "vulkan"
              : (v) => v === (sys === "win" ? "cpu" : "");
  const engines = parsed
    .filter((p) => !p.runtime && wanted(p.variant))
    .sort((x, y) => cudaRank(y.variant) - cudaRank(x.variant));
  const engine = engines[0];
  if (!engine) throw new Error(`Aucune version de llama.cpp publiée pour ${os}/${a} avec le moteur ${backend}.`);
  const runtime = backend === "cuda" ? parsed.find((p) => p.runtime && p.variant === engine.variant) : undefined;
  return runtime ? { engine: engine.asset, runtime: runtime.asset } : { engine: engine.asset };
}

/** CUDA 12.x first (newest 12 first), then the others: a CUDA 13 build needs a driver from 2025. */
function cudaRank(variant: string): number {
  const [major = 0, minor = 0] = (/cuda-([\d.]+)/.exec(variant)?.[1] ?? "0").split(".").map(Number);
  return (major === 12 ? 1000 : 0) + major * 10 + minor;
}

/** llama-server arguments for a preset, built as argv: nothing goes through a shell. */
export function presetArgs(p: EnginePreset): string[] {
  // --jinja: the model's own chat template, which is what makes tool calls work.
  const args = ["--jinja", "--alias", p.name, "-fa", p.flashAttn];
  if (p.cacheType !== "f16") args.push("--cache-type-k", p.cacheType, "--cache-type-v", p.cacheType);
  if (p.temperature !== null) args.push("--temp", String(p.temperature));
  if (p.topP !== null) args.push("--top-p", String(p.topP));
  if (p.topK !== null) args.push("--top-k", String(p.topK));
  if (p.minP !== null) args.push("--min-p", String(p.minP));
  if (p.reasoning === "off") args.push("--reasoning-budget", "0");
  if (p.reasoning === "on") args.push("--reasoning-budget", "-1");
  if (p.reasoning === "deepseek") args.push("--reasoning-format", "deepseek");
  if (p.draftModel) args.push("--model-draft", p.draftModel, "--draft-max", "16", "--draft-min", "1");
  if (p.parallelSlots) args.push("--parallel", String(p.parallelSlots));
  return [...args, ...p.extraArgs.filter(Boolean)];
}

/** The llama-server executable inside an extracted release (its folder varies between releases). */
export function findServerBinary(dir: string, os: string): string | null {
  const name = os === "win32" ? "llama-server.exe" : "llama-server";
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (entry === name) return p;
      if (statSync(p).isDirectory()) stack.push(p);
    }
  }
  return null;
}

export interface EngineProgress {
  step: "download" | "verify" | "extract" | "done";
  file?: string;
  received?: number;
  total?: number | null;
}

export class EngineService {
  /** Loads and unloads run one after the other: two swaps at once would start two servers on one port. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The preset the running server was started with. */
  private loadedId: string | null = null;

  constructor(
    private readonly d: {
      /** Where installs live: `<dataDir>/engine`. */
      dir: string;
      settings: SettingsService;
      supervisor: LlamaServerSupervisor;
      hardware: () => Promise<Pick<Hardware, "gpus" | "appleSilicon">>;
      fetchImpl?: typeof fetch;
      os?: string;
      arch?: string;
      /** Extraction of a .tar.gz (Linux, macOS): the system tar. */
      untar?: (archive: string, dest: string) => Promise<void>;
      /** Last lines written by the running server, for the screen. */
      logs?: () => string[];
    },
  ) {}

  private get os(): string {
    return this.d.os ?? process.platform;
  }
  private get arch(): string {
    return this.d.arch ?? process.arch;
  }
  private get fetch(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }

  config(): LocalEngineConfig {
    return { ...DEFAULT_ENGINE_CONFIG, ...this.d.settings.get("localEngine") };
  }

  private save(patch: Partial<LocalEngineConfig>): LocalEngineConfig {
    const next = { ...this.config(), ...patch };
    this.d.settings.set("localEngine", next);
    return next;
  }

  async detectedBackend(): Promise<EngineBackend> {
    return pickBackend(await this.d.hardware(), this.os);
  }

  status(): {
    config: LocalEngineConfig;
    server: LlamaServerState;
    logs: string[];
  } {
    return { config: this.config(), server: this.d.supervisor.status(), logs: this.d.logs?.() ?? [] };
  }

  /**
   * The latest build: llama.cpp publishes each build as a pre-release tagged `b<number>`, so
   * `/releases/latest` names something else (a `v0.x` release without binaries). The newest
   * `b<number>` release with archives is taken instead.
   */
  async latest(): Promise<{ tag: string; assets: ReleaseAsset[] }> {
    const res = await this.fetch(RELEASES, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Jarod-One" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub a refusé la liste des versions de llama.cpp (HTTP ${res.status}).`);
    const body = (await res.json()) as { tag_name?: string; draft?: boolean; assets?: ReleaseAsset[] }[];
    const build = (Array.isArray(body) ? body : [])
      .filter((r) => !r.draft && /^b\d+$/.test(r.tag_name ?? "") && (r.assets?.length ?? 0) > 0)
      .sort((x, y) => Number(y.tag_name!.slice(1)) - Number(x.tag_name!.slice(1)))[0];
    if (!build) throw new Error("Aucune version de llama.cpp avec des binaires dans la réponse de GitHub.");
    return { tag: build.tag_name!, assets: build.assets ?? [] };
  }

  /**
   * Installs the latest release for the chosen (or detected) backend, then removes the previous
   * install. A failed install leaves the previous one in place: the new one is prepared apart.
   */
  async install(onProgress?: (p: EngineProgress) => void, signal?: AbortSignal): Promise<InstalledEngine> {
    const cfg = this.config();
    const backend = cfg.backend || (await this.detectedBackend());
    const { tag, assets } = await this.latest();
    const chosen = pickAssets(assets, backend, this.os, this.arch);
    mkdirSync(this.d.dir, { recursive: true });
    const target = join(this.d.dir, `${tag}-${backend}`);
    const staging = `${target}.part`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      for (const asset of [chosen.engine, chosen.runtime].filter((x): x is ReleaseAsset => Boolean(x))) {
        const data = await this.download(asset, onProgress, signal);
        onProgress?.({ step: "extract", file: asset.name });
        if (asset.name.endsWith(".zip")) extractZip(data, staging);
        else {
          const archive = join(staging, asset.name);
          writeFileSync(archive, data);
          if (!this.d.untar) throw new Error("extraction .tar.gz indisponible sur ce système");
          await this.d.untar(archive, staging);
          rmSync(archive, { force: true });
        }
      }
      if (!findServerBinary(staging, this.os)) throw new Error("llama-server introuvable dans l'archive téléchargée.");
      if (this.running()) await this.stop();
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    const bin = findServerBinary(target, this.os)!;
    if (this.os !== "win32") chmodSync(bin, 0o755);
    const installed: InstalledEngine = { tag, backend, dir: target, bin, at: Date.now() };
    const previous = cfg.installed;
    this.save({ installed });
    if (previous && previous.dir !== target) {
      // Best effort: a file still held by a process (Windows) is left for the next update.
      try {
        rmSync(previous.dir, { recursive: true, force: true });
      } catch {}
    }
    onProgress?.({ step: "done" });
    return installed;
  }

  /** Installs the latest release when it is newer than the installed one. */
  async update(onProgress?: (p: EngineProgress) => void, signal?: AbortSignal): Promise<{ updated: boolean; tag: string }> {
    const current = this.config().installed;
    const { tag } = await this.latest();
    if (current && current.tag === tag && existsSync(current.bin)) return { updated: false, tag };
    const installed = await this.install(onProgress, signal);
    return { updated: true, tag: installed.tag };
  }

  private async download(
    asset: ReleaseAsset,
    onProgress?: (p: EngineProgress) => void,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    // Only the official project's release files, whatever the listing says.
    if (!/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\//.test(asset.browser_download_url)) {
      throw new Error(`adresse de téléchargement inattendue : ${asset.browser_download_url}`);
    }
    const res = await this.fetch(asset.browser_download_url, { redirect: "follow", ...(signal ? { signal } : {}) });
    if (!res.ok || !res.body) throw new Error(`Téléchargement de ${asset.name} refusé (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length") ?? asset.size ?? 0) || null;
    const chunks: Buffer[] = [];
    let received = 0;
    let last = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
      if (received - last > 4 * 1024 * 1024) {
        last = received;
        onProgress?.({ step: "download", file: asset.name, received, total });
      }
    }
    const data = Buffer.concat(chunks);
    onProgress?.({ step: "verify", file: asset.name, received, total });
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : null;
    if (expected) {
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== expected)
        throw new Error(`Empreinte SHA-256 de ${asset.name} différente de celle publiée : fichier refusé.`);
    }
    return data;
  }

  running(): boolean {
    return this.d.supervisor.status().running;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The preset the running server was started with; null when nothing runs (or it was restarted with something else). */
  loadedPreset(): EnginePreset | null {
    const st = this.d.supervisor.status();
    if (!st.running || !this.loadedId) return null;
    return this.config().presets.find((p) => p.id === this.loadedId && p.model === st.model) ?? null;
  }

  private hotswap(): boolean {
    return Boolean(this.d.settings.get("localModels")?.hotswap);
  }

  /**
   * What the chat's model picker lists for llama.cpp: with hotswap, every preset whose model is there (choosing one loads it); without, only the
   * loaded preset (left untouched when nothing is loaded). The address always follows the port.
   */
  publishModels(): void {
    const cfg = this.config();
    const loaded = this.loadedPreset();
    const names = this.hotswap()
      ? [...new Set(cfg.presets.filter((p) => p.model && existsSync(p.model)).map((p) => p.name))]
      : loaded
        ? [loaded.name]
        : null;
    const overrides = { ...this.d.settings.get("providerOverrides") };
    overrides.llamacpp = { ...overrides.llamacpp, baseUrl: `http://127.0.0.1:${cfg.port}/v1`, ...(names ? { models: names } : {}) };
    this.d.settings.set("providerOverrides", overrides);
  }

  /** Replaces the presets (and the active one) as the screen edits them. */
  savePresets(presets: EnginePreset[], activePreset: string): LocalEngineConfig {
    const clean: EnginePreset[] = [];
    for (const p of presets) {
      // One preset per id: a duplicated id would make « start this one » ambiguous.
      if (clean.some((c) => c.id === p.id)) continue;
      const extraArgs = (p.extraArgs ?? []).map((a) => a.trim()).filter(Boolean);
      clean.push(newPreset({ ...p, name: p.name.trim() || "Préréglage", extraArgs }));
    }
    const active = clean.some((p) => p.id === activePreset) ? activePreset : (clean[0]?.id ?? "");
    const saved = this.save({ presets: clean, activePreset: active });
    if (this.hotswap()) this.publishModels();
    return saved;
  }

  /** Remembers the folder chosen for Hugging Face downloads (already validated by the caller, who knows where the profile lives): an absolute path, nothing else. */
  setModelsDir(dir: string): LocalEngineConfig {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, rejects input that contains control characters
    if (typeof dir !== "string" || !isAbsolute(dir) || dir.length > 1024 || /[\u0000-\u001f]/.test(dir)) throw new Error("Dossier des modèles : un chemin absolu est attendu.");
    return this.save({ modelsDir: dir });
  }

  /**
   * The few settings that are not presets, validated here so that every caller (screen, CLI) gets the same rules: a port a user can bind, a backend
   * from the closed list, an active preset that exists. The port cannot change under a running server.
   */
  configure(patch: { port?: number; backend?: EngineBackend | ""; autoStart?: boolean; activePreset?: string }): LocalEngineConfig {
    const cfg = this.config();
    const next: Partial<LocalEngineConfig> = {};
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) throw new Error("Port invalide : un entier de 1024 à 65535 est attendu.");
      if (patch.port !== cfg.port && this.running()) throw new Error("Arrêtez le serveur avant de changer son port.");
      next.port = patch.port;
    }
    if (patch.backend !== undefined) {
      if (patch.backend !== "" && !ENGINE_BACKENDS.includes(patch.backend)) throw new Error(`Moteur inconnu : ${String(patch.backend)}.`);
      next.backend = patch.backend;
    }
    if (patch.autoStart !== undefined) {
      if (typeof patch.autoStart !== "boolean") throw new Error("Démarrage automatique : booléen attendu.");
      next.autoStart = patch.autoStart;
    }
    if (patch.activePreset !== undefined) {
      if (!cfg.presets.some((p) => p.id === patch.activePreset)) throw new Error("Préréglage actif inconnu.");
      next.activePreset = patch.activePreset;
    }
    return this.save(next);
  }

  /**
   * Loads a preset (the active one by default): stops the server Jarod started, starts it again
   * with the preset, and points the llama.cpp provider at it. Switching presets is just this.
   */
  start(presetId?: string): Promise<LlamaServerState> {
    return this.exclusive(() => this.startNow(presetId));
  }

  private async startNow(presetId?: string): Promise<LlamaServerState> {
    const cfg = this.config();
    if (!cfg.installed || !existsSync(cfg.installed.bin)) throw new Error("Le moteur llama.cpp n'est pas installé.");
    const preset = cfg.presets.find((p) => p.id === (presetId || cfg.activePreset)) ?? cfg.presets[0];
    if (!preset) throw new Error("Aucun préréglage : créez-en un avec le chemin d'un modèle GGUF.");
    if (!preset.model || !existsSync(preset.model))
      throw new Error(`Modèle introuvable : ${preset.model || "(aucun)"}`);
    if (preset.draftModel && !existsSync(preset.draftModel))
      throw new Error(`Modèle de brouillon introuvable : ${preset.draftModel}`);
    this.loadedId = null;
    await this.d.supervisor.stop();
    const state = await this.d.supervisor.start({
      bin: cfg.installed.bin,
      model: preset.model,
      port: cfg.port,
      ctxSize: preset.ctxSize,
      gpuLayers: preset.gpuLayers < 0 ? 999 : preset.gpuLayers,
      extraArgs: presetArgs(preset),
    });
    this.loadedId = preset.id;
    this.save({ activePreset: preset.id });
    this.publishModels();
    return state;
  }

  /** Unloads: stops the server Jarod started (and only it). */
  stop(): Promise<boolean> {
    return this.exclusive(() => {
      this.loadedId = null;
      return this.d.supervisor.stop();
    });
  }

  /**
   * At launch: loads the active preset when asked to, silently skipped when anything is missing. No longer called in production: `jarod serve` and the
   * desktop go through `startLocalEngine` (engine-autostart.ts), which adds the test-mode / temporary-profile guards and journals the real state.
   */
  async autoStart(): Promise<void> {
    const cfg = this.config();
    if (!cfg.autoStart || !cfg.installed || !cfg.activePreset) return;
    await this.start().catch(() => undefined);
  }
}
