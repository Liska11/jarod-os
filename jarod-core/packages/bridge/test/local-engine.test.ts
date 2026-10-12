/**
 * SPECS-P5-UI-PARITE.md §3.5 — moteur local llama.cpp. Invariants : AUCUN chemin ne vient du renderer (modèle et brouillon par la boîte « Ouvrir »),
 * AUCUN argument libre (`extraArgs` : gardé ou vidé, jamais écrit), télécharger passe par une boîte native et se limite au dépôt officiel, l'estimation de
 * mémoire vient de `gguf-fit` et n'est qu'une indication. VRAI kernel, VRAI `EngineService` ; seuls le superviseur (aucun llama-server n'est lancé) et la
 * détection du matériel sont remplacés.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnginePreset } from "@jarod/contracts";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { newPreset } from "@jarod/plugin-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

const GIB = 1024 ** 3;
const HW = { platform: "win32", cpu: "Test CPU", cores: 8, ramGb: 32, gpus: [{ name: "NVIDIA Test", vramGb: 12, kind: "dgpu", backend: "cuda", sharedMemory: false }], appleSilicon: false };

/** Un en-tête GGUF minimal (architecture standard : 40 couches, 8 têtes KV de 128 → 163 840 octets de cache par jeton à 16 bits) suivi de `padding` octets. */
function ggufFile(name: string, padding = 1_000_000): string {
  const bytes: number[] = [];
  const u32 = (n: number) => bytes.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const u64 = (n: number) => {
    u32(n);
    u32(0);
  };
  const str = (s: string) => {
    u64(s.length);
    for (const c of s) bytes.push(c.charCodeAt(0));
  };
  const entries: [string, string | number][] = [
    ["general.architecture", "llama"],
    ["llama.block_count", 40],
    ["llama.context_length", 131072],
    ["llama.embedding_length", 5120],
    ["llama.attention.head_count", 40],
    ["llama.attention.head_count_kv", 8],
  ];
  for (const c of "GGUF") bytes.push(c.charCodeAt(0));
  u32(3);
  u64(0);
  u64(entries.length);
  for (const [k, v] of entries) {
    str(k);
    if (typeof v === "string") {
      u32(8);
      str(v);
    } else {
      u32(4);
      u32(v);
    }
  }
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([Buffer.from(bytes), Buffer.alloc(padding, 7)]));
  return path;
}

interface View {
  installed: { tag: string; backend: string; present: boolean } | null;
  installing: boolean;
  backend: string;
  detectedBackend: string;
  port: number;
  autoStart: boolean;
  activePreset: string;
  presets: (EnginePreset & { modelName: string; modelPresent: boolean; draftModelName: string })[];
  server: { running: boolean };
  hardware: { budgetGb: number; budgetBasis: string; gpus: { name: string }[] };
}

async function wired(o: { picks?: (string | null)[]; confirms?: boolean[] } = {}) {
  const picks = o.picks ?? [];
  const k = await setupKernel(undefined, o.confirms ?? [], { pickFile: async () => picks.shift() ?? null });
  const llm = (k.app as unknown as { llm: { engine: import("@jarod/plugin-llm").EngineService; localServer: { start: (...a: unknown[]) => unknown; stop: () => unknown; status: () => unknown }; detectHardware: () => Promise<unknown> } }).llm;
  llm.detectHardware = async () => HW;
  return { ...k, llm, engine: llm.engine, picks };
}

/** Un moteur « installé » (binaire factice présent sur disque) et un préréglage, pour les chemins qui démarrent ou estiment. */
async function withPreset(extra: Partial<EnginePreset> = {}) {
  const model = ggufFile("model.gguf");
  const k = await wired({ picks: [model] });
  const bin = join(tempDir(), "llama-server.exe");
  mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(bin, "MZ");
  k.app.agent.settings.set("localEngine", { ...k.engine.config(), installed: { tag: "b7000", backend: "cuda", dir: join(bin, ".."), bin, at: 1 } });
  const view = (await k.call("local-engine-add-preset")) as View;
  const id = view.presets[0]!.id;
  if (Object.keys(extra).length) k.engine.savePresets(k.engine.config().presets.map((p) => ({ ...p, ...extra })), id);
  return { ...k, model, id, bin };
}

describe("moteur local : état", () => {
  it("l'état : matériel détecté, budget de mémoire (VRAM du GPU), moteur non installé, aucun préréglage", async () => {
    const { call } = await wired();
    const v = (await call("local-engine-status")) as View;
    expect(v).toMatchObject({ installed: null, installing: false, backend: "", detectedBackend: "cuda", port: 8080, autoStart: false, presets: [], activePreset: "", server: { running: false } });
    expect(v.hardware).toMatchObject({ budgetGb: 12, budgetBasis: "gpu-memory" });
    expect(v.hardware.gpus[0]!.name).toBe("NVIDIA Test");
  });
});

describe("moteur local : préréglages sans chemin ni argument libre", () => {
  it("nouveau préréglage : la boîte native choisit le modèle (nom tiré du fichier), annulée → null, refus d'un fichier qui n'est pas .gguf", async () => {
    const model = ggufFile("Qwen3-Test-Q4_K_M.gguf");
    const text = join(tempDir(), "notes.txt");
    mkdirSync(join(text, ".."), { recursive: true });
    writeFileSync(text, "pas un modèle");
    const { call, picks } = await wired({ picks: [model, null, text] });
    const v = (await call("local-engine-add-preset")) as View;
    expect(v.presets).toHaveLength(1);
    expect(v.presets[0]).toMatchObject({ name: "Qwen3-Test-Q4_K_M", model, modelName: "Qwen3-Test-Q4_K_M.gguf", modelPresent: true, draftModel: "", parallelSlots: 1, extraArgs: [], ctxSize: 32768, cacheType: "f16" });
    expect(v.activePreset).toBe(v.presets[0]!.id);
    expect(await call("local-engine-add-preset")).toBeNull();
    await rejects(() => call("local-engine-add-preset"), /pas un fichier \.gguf/);
    expect(picks).toHaveLength(0);
    expect(((await call("local-engine-status")) as View).presets).toHaveLength(1);
    const none = await setupKernel();
    await rejects(() => none.call("local-engine-add-preset"), /indisponible/);
  });

  it("enregistrer : réglages bornés écrits ; l'objet reçu de `status` se renvoie tel quel ; créneaux vidés = défaut du serveur", async () => {
    const { call, id } = await withPreset();
    const before = ((await call("local-engine-status")) as View).presets[0]!;
    const edited = { ...before, name: "  Rapide  ", ctxSize: 16384, gpuLayers: 20, flashAttn: "on", cacheType: "q8_0", temperature: 0.7, topP: 0.9, topK: 40, minP: 0.05, reasoning: "off", parallelSlots: 2 };
    const v = (await call("local-engine-preset-save", edited)) as View;
    expect(v.presets[0]).toMatchObject({ id, name: "Rapide", ctxSize: 16384, gpuLayers: 20, flashAttn: "on", cacheType: "q8_0", temperature: 0.7, topP: 0.9, topK: 40, minP: 0.05, reasoning: "off", parallelSlots: 2, model: before.model });
    const cleared = (await call("local-engine-preset-save", { ...v.presets[0]!, parallelSlots: null, temperature: null })) as View;
    expect(cleared.presets[0]!.parallelSlots).toBeUndefined();
    expect(cleared.presets[0]!.temperature).toBeNull();
  });

  it("le chemin du modèle ne se tape pas : un autre chemin est refusé, le brouillon ne se vide que (jamais un chemin tapé)", async () => {
    const { call, id } = await withPreset();
    const cur = ((await call("local-engine-status")) as View).presets[0]!;
    await rejects(() => call("local-engine-preset-save", { ...cur, model: "C:/Windows/System32/cmd.exe" }), /boîte « Ouvrir »/);
    await rejects(() => call("local-engine-preset-save", { ...cur, draftModel: ggufFile("autre.gguf") }), /brouillon.*boîte « Ouvrir »/);
    expect(((await call("local-engine-status")) as View).presets[0]).toMatchObject({ id, model: cur.model, draftModel: "" });
  });

  it("jamais d'argument libre : un `extraArgs` tapé est refusé ; celui qui est déjà enregistré se garde ou se vide", async () => {
    const { call, engine, id } = await withPreset();
    engine.savePresets(engine.config().presets.map((p) => ({ ...p, extraArgs: ["--no-mmap"] })), id);
    const cur = ((await call("local-engine-status")) as View).presets[0]!;
    expect(cur.extraArgs).toEqual(["--no-mmap"]);
    await rejects(() => call("local-engine-preset-save", { ...cur, extraArgs: ["--host", "0.0.0.0"] }), /ne se tapent pas/);
    await rejects(() => call("local-engine-preset-save", { ...cur, extraArgs: ["--no-mmap", "--host", "0.0.0.0"] }), /ne se tapent pas/);
    await rejects(() => call("local-engine-preset-save", { ...cur, extraArgs: "x" }), /liste attendue/);
    expect(engine.config().presets[0]!.extraArgs).toEqual(["--no-mmap"]);
    expect(((await call("local-engine-preset-save", { ...cur, name: "Autre" })) as View).presets[0]!.extraArgs).toEqual(["--no-mmap"]); // gardé tel quel
    expect(((await call("local-engine-preset-save", { ...cur, extraArgs: [] })) as View).presets[0]!.extraArgs).toEqual([]); // vidé
  });

  it("champs inconnus, valeurs hors bornes, nom invalide, préréglage inconnu : refusés, RIEN n'est écrit", async () => {
    const { call, id, engine } = await withPreset();
    const cur = ((await call("local-engine-status")) as View).presets[0]!;
    const snapshot = JSON.stringify(engine.config().presets);
    await rejects(() => call("local-engine-preset-save", { ...cur, apiKey: "x" }), /non accepté/);
    await rejects(() => call("local-engine-preset-save", { ...cur, ctxSize: 100 }), /ctxSize/);
    await rejects(() => call("local-engine-preset-save", { ...cur, ctxSize: 32768.5 }), /ctxSize/);
    await rejects(() => call("local-engine-preset-save", { ...cur, gpuLayers: 1000 }), /gpuLayers/);
    await rejects(() => call("local-engine-preset-save", { ...cur, flashAttn: "yes" }), /flashAttn/);
    await rejects(() => call("local-engine-preset-save", { ...cur, cacheType: "q2_k" }), /cacheType/);
    await rejects(() => call("local-engine-preset-save", { ...cur, reasoning: "max" }), /reasoning/);
    await rejects(() => call("local-engine-preset-save", { ...cur, temperature: 9 }), /temperature/);
    await rejects(() => call("local-engine-preset-save", { ...cur, topP: Number.NaN }), /topP/);
    await rejects(() => call("local-engine-preset-save", { ...cur, topK: -1 }), /topK/);
    await rejects(() => call("local-engine-preset-save", { ...cur, parallelSlots: 17 }), /parallelSlots/);
    await rejects(() => call("local-engine-preset-save", { ...cur, name: "" }), /nom/);
    await rejects(() => call("local-engine-preset-save", { ...cur, name: "a\u0007b" }), /nom/);
    await rejects(() => call("local-engine-preset-save", { ...cur, name: "x".repeat(61) }), /nom/);
    await rejects(() => call("local-engine-preset-save", { ...cur, id: "inconnu" }), /inconnu/);
    await rejects(() => call("local-engine-preset-save", { ...cur, id: "../x" }), /identifiant/);
    await rejects(() => call("local-engine-preset-save", "oui"), /préréglage attendu/);
    expect(JSON.stringify(engine.config().presets)).toBe(snapshot);
    expect(id).toBe(cur.id);
  });

  it("changer de modèle ou de brouillon : boîte native ; annulée → null ; champ et préréglage inconnus refusés", async () => {
    const { call, picks, id } = await withPreset();
    const other = ggufFile("autre.gguf");
    const draft = ggufFile("petit.gguf");
    picks.push(other, null, draft);
    expect(((await call("local-engine-pick-model", id, "model")) as View).presets[0]!.model).toBe(other);
    expect(await call("local-engine-pick-model", id, "model")).toBeNull();
    const v = (await call("local-engine-pick-model", id, "draftModel")) as View;
    expect(v.presets[0]).toMatchObject({ model: other, draftModel: draft, draftModelName: "petit.gguf" });
    await rejects(() => call("local-engine-pick-model", id, "extraArgs"), /champ/);
    await rejects(() => call("local-engine-pick-model", "nope", "model"), /inconnu/);
    // vider le brouillon est permis par `preset-save`
    expect(((await call("local-engine-preset-save", { ...v.presets[0]!, draftModel: "" })) as View).presets[0]!.draftModel).toBe("");
  });

  it("supprimer : le préréglage actif supprimé laisse le premier restant actif (règle du service)", async () => {
    const second = ggufFile("deux.gguf");
    const { call, picks, id } = await withPreset();
    picks.push(second);
    const two = (await call("local-engine-add-preset")) as View;
    expect(two.presets).toHaveLength(2);
    const after = (await call("local-engine-preset-remove", id)) as View;
    expect(after.presets).toHaveLength(1);
    expect(after.activePreset).toBe(after.presets[0]!.id);
    await rejects(() => call("local-engine-preset-remove", id), /inconnu/);
  });

  it("20 préréglages au plus", async () => {
    const { call, engine, picks } = await wired();
    engine.savePresets(Array.from({ length: 20 }, (_, i) => newPreset({ id: `p${i}`, name: `P${i}`, model: ggufFile(`m${i}.gguf`, 10) })), "p0");
    picks.push(ggufFile("de-trop.gguf", 10));
    await rejects(() => call("local-engine-add-preset"), /20 préréglages/);
  });
});

describe("moteur local : réglages et démarrage", () => {
  it("configure : champs validés par le service, champ inconnu refusé, le port ne change pas sous un serveur qui tourne", async () => {
    const { call, llm, id } = await withPreset();
    const v = (await call("local-engine-configure", { port: 9001, backend: "vulkan", autoStart: true, activePreset: id })) as View;
    expect(v).toMatchObject({ port: 9001, backend: "vulkan", autoStart: true, activePreset: id });
    await rejects(() => call("local-engine-configure", { port: 80 }), /Port invalide/);
    await rejects(() => call("local-engine-configure", { backend: "directx" }), /Moteur inconnu/);
    await rejects(() => call("local-engine-configure", { activePreset: "zzz" }), /inconnu/);
    await rejects(() => call("local-engine-configure", { installed: { bin: "C:/x.exe" } }), /non accepté/);
    await rejects(() => call("local-engine-configure", { localEngine: {} }), /non accepté/);
    await rejects(() => call("local-engine-configure", "x"), /attendus/);
    llm.localServer.status = () => ({ running: true, ready: true, port: 9001, pid: 1, model: "m", restarts: 0, lastError: null });
    await rejects(() => call("local-engine-configure", { port: 9002 }), /Arrêtez le serveur/);
  });

  it("démarrer : le serveur reçoit le préréglage en champs structurés ; ctx, GPU (-1 = tout), cache, créneaux ; les arguments avancés gardés ; hôte seulement 127.0.0.1", async () => {
    const { call, llm, id, model, engine } = await withPreset();
    engine.savePresets(engine.config().presets.map((p) => ({ ...p, extraArgs: ["--no-mmap"] })), id);
    const cur = ((await call("local-engine-status")) as View).presets[0]!;
    await call("local-engine-preset-save", { ...cur, ctxSize: 8192, cacheType: "q8_0", parallelSlots: 2, flashAttn: "on" });
    const started: { model: string; port: number; ctxSize: number; gpuLayers: number; extraArgs: string[] }[] = [];
    llm.localServer.stop = async () => false;
    llm.localServer.start = async (c: unknown) => {
      started.push(c as (typeof started)[number]);
      return { running: true, ready: true, port: 8080, pid: 7, model, restarts: 0, lastError: null };
    };
    llm.localServer.status = () => ({ running: false, ready: false, port: null, pid: null, model: null, restarts: 0, lastError: null });
    await call("local-engine-start", id);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ model, port: 8080, ctxSize: 8192, gpuLayers: 999 });
    const args = started[0]!.extraArgs;
    expect(args).toEqual(expect.arrayContaining(["--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--parallel", "2", "-fa", "on", "--no-mmap"]));
    expect(args).not.toContain("--host");
    await rejects(() => call("local-engine-start", "inconnu"), /inconnu/);
    await call("local-engine-stop");
  });

  it("démarrer sans moteur installé : le service refuse avec son message", async () => {
    const k = await wired();
    await rejects(() => k.call("local-engine-start"), /pas installé/);
  });
});

describe("moteur local : télécharger", () => {
  it("boîte native d'abord : dépôt officiel, moteur, ce que ça remplace ; refusée → rien ne se télécharge", async () => {
    const { call, engine, confirms } = await wired({ confirms: [false] });
    const install = vi.spyOn(engine, "install").mockResolvedValue({ tag: "b1", backend: "cuda", dir: "d", bin: "b", at: 1 });
    await rejects(() => call("local-engine-install"), /refusé par l'utilisateur/);
    expect(install).not.toHaveBeenCalled();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.message).toBe("Télécharger le moteur llama.cpp ?");
    expect(confirms[0]!.detail).toContain("github.com/ggml-org/llama.cpp");
    expect(confirms[0]!.detail).toContain("« cuda »");
    expect(confirms[0]!.detail).toContain("SHA-256");
  });

  it("accepté : progression relayée par l'événement, un seul téléchargement à la fois, installation déjà là → mise à jour", async () => {
    const { call, engine, on, app, confirms } = await wired({ confirms: [true, true] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const install = vi.spyOn(engine, "install").mockImplementation(async (progress) => {
      progress?.({ step: "download", file: "llama.zip", received: 5, total: 10 });
      await gate;
      return { tag: "b7000", backend: "cuda", dir: "d", bin: "b", at: 1 };
    });
    const first = call("local-engine-install") as Promise<View>;
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(on("local-engine-progress")).toEqual([[{ step: "download", file: "llama.zip", received: 5, total: 10 }]]);
    await rejects(() => call("local-engine-install"), /déjà en cours/);
    expect(((await call("local-engine-status")) as View).installing).toBe(true);
    release();
    expect((await first).installing).toBe(false);
    expect(confirms).toHaveLength(1); // la deuxième demande a été refusée AVANT sa boîte

    // moteur déjà installé (binaire présent) : c'est une mise à jour, la boîte le dit
    const bin = join(tempDir(), "llama-server.exe");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "MZ");
    app.agent.settings.set("localEngine", { ...engine.config(), installed: { tag: "b6000", backend: "cuda", dir: join(bin, ".."), bin, at: 1 } });
    const update = vi.spyOn(engine, "update").mockResolvedValue({ updated: true, tag: "b7000" });
    await call("local-engine-install");
    expect(update).toHaveBeenCalledTimes(1);
    expect(confirms[1]!.message).toBe("Mettre à jour le moteur llama.cpp ?");
    expect(confirms[1]!.detail).toContain("b6000");
  });

  it("annulation : le signal est interrompu, l'erreur est « annulée », un nouveau téléchargement redevient possible", async () => {
    const { call, engine } = await wired({ confirms: [true, true] });
    const seen: AbortSignal[] = [];
    vi.spyOn(engine, "install").mockImplementation((_p, signal) => {
      seen.push(signal!);
      return new Promise((_ok, fail) => signal!.addEventListener("abort", () => fail(new Error("aborted"))));
    });
    const running = call("local-engine-install");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(await call("local-engine-install-cancel")).toBe(true);
    await rejects(() => running, /annulée/);
    expect(seen[0]!.aborted).toBe(true);
    expect(await call("local-engine-install-cancel")).toBe(false);
    expect(((await call("local-engine-status")) as View).installing).toBe(false);
    // une erreur ordinaire est rendue telle quelle et libère aussi le verrou
    vi.spyOn(engine, "install").mockRejectedValue(new Error("GitHub a refusé la liste"));
    await rejects(() => call("local-engine-install"), /GitHub a refusé/);
    expect(((await call("local-engine-status")) as View).installing).toBe(false);
  });
});

describe("moteur local : « tient-il ? » (gguf-fit)", () => {
  interface Fit {
    fit: { status: string; breakdown: { weightsBytes: number; kvBytes: number; stateBytes: number; headroomBytes: number } | null; reason?: string };
    maxContext: { contextTokens: number | null; limitedBy: string | null } | null;
    notes: string[];
    budgetBytes: number;
    budgetBasis: string;
  }

  it("rapport du modèle ENREGISTRÉ : poids, KV à part, état, marge ; budget = VRAM ; contexte maximal ; réglages en cours d'édition pris en compte", async () => {
    const { call, id, model } = await withPreset();
    const r = (await call("local-engine-fit", { id, ctxSize: 8192, cacheType: "f16", gpuLayers: -1, parallelSlots: 1 })) as Fit;
    expect(r.budgetBytes).toBe(12 * GIB);
    expect(r.budgetBasis).toBe("gpu-memory");
    expect(r.fit.status).toBe("fits");
    expect(r.fit.breakdown!.kvBytes).toBe(163_840 * 8192); // KV propre, jamais fondu dans un total
    expect(r.fit.breakdown!.weightsBytes).toBeGreaterThan(1_000_000);
    expect(r.maxContext!.limitedBy).toBe("memory");
    const q8 = (await call("local-engine-fit", { id, ctxSize: 8192, cacheType: "q8_0", gpuLayers: -1, parallelSlots: 1 })) as Fit;
    expect(q8.fit.breakdown!.kvBytes).toBeLessThan(r.fit.breakdown!.kvBytes);
    expect(q8.maxContext!.contextTokens!).toBeGreaterThan(r.maxContext!.contextTokens!);
    // un chemin envoyé par l'écran n'est JAMAIS lu : le rapport est celui du modèle enregistré
    const sneaky = (await call("local-engine-fit", { id, model: "C:/Windows/System32/config/SAM", ctxSize: 8192, cacheType: "f16", gpuLayers: -1 })) as Fit;
    expect(sneaky.fit.breakdown!.weightsBytes).toBe(r.fit.breakdown!.weightsBytes);
    expect(model).toBeTruthy();
  });

  it("contexte trop grand → ne tient pas ; décharge partielle → pas de verdict, note ; brouillon et créneaux au défaut → notes", async () => {
    const { call, id, engine } = await withPreset();
    const big = (await call("local-engine-fit", { id, ctxSize: 131072, cacheType: "f16", gpuLayers: -1, parallelSlots: 1 })) as Fit;
    expect(big.fit.status).toBe("does-not-fit");
    const partial = (await call("local-engine-fit", { id, ctxSize: 131072, cacheType: "f16", gpuLayers: 10, parallelSlots: 1 })) as Fit;
    expect(partial.fit.status).toBe("estimated");
    expect(partial.maxContext).toBeNull();
    expect(partial.notes).toContain("partial-offload");
    const draft = ggufFile("brouillon.gguf", 10);
    engine.savePresets(engine.config().presets.map((p) => ({ ...p, draftModel: draft })), id);
    const withDraft = (await call("local-engine-fit", { id, ctxSize: 4096, cacheType: "f16", gpuLayers: -1, parallelSlots: null })) as Fit;
    expect(withDraft.notes).toEqual(expect.arrayContaining(["draft-model-not-counted", "parallel-slots-default"]));
  });

  it("modèle disparu : « non estimé » avec la raison, aucune exception ; réglages invalides refusés", async () => {
    const { call, id, model } = await withPreset();
    const { rmSync } = await import("node:fs");
    rmSync(model);
    const r = (await call("local-engine-fit", { id })) as Fit;
    expect(r.fit.status).toBe("not-estimated");
    expect(r.fit.breakdown).toBeNull();
    expect(r.fit.reason).toMatch(/illisible/);
    await rejects(() => call("local-engine-fit", { id, ctxSize: 5 }), /ctxSize/);
    await rejects(() => call("local-engine-fit", { id: "nope" }), /inconnu/);
    await rejects(() => call("local-engine-fit", 3), /demande attendue/);
  });

  it("démarrer n'est pas conditionné au verdict : un contexte qui « ne tient pas » démarre quand même (indication, pas un blocage)", async () => {
    const { call, llm, id } = await withPreset();
    const cur = ((await call("local-engine-status")) as View).presets[0]!;
    await call("local-engine-preset-save", { ...cur, ctxSize: 2_097_152 });
    const fit = (await call("local-engine-fit", { id })) as Fit;
    expect(["does-not-fit", "beyond-native-context"]).toContain(fit.fit.status);
    let started = 0;
    llm.localServer.stop = async () => false;
    llm.localServer.start = async () => {
      started += 1;
      return { running: true, ready: true, port: 8080, pid: 1, model: "m", restarts: 0, lastError: null };
    };
    llm.localServer.status = () => ({ running: false, ready: false, port: null, pid: null, model: null, restarts: 0, lastError: null });
    await call("local-engine-start", id);
    expect(started).toBe(1);
  });
});
