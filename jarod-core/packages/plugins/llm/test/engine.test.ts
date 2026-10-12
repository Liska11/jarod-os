// Portage de packages/core/test/engine.test.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type EnginePreset,
  EngineService,
  newPreset,
  pickAssets,
  pickBackend,
  presetArgs,
  type ReleaseAsset,
} from "../src/engine.js";
import { LlamaServerSupervisor, type SpawnedProcess } from "../src/llama-server.js";
import { createZip, extractZip } from "@jarod/plugin-rag";
import { makeCore, tempDir } from "./helpers.js";

const URL_BASE = "https://github.com/ggml-org/llama.cpp/releases/download/b11192";

/** The archives of the real b11192 build (September 2026), as GitHub lists them. */
const NAMES = [
  "cudart-llama-b11192-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "cudart-llama-b11192-bin-ubuntu-cuda-13.4-arm64.tar.gz",
  "cudart-llama-b11192-bin-ubuntu-cuda-13.4-x64.tar.gz",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.4-arm64.zip",
  "cudart-llama-bin-win-cuda-13.4-x64.zip",
  "llama-b11192-bin-android-arm64-snapdragon.tar.gz",
  "llama-b11192-bin-android-arm64.tar.gz",
  "llama-b11192-bin-linux-arm64-snapdragon.tar.gz",
  "llama-b11192-bin-macos-arm64.tar.gz",
  "llama-b11192-bin-macos-x64.tar.gz",
  "llama-b11192-bin-ubuntu-arm64.tar.gz",
  "llama-b11192-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "llama-b11192-bin-ubuntu-cuda-13.4-arm64.tar.gz",
  "llama-b11192-bin-ubuntu-cuda-13.4-x64.tar.gz",
  "llama-b11192-bin-ubuntu-openvino-2026.4-x64.tar.gz",
  "llama-b11192-bin-ubuntu-rocm-10.0-x64.tar.gz",
  "llama-b11192-bin-ubuntu-s390x.tar.gz",
  "llama-b11192-bin-ubuntu-sycl-fp16-x64.tar.gz",
  "llama-b11192-bin-ubuntu-sycl-fp32-x64.tar.gz",
  "llama-b11192-bin-ubuntu-vulkan-arm64.tar.gz",
  "llama-b11192-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b11192-bin-ubuntu-x64.tar.gz",
  "llama-b11192-bin-win-cpu-arm64.zip",
  "llama-b11192-bin-win-cpu-x64.zip",
  "llama-b11192-bin-win-cuda-12.4-x64.zip",
  "llama-b11192-bin-win-cuda-13.4-arm64.zip",
  "llama-b11192-bin-win-cuda-13.4-x64.zip",
  "llama-b11192-bin-win-opencl-adreno-arm64.zip",
  "llama-b11192-bin-win-openvino-2026.4-x64.zip",
  "llama-b11192-bin-win-rocm-10.0-x64.zip",
  "llama-b11192-bin-win-sycl-x64.zip",
  "llama-b11192-bin-win-vulkan-x64.zip",
  "llama-b11192-ui.tar.gz",
  "llama-b11192-xcframework.zip",
];
const ASSETS: ReleaseAsset[] = NAMES.map((name) => ({ name, browser_download_url: `${URL_BASE}/${name}` }));

describe("extraction des archives", () => {
  it("extrait une archive et refuse un chemin qui sortirait du dossier", () => {
    const dir = tempDir();
    const files = extractZip(
      createZip([
        { name: "build/bin/llama-server.exe", data: "MZ" },
        { name: "LICENSE", data: "MIT" },
      ]),
      dir,
    );
    expect(files).toHaveLength(2);
    expect(readFileSync(join(dir, "build", "bin", "llama-server.exe"), "utf8")).toBe("MZ");

    const evil = tempDir();
    expect(() => extractZip(createZip([{ name: "../evade.txt", data: "x" }]), evil)).toThrow(/sortirait/);
    expect(existsSync(join(evil, "..", "evade.txt"))).toBe(false);
    expect(() => extractZip(Buffer.from("pas une archive"), evil)).toThrow(/illisible/);
  });
});

describe("le moteur adapté à la machine", () => {
  const gpu = (name: string, backend: string, kind: "dgpu" | "igpu" | "cpu" = "dgpu") => ({
    name,
    vramGb: 12,
    backend,
    kind,
  });

  it("choisit CUDA pour une NVIDIA, ROCm pour une Radeon, Vulkan pour le reste des GPU, Metal sur Mac", () => {
    expect(pickBackend({ gpus: [gpu("RTX 4070", "cuda")], appleSilicon: false }, "win32")).toBe("cuda");
    expect(pickBackend({ gpus: [gpu("RTX 4070", "cuda")], appleSilicon: false }, "linux")).toBe("cuda");
    expect(pickBackend({ gpus: [gpu("Radeon RX 7900", "rocm")], appleSilicon: false }, "win32")).toBe("hip");
    expect(pickBackend({ gpus: [gpu("Arc A770", "vulkan")], appleSilicon: false }, "win32")).toBe("vulkan");
    expect(pickBackend({ gpus: [gpu("Intel Graphics", "sycl", "igpu")], appleSilicon: false }, "win32")).toBe("vulkan");
    expect(pickBackend({ gpus: [], appleSilicon: false }, "win32")).toBe("cpu");
    expect(pickBackend({ gpus: [], appleSilicon: true }, "darwin")).toBe("metal");
  });

  it("prend l'archive publiée pour ce système, avec le runtime CUDA 12 qui va avec", () => {
    const name = (b: Parameters<typeof pickAssets>[1], os: string, arch = "x64") => {
      const r = pickAssets(ASSETS, b, os, arch);
      return [r.engine.name, r.runtime?.name];
    };
    expect(name("cuda", "win32")).toEqual([
      "llama-b11192-bin-win-cuda-12.4-x64.zip",
      "cudart-llama-bin-win-cuda-12.4-x64.zip",
    ]);
    expect(name("cuda", "win32", "arm64")).toEqual([
      "llama-b11192-bin-win-cuda-13.4-arm64.zip",
      "cudart-llama-bin-win-cuda-13.4-arm64.zip",
    ]);
    expect(name("cuda", "linux")).toEqual([
      "llama-b11192-bin-ubuntu-cuda-12.8-x64.tar.gz",
      "cudart-llama-b11192-bin-ubuntu-cuda-12.8-x64.tar.gz",
    ]);
    expect(name("hip", "win32")).toEqual(["llama-b11192-bin-win-rocm-10.0-x64.zip", undefined]);
    expect(name("hip", "linux")).toEqual(["llama-b11192-bin-ubuntu-rocm-10.0-x64.tar.gz", undefined]);
    expect(name("vulkan", "win32")[0]).toBe("llama-b11192-bin-win-vulkan-x64.zip");
    expect(name("sycl", "win32")[0]).toBe("llama-b11192-bin-win-sycl-x64.zip");
    expect(name("sycl", "linux")[0]).toBe("llama-b11192-bin-ubuntu-sycl-fp16-x64.tar.gz");
    expect(name("cpu", "win32", "arm64")[0]).toBe("llama-b11192-bin-win-cpu-arm64.zip");
    expect(name("cpu", "linux")[0]).toBe("llama-b11192-bin-ubuntu-x64.tar.gz");
    expect(name("cpu", "linux", "arm64")[0]).toBe("llama-b11192-bin-ubuntu-arm64.tar.gz");
    expect(name("metal", "darwin", "arm64")[0]).toBe("llama-b11192-bin-macos-arm64.tar.gz");
    expect(() => pickAssets(ASSETS, "sycl", "linux", "arm64")).toThrow(/Aucune version/);
  });

  it("`parallelSlots` : `--parallel N` seulement quand il est posé (absent = défaut de llama-server)", () => {
    expect(presetArgs(newPreset({ name: "a" }))).not.toContain("--parallel");
    expect(presetArgs(newPreset({ name: "a", parallelSlots: 2 })).slice(-2)).toEqual(["--parallel", "2"]);
  });

  it("traduit un préréglage en arguments, sans shell", () => {
    const p: EnginePreset = newPreset({
      name: "qwen-coder",
      model: "C:/m/qwen.gguf",
      cacheType: "q8_0",
      flashAttn: "on",
      temperature: 0.7,
      topK: 20,
      reasoning: "off",
      draftModel: "C:/m/qwen-0.5b.gguf",
      extraArgs: ["--no-mmap", ""],
    });
    expect(presetArgs(p)).toEqual([
      "--jinja",
      "--alias",
      "qwen-coder",
      "-fa",
      "on",
      "--cache-type-k",
      "q8_0",
      "--cache-type-v",
      "q8_0",
      "--temp",
      "0.7",
      "--top-k",
      "20",
      "--reasoning-budget",
      "0",
      "--model-draft",
      "C:/m/qwen-0.5b.gguf",
      "--draft-max",
      "16",
      "--draft-min",
      "1",
      "--no-mmap",
    ]);
    expect(presetArgs(newPreset({ name: "r1", reasoning: "deepseek" }))).toContain("deepseek");
  });
});

/** A fake GitHub: the release listing, then the archives (with their published SHA-256). */
function fakeGithub(archives: Record<string, Buffer>, opts: { tag?: string; wrongDigest?: string; url?: string } = {}) {
  const downloads: string[] = [];
  const assets = Object.entries(archives).map(([name, data]) => ({
    name,
    browser_download_url: opts.url ?? `${URL_BASE}/${name}`,
    size: data.length,
    digest: `sha256:${name === opts.wrongDigest ? "0".repeat(64) : createHash("sha256").update(data).digest("hex")}`,
  }));
  const fetchImpl = (async (url: string) => {
    if (url.includes("api.github.com")) {
      // As on GitHub: builds are pre-releases, and a v0.x release without binaries sits among them.
      const decoy = { tag_name: "v0.5.0", draft: false, assets: [{ name: "nightly-tag.txt" }] };
      const older = { tag_name: "b100", draft: false, prerelease: true, assets };
      const build = { tag_name: opts.tag ?? "b7000", draft: false, prerelease: true, assets };
      return new Response(JSON.stringify([decoy, older, build]));
    }
    downloads.push(url);
    const name = url.split("/").pop()!;
    return new Response(new Uint8Array(archives[name]!));
  }) as typeof fetch;
  return { fetchImpl, downloads };
}

function fakeSupervisor() {
  const spawned: { bin: string; args: string[] }[] = [];
  let alive = false;
  const supervisor = new LlamaServerSupervisor({
    spawn: (bin, args) => {
      spawned.push({ bin, args });
      alive = true;
      const kill = () => {
        alive = false;
        return true;
      };
      return { pid: 4242, kill, on: () => {} } as SpawnedProcess;
    },
    // Nothing listens before our server starts; it answers once spawned, until killed.
    probe: async () => alive,
  });
  return { supervisor, spawned };
}

function engine(core: Awaited<ReturnType<typeof makeCore>>, fetchImpl: typeof fetch, supervisor = fakeSupervisor().supervisor) {
  const dir = tempDir();
  return new EngineService({
    dir,
    settings: core.settings,
    supervisor,
    hardware: async () => ({
      gpus: [{ name: "RTX 4070", vramGb: 12, backend: "cuda", kind: "dgpu" as const }],
      appleSilicon: false,
    }),
    fetchImpl,
    os: "win32",
    arch: "x64",
  });
}

const ENGINE_ZIP = createZip([
  { name: "llama-server.exe", data: "MZ-serveur" },
  { name: "ggml-cuda.dll", data: "dll" },
]);
const CUDART_ZIP = createZip([{ name: "cudart64_12.dll", data: "cudart" }]);

describe("installation et mise à jour", () => {
  it("installe la version officielle pour le GPU détecté, vérifiée, avec son runtime CUDA", async () => {
    const core = await makeCore();
    const { fetchImpl, downloads } = fakeGithub({
      "llama-b7000-bin-win-cuda-12.4-x64.zip": ENGINE_ZIP,
      "cudart-llama-bin-win-cuda-12.4-x64.zip": CUDART_ZIP,
    });
    const e = engine(core, fetchImpl);
    const steps: string[] = [];
    const installed = await e.install((p) => steps.push(p.step));
    expect(installed).toMatchObject({ tag: "b7000", backend: "cuda" });
    expect(readFileSync(installed.bin, "utf8")).toBe("MZ-serveur");
    expect(existsSync(join(installed.dir, "cudart64_12.dll"))).toBe(true);
    expect(downloads).toHaveLength(2);
    expect(steps).toContain("verify");
    expect(steps.at(-1)).toBe("done");
    expect(core.settings.get("localEngine").installed?.bin).toBe(installed.bin);

    // Same tag published: nothing to do.
    expect(await e.update()).toEqual({ updated: false, tag: "b7000" });
  });

  it("refuse un fichier dont l'empreinte diffère, et garde l'installation précédente", async () => {
    const core = await makeCore();
    const good = fakeGithub({ "llama-b7000-bin-win-vulkan-x64.zip": ENGINE_ZIP });
    core.settings.set("localEngine", { ...core.settings.get("localEngine"), backend: "vulkan" });
    const first = await engine(core, good.fetchImpl).install();

    const tampered = fakeGithub(
      { "llama-b7001-bin-win-vulkan-x64.zip": ENGINE_ZIP },
      {
        tag: "b7001",
        wrongDigest: "llama-b7001-bin-win-vulkan-x64.zip",
      },
    );
    await expect(engine(core, tampered.fetchImpl).install()).rejects.toThrow(/SHA-256/);
    expect(core.settings.get("localEngine").installed?.tag).toBe("b7000");
    expect(existsSync(first.bin)).toBe(true);

    const elsewhere = fakeGithub(
      { "llama-b7002-bin-win-vulkan-x64.zip": ENGINE_ZIP },
      {
        tag: "b7002",
        url: "https://exemple.invalid/llama-b7002-bin-win-vulkan-x64.zip",
      },
    );
    await expect(engine(core, elsewhere.fetchImpl).install()).rejects.toThrow(/inattendue/);
  });
});

describe("configure : port, moteur, démarrage automatique, préréglage actif", () => {
  it("valide chaque champ ; le port ne change pas sous un serveur qui tourne ; rien n'est écrit quand un champ est refusé", async () => {
    const core = await makeCore();
    const { supervisor } = fakeSupervisor();
    const e = engine(core, fakeGithub({}).fetchImpl, supervisor);
    const gguf = join(tempDir(), "m.gguf");
    mkdirSync(join(gguf, ".."), { recursive: true });
    writeFileSync(gguf, "x");
    e.savePresets([newPreset({ id: "a", name: "A", model: gguf }), newPreset({ id: "b", name: "B", model: gguf })], "a");
    expect(e.configure({ port: 9001, backend: "vulkan", autoStart: true, activePreset: "b" })).toMatchObject({ port: 9001, backend: "vulkan", autoStart: true, activePreset: "b" });
    for (const port of [80, 1023, 65536, 8080.5, Number.NaN]) expect(() => e.configure({ port })).toThrow(/Port invalide/);
    expect(() => e.configure({ backend: "directx" as never })).toThrow(/Moteur inconnu/);
    expect(() => e.configure({ autoStart: "oui" as never })).toThrow(/booléen/);
    expect(() => e.configure({ activePreset: "zzz" })).toThrow(/inconnu/);
    expect(() => e.configure({ port: 9002, activePreset: "zzz" })).toThrow(); // tout ou rien
    expect(e.config()).toMatchObject({ port: 9001, backend: "vulkan", autoStart: true, activePreset: "b" });
    expect(e.configure({ backend: "" }).backend).toBe("");
  });

  it("serveur en marche : changer le port est refusé, le garder est permis", async () => {
    const core = await makeCore();
    const github = fakeGithub({ "llama-b7000-bin-win-vulkan-x64.zip": ENGINE_ZIP });
    core.settings.set("localEngine", { ...core.settings.get("localEngine"), backend: "vulkan" });
    const { supervisor } = fakeSupervisor();
    const e = engine(core, github.fetchImpl, supervisor);
    await e.install();
    const gguf = join(tempDir(), "m.gguf");
    mkdirSync(join(gguf, ".."), { recursive: true });
    writeFileSync(gguf, "x");
    e.savePresets([newPreset({ id: "a", name: "A", model: gguf })], "a");
    await e.start();
    expect(e.running()).toBe(true);
    expect(() => e.configure({ port: 9100 })).toThrow(/Arrêtez le serveur/);
    expect(e.configure({ port: e.config().port }).port).toBe(8080);
  });
});

describe("préréglages", () => {
  it("charge un préréglage, branche le fournisseur llama.cpp dessus, et en change sans toucher un fichier", async () => {
    const core = await makeCore();
    const { fetchImpl } = fakeGithub({
      "llama-b7000-bin-win-cuda-12.4-x64.zip": ENGINE_ZIP,
      "cudart-llama-bin-win-cuda-12.4-x64.zip": CUDART_ZIP,
    });
    const { supervisor, spawned } = fakeSupervisor();
    const e = engine(core, fetchImpl, supervisor);
    await e.install();

    const models = tempDir();
    mkdirSync(models, { recursive: true });
    const gguf = join(models, "qwen.gguf");
    writeFileSync(gguf, "GGUF");
    const cfg = e.savePresets(
      [
        newPreset({ id: "a", name: "rapide", model: gguf, ctxSize: 8192, gpuLayers: -1 }),
        newPreset({ id: "b", name: "  ", model: gguf, reasoning: "off", extraArgs: [" --no-mmap ", ""] }),
        newPreset({ id: "a", name: "doublon", model: gguf }),
      ],
      "zzz",
    );
    expect(cfg.presets.map((p) => [p.id, p.name])).toEqual([
      ["a", "rapide"],
      ["b", "Préréglage"],
    ]);
    expect(cfg.activePreset).toBe("a");
    expect(cfg.presets[1]!.extraArgs).toEqual(["--no-mmap"]);

    const state = await e.start();
    expect(state).toMatchObject({ running: true, ready: true, port: 8080 });
    expect(spawned[0]!.bin).toBe(core.settings.get("localEngine").installed!.bin);
    expect(spawned[0]!.args).toEqual(
      expect.arrayContaining(["-m", gguf, "--host", "127.0.0.1", "-c", "8192", "-ngl", "999", "--alias", "rapide"]),
    );
    expect(core.providers.def("llamacpp")).toMatchObject({ baseUrl: "http://127.0.0.1:8080/v1", models: ["rapide"] });

    await e.start("b");
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.args).toEqual(expect.arrayContaining(["--reasoning-budget", "0", "--no-mmap"]));
    expect(core.settings.get("localEngine").activePreset).toBe("b");
    expect(await e.stop()).toBe(true);
  });

  it("dit ce qui manque au lieu de lancer n'importe quoi", async () => {
    const core = await makeCore();
    const e = engine(core, fakeGithub({}).fetchImpl);
    await expect(e.start()).rejects.toThrow(/pas installé/);
    core.settings.set("localEngine", {
      ...core.settings.get("localEngine"),
      installed: { tag: "b1", backend: "cpu", dir: "x", bin: process.execPath, at: 0 },
    });
    await expect(e.start()).rejects.toThrow(/Aucun préréglage/);
    e.savePresets([newPreset({ id: "a", model: "C:/nulle-part.gguf" })], "a");
    await expect(e.start()).rejects.toThrow(/Modèle introuvable/);
  });
});
