import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineService, newPreset } from "../src/engine.js";
import { LlamaServerSupervisor, type SpawnedProcess } from "../src/llama-server.js";
import { DEFAULT_LM_CONTEXT, defaultLmContext, type LocalModelActivity, LocalModelsService } from "../src/local-models.js";
import { secretKeyFor } from "../src/providers.js";
import { makeCore, tempDir } from "./helpers.js";

type FakeModel = { key: string; type?: string; instances?: string[]; ctx?: number; max?: number };

/**
 * A fake LM Studio speaking its REST v1 API, on 127.0.0.1 (the real one of this machine is never called). Loaded without `context_length`, a
 * model gets 4096 (LM Studio's own choice); `ctx` is the context of the instances it starts with.
 */
function fakeLmStudio(models: FakeModel[], loadDelayMs = 0) {
  const state = models.map((m) => ({ key: m.key, type: m.type ?? "llm", instances: [...(m.instances ?? [])], ctx: m.ctx ?? 4096, max: m.max }));
  const calls: string[] = [];
  const loads: Record<string, unknown>[] = [];
  const auth: (string | undefined)[] = [];
  let server: Server;
  const ready = new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        auth.push(req.headers.authorization);
        const json = body ? (JSON.parse(body) as Record<string, string>) : {};
        const raw = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && req.url === "/api/v1/models") {
          calls.push("list");
          return reply(200, {
            models: state.map((m) => ({ type: m.type, key: m.key, display_name: m.key.toUpperCase(), size_bytes: 1000, max_context_length: m.max, loaded_instances: m.instances.map((id) => ({ id, config: { context_length: m.ctx } })) })),
          });
        }
        if (req.method === "POST" && req.url === "/api/v1/models/load") {
          calls.push(`load ${json.model}`);
          loads.push(raw);
          const m = state.find((x) => x.key === json.model);
          if (!m) return reply(404, { error: { message: "model not found" } });
          return void setTimeout(() => {
            m.instances.push(m.key);
            m.ctx = typeof raw.context_length === "number" ? raw.context_length : 4096;
            reply(200, { type: m.type, instance_id: m.key, status: "loaded", load_time_seconds: 1 });
          }, loadDelayMs);
        }
        if (req.method === "POST" && req.url === "/api/v1/models/unload") {
          calls.push(`unload ${json.instance_id}`);
          for (const m of state) m.instances = m.instances.filter((i) => i !== json.instance_id);
          return reply(200, { instance_id: json.instance_id });
        }
        reply(404, { error: "unknown" });
      });
    }).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
  servers.push(() => server.close());
  return { ready, state, calls, auth, loads };
}

const servers: (() => void)[] = [];

/** A port nothing listens on (taken then released): the chat calls of these tests never reach a real server of this machine. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
afterEach(() => {
  for (const close of servers.splice(0)) close();
});

function fakeSupervisor() {
  const spawned: string[][] = [];
  /** Processes alive at once, and the most there ever were: two servers on one port is the failure a swap must never cause. */
  const live = { now: 0, max: 0 };
  const supervisor = new LlamaServerSupervisor({
    spawn: (_bin, args) => {
      spawned.push(args);
      live.now += 1;
      live.max = Math.max(live.max, live.now);
      let dead = false;
      return { pid: 1, kill: () => (dead ? false : ((dead = true), (live.now -= 1), true)), on: () => {} } as SpawnedProcess;
    },
    probe: async () => live.now > 0,
  });
  return { supervisor, spawned, live };
}

async function setup(lm: FakeModel[] = [], loadDelayMs = 0) {
  const core = await makeCore();
  const lmstudio = fakeLmStudio(lm, loadDelayMs);
  const base = await lmstudio.ready;
  core.settings.set("providerOverrides", { ...core.settings.get("providerOverrides"), lmstudio: { baseUrl: base } });
  const { supervisor, spawned, live } = fakeSupervisor();
  const engine = new EngineService({ dir: tempDir(), settings: core.settings, supervisor, hardware: async () => ({ gpus: [], appleSilicon: false }), os: "win32", arch: "x64" });
  const models = tempDir();
  mkdirSync(models, { recursive: true });
  const a = join(models, "a.gguf");
  const b = join(models, "b.gguf");
  writeFileSync(a, "GGUF");
  writeFileSync(b, "GGUF");
  core.settings.set("localEngine", { ...core.settings.get("localEngine"), port: await freePort(), installed: { tag: "b1", backend: "cpu", dir: models, bin: process.execPath, at: 0 } });
  engine.savePresets([newPreset({ id: "pa", name: "rapide", model: a }), newPreset({ id: "pb", name: "lourd", model: b })], "pa");
  const service = new LocalModelsService({ settings: core.settings, engine, providers: core.providers });
  return { core, engine, service, spawned, lmstudio, live };
}

const loadedOf = (v: Awaited<ReturnType<LocalModelsService["list"]>>) => ({
  llamacpp: v.backends.llamacpp.models.filter((m) => m.loaded).map((m) => m.id),
  lmstudio: v.backends.lmstudio.models.filter((m) => m.loaded).map((m) => m.id),
});

describe("modèles locaux : liste, chargement, déchargement", () => {
  it("liste les préréglages llama.cpp et les modèles de LM Studio, avec leur état chargé", async () => {
    const { service } = await setup([{ key: "qwen", instances: ["qwen"] }, { key: "nomic", type: "embedding", instances: ["nomic"] }, { key: "jean" }]);
    const v = await service.list();
    expect(v.hotswap).toBe(false);
    expect(v.backends.llamacpp).toMatchObject({ available: true, models: [{ id: "pa", model: "rapide", loaded: false, loadable: true }, { id: "pb", loaded: false }] });
    expect(v.backends.lmstudio.available).toBe(true);
    expect(v.backends.lmstudio.models.map((m) => [m.id, m.kind, m.loaded])).toEqual([
      ["qwen", "chat", true],
      ["nomic", "embedding", true],
      ["jean", "chat", false],
    ]);
  });

  it("LM Studio fermé : indisponible avec la raison, la liste llama.cpp reste là", async () => {
    const { service, core } = await setup();
    core.settings.set("providerOverrides", { ...core.settings.get("providerOverrides"), lmstudio: { baseUrl: "http://127.0.0.1:9/v1" } });
    const v = await service.list();
    expect(v.backends.lmstudio).toMatchObject({ available: false, models: [] });
    expect(v.backends.lmstudio.reason).toBeTruthy();
    expect(v.backends.llamacpp.models).toHaveLength(2);
  });

  it("sans hotswap : charger dans LM Studio AJOUTE un modèle, rien n'est déchargé ailleurs", async () => {
    const { service, engine, lmstudio } = await setup([{ key: "qwen", instances: ["qwen"] }, { key: "jean" }]);
    await engine.start("pa");
    const v = await service.load("lmstudio", "jean");
    expect(loadedOf(v)).toEqual({ llamacpp: ["pa"], lmstudio: ["qwen", "jean"] });
    expect(lmstudio.calls.filter((c) => !c.startsWith("list"))).toEqual(["load jean"]);
  });

  it("décharger : le serveur llama.cpp s'arrête ; dans LM Studio, chaque instance du modèle part", async () => {
    const { service, lmstudio } = await setup([{ key: "qwen", instances: ["qwen", "qwen:2"] }]);
    await service.load("llamacpp", "pa");
    let v = await service.unload("llamacpp", "pa");
    expect(loadedOf(v).llamacpp).toEqual([]);
    v = await service.unload("lmstudio", "qwen");
    expect(loadedOf(v).lmstudio).toEqual([]);
    expect(lmstudio.calls.filter((c) => c.startsWith("unload"))).toEqual(["unload qwen", "unload qwen:2"]);
  });

  it("refuse un modèle inconnu au lieu d'inventer", async () => {
    const { service } = await setup([{ key: "qwen" }]);
    await expect(service.load("lmstudio", "absent")).rejects.toThrow(/ne connaît pas/);
    await expect(service.load("llamacpp", "zzz")).rejects.toThrow(/inconnu/);
  });

  it("la clé de LM Studio, quand il y en a une, part en Bearer vers LM Studio", async () => {
    const { service, core, lmstudio } = await setup([{ key: "qwen" }]);
    core.settings.setSecret(secretKeyFor("lmstudio"), "lm-secret");
    await service.list();
    expect(lmstudio.auth.at(-1)).toBe("Bearer lm-secret");
  });
});

describe("hotswap", () => {
  it("allumé : un seul modèle de chat local — charger l'un décharge les autres, jamais les embeddings", async () => {
    const { service, engine, lmstudio } = await setup([{ key: "qwen", instances: ["qwen"] }, { key: "nomic", type: "embedding", instances: ["nomic"] }, { key: "jean" }]);
    await service.setHotswap(true);
    await engine.start("pa");
    let v = await service.load("lmstudio", "jean");
    expect(loadedOf(v)).toEqual({ llamacpp: [], lmstudio: ["nomic", "jean"] });
    expect(lmstudio.calls).not.toContain("unload nomic");
    v = await service.load("llamacpp", "pb");
    expect(loadedOf(v)).toEqual({ llamacpp: ["pb"], lmstudio: ["nomic"] });
  });

  it("allumé : le sélecteur du chat liste tous les préréglages et tous les modèles de chat de LM Studio ; éteint, seulement le chargé", async () => {
    const { service, core, engine } = await setup([{ key: "qwen" }, { key: "nomic", type: "embedding" }]);
    await service.setHotswap(true);
    await service.list();
    expect(core.providers.def("llamacpp").models).toEqual(["rapide", "lourd"]);
    expect(core.providers.def("lmstudio").models).toEqual(["qwen"]);
    await engine.start("pb");
    expect(core.providers.def("llamacpp").models).toEqual(["rapide", "lourd"]);
    await service.setHotswap(false);
    expect(core.providers.def("llamacpp").models).toEqual(["lourd"]);
  });

  it("un appel du chat qui nomme un modèle local non chargé le charge AVANT de partir (llama.cpp)", async () => {
    const { service, core, spawned } = await setup();
    await service.setHotswap(true);
    // Le serveur répond sur le port de son préréglage : la requête de chat part vers lui une fois chargé (elle échoue ici : rien n'écoute vraiment).
    const client = core.providers.client("llamacpp");
    await client.chat({ model: "lourd", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(expect.arrayContaining(["--alias", "lourd"]));
    // Déjà chargé : aucun redémarrage.
    await client.chat({ model: "lourd", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    expect(spawned).toHaveLength(1);
    // Un nom qui n'est pas un préréglage : laissé tel quel.
    await client.chat({ model: "autre", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    expect(spawned).toHaveLength(1);
    void service;
  });

  it("un appel du chat vers LM Studio charge le modèle nommé et décharge l'autre modèle de chat", async () => {
    const { service, core, lmstudio } = await setup([{ key: "qwen", instances: ["qwen"] }, { key: "jean" }]);
    await service.setHotswap(true);
    await core.providers.client("lmstudio").chat({ model: "jean", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    expect(lmstudio.calls.filter((c) => !c.startsWith("list"))).toEqual(["unload qwen", "load jean"]);
  });

  it("éteint : un appel du chat ne charge ni ne décharge rien", async () => {
    const { core, lmstudio, spawned } = await setup([{ key: "qwen", instances: ["qwen"] }, { key: "jean" }]);
    await core.providers.client("lmstudio").chat({ model: "jean", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    await core.providers.client("llamacpp").chat({ model: "lourd", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    expect(lmstudio.calls.filter((c) => !c.startsWith("list"))).toEqual([]);
    expect(spawned).toHaveLength(0);
  });

  it("deux échanges simultanés s'exécutent l'un après l'autre : un seul serveur, le dernier demandé", async () => {
    const { service, engine, spawned } = await setup();
    await service.setHotswap(true);
    await Promise.all([service.load("llamacpp", "pa"), service.load("llamacpp", "pb"), service.prepare("llamacpp", "rapide")]);
    expect(spawned.map((a) => a[a.indexOf("--alias") + 1])).toEqual(["rapide", "lourd", "rapide"]);
    expect(engine.loadedPreset()?.id).toBe("pa");
  });

  it("deux chargements simultanés sur les deux serveurs : à la fin, un seul modèle de chat local en mémoire", async () => {
    const { service, live } = await setup([{ key: "jean" }]);
    await service.setHotswap(true);
    const [, last] = await Promise.all([service.load("llamacpp", "pa"), service.load("lmstudio", "jean")]);
    expect(loadedOf(last)).toEqual({ llamacpp: [], lmstudio: ["jean"] });
    expect(live.now).toBe(0);
  });

  it("dans l'autre ordre, avec un LM Studio lent à charger : le chargement llama.cpp attend la fin du premier, puis le décharge", async () => {
    const { service, live, lmstudio } = await setup([{ key: "jean" }], 100);
    await service.setHotswap(true);
    const [, last] = await Promise.all([service.load("lmstudio", "jean"), service.load("llamacpp", "pa")]);
    expect(loadedOf(last)).toEqual({ llamacpp: ["pa"], lmstudio: [] });
    expect(live.now).toBe(1);
    expect(lmstudio.calls.filter((c) => !c.startsWith("list"))).toEqual(["load jean", "unload jean"]);
  });
});

describe("moteur llama.cpp : un chargement à la fois", () => {
  it("deux démarrages simultanés s'enchaînent : le second remplace le premier, il n'en reste qu'un", async () => {
    const { engine, spawned, live } = await setup();
    await Promise.all([engine.start("pa"), engine.start("pb")]);
    expect(spawned.map((a) => a[a.indexOf("--alias") + 1])).toEqual(["rapide", "lourd"]);
    expect(engine.loadedPreset()?.id).toBe("pb");
    await Promise.all([engine.stop(), engine.start("pa")]);
    expect(engine.loadedPreset()?.id).toBe("pa");
    expect(live).toEqual({ now: 1, max: 1 });
  });
});

describe("activité : ce que la fenêtre montre pendant et après un chargement", () => {
  const brief = (a: LocalModelActivity) => `${a.phase} ${a.action} ${a.backend} ${a.model}`;

  it("un chargement hotswap annonce les déchargements qu'il fait, puis le chargement : début et fin, même identifiant, durée", async () => {
    const { service, engine } = await setup([{ key: "qwen", instances: ["qwen"] }, { key: "nomic", type: "embedding", instances: ["nomic"] }, { key: "jean" }]);
    await service.setHotswap(true);
    await engine.start("pa");
    const seen: LocalModelActivity[] = [];
    const off = service.onActivity((a) => seen.push(a));
    await service.load("lmstudio", "jean");
    expect(seen.map(brief)).toEqual([
      "start unload llamacpp rapide",
      "done unload llamacpp rapide",
      "start unload lmstudio qwen",
      "done unload lmstudio qwen",
      "start load lmstudio jean",
      "done load lmstudio jean",
    ]);
    const [start, done] = seen.slice(-2);
    expect(done!.id).toBe(start!.id);
    expect(new Set(seen.map((a) => a.id)).size).toBe(3);
    expect(typeof done!.durationMs).toBe("number");
    off();
    await service.unload("lmstudio", "jean");
    expect(seen).toHaveLength(6);
  });

  it("le chargement demandé par le chat (préparation du fournisseur) est annoncé aussi ; un échec porte son message", async () => {
    const { service, core } = await setup([{ key: "jean" }]);
    await service.setHotswap(true);
    const seen: LocalModelActivity[] = [];
    service.onActivity((a) => seen.push(a));
    await core.providers.client("llamacpp").chat({ model: "lourd", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    expect(seen.slice(0, 2).map(brief)).toEqual(["start load llamacpp lourd", "done load llamacpp lourd"]);
    core.settings.set("localEngine", { ...core.settings.get("localEngine"), installed: { tag: "b1", backend: "cpu", dir: "x", bin: "C:/nulle-part/llama-server.exe", at: 0 } });
    seen.length = 0;
    await expect(service.load("llamacpp", "pa")).rejects.toThrow(/pas installé/);
    expect(seen.map(brief)).toEqual(["start load llamacpp rapide", "error load llamacpp rapide"]);
    expect(seen[1]!.error).toMatch(/pas installé/);
  });

  it("un écouteur qui lève n'empêche ni le chargement ni les autres écouteurs", async () => {
    const { service } = await setup([{ key: "jean" }]);
    const seen: string[] = [];
    service.onActivity(() => {
      throw new Error("écran parti");
    });
    service.onActivity((a) => seen.push(a.phase));
    const v = await service.load("lmstudio", "jean");
    expect(loadedOf(v).lmstudio).toEqual(["jean"]);
    expect(seen).toEqual(["start", "done"]);
  });
});

describe("longueur de contexte (LM Studio) : demandée au chargement, rechargée si le modèle est en mémoire à une autre taille", () => {
  const lmRow = (v: Awaited<ReturnType<LocalModelsService["list"]>>, id: string) => v.backends.lmstudio.models.find((m) => m.id === id)!;
  const gestures = (calls: string[]) => calls.filter((c) => !c.startsWith("list"));

  it("sans réglage, le chargement demande la longueur par défaut (16384, assez pour la liste d'outils) plutôt que les 8192 de LM Studio ; réglée, la sienne part au chargement et la liste la montre", async () => {
    const { service, lmstudio } = await setup([{ key: "jean", max: 262144 }, { key: "qwen", max: 32768 }]);
    await service.load("lmstudio", "qwen");
    expect(lmstudio.loads.at(-1)).toEqual({ model: "qwen", context_length: DEFAULT_LM_CONTEXT });
    let v = await service.setContextLength("jean", 32768);
    expect(lmRow(v, "jean")).toMatchObject({ contextLength: 32768, loadedContext: null, maxContext: 262144, loaded: false });
    v = await service.load("lmstudio", "jean");
    expect(lmstudio.loads.at(-1)).toEqual({ model: "jean", context_length: 32768 });
    expect(lmRow(v, "jean")).toMatchObject({ loaded: true, contextLength: 32768, loadedContext: 32768 });
    expect(lmRow(v, "qwen")).toMatchObject({ contextLength: null, loadedContext: DEFAULT_LM_CONTEXT });
  });

  it("la longueur par défaut tient la liste d'outils (~5700 jetons) et ne dépasse jamais ce que le modèle accepte", async () => {
    expect(DEFAULT_LM_CONTEXT).toBeGreaterThanOrEqual(5700 * 2);
    expect(defaultLmContext({ maxContext: 262144 })).toBe(DEFAULT_LM_CONTEXT);
    expect(defaultLmContext({ maxContext: null })).toBe(DEFAULT_LM_CONTEXT);
    expect(defaultLmContext({ maxContext: 4096 })).toBe(4096);
    const { service, lmstudio } = await setup([{ key: "petit", max: 4096 }, { key: "inconnu" }]);
    await service.load("lmstudio", "petit");
    expect(lmstudio.loads.at(-1)).toEqual({ model: "petit", context_length: 4096 });
    await service.load("lmstudio", "inconnu");
    expect(lmstudio.loads.at(-1)).toEqual({ model: "inconnu", context_length: DEFAULT_LM_CONTEXT });
  });

  it("refuse moins de 512, plus que le maximum du modèle, un nombre non entier, un modèle inconnu ; null revient au choix de LM Studio", async () => {
    const { service, core, lmstudio } = await setup([{ key: "jean", max: 32768 }]);
    await expect(service.setContextLength("jean", 511)).rejects.toThrow(/au moins 512/);
    await expect(service.setContextLength("jean", 32769)).rejects.toThrow(/au plus 32768/);
    await expect(service.setContextLength("jean", 8192.5)).rejects.toThrow(/entier/);
    await expect(service.setContextLength("absent", 8192)).rejects.toThrow(/ne connaît pas/);
    await service.setContextLength("jean", 32768);
    await service.setContextLength("jean", 512);
    expect(core.settings.get("localModels").lmstudioContext).toEqual({ jean: 512 });
    const v = await service.setContextLength("jean", null);
    expect(lmRow(v, "jean").contextLength).toBeNull();
    expect(core.settings.get("localModels").lmstudioContext).toEqual({});
    await service.load("lmstudio", "jean");
    expect(lmstudio.loads.at(-1)).toEqual({ model: "jean", context_length: DEFAULT_LM_CONTEXT });
  });

  it("en mémoire à une autre taille : « Load » le décharge puis le recharge à la taille demandée ; à la bonne taille, rien ne bouge", async () => {
    const { service, lmstudio } = await setup([{ key: "jean", instances: ["jean"], ctx: 8192 }]);
    await service.setContextLength("jean", 16384);
    let v = await service.load("lmstudio", "jean");
    expect(gestures(lmstudio.calls)).toEqual(["unload jean", "load jean"]);
    expect(lmstudio.loads.at(-1)).toEqual({ model: "jean", context_length: 16384 });
    expect(lmRow(v, "jean")).toMatchObject({ loaded: true, loadedContext: 16384 });
    v = await service.load("lmstudio", "jean");
    expect(gestures(lmstudio.calls)).toEqual(["unload jean", "load jean"]);
    // Sans réglage, un modèle en mémoire n'est jamais rechargé, quelle que soit sa taille.
    await service.setContextLength("jean", null);
    await service.load("lmstudio", "jean");
    expect(gestures(lmstudio.calls)).toEqual(["unload jean", "load jean"]);
  });

  it("hotswap : le chat qui nomme un modèle déjà en mémoire mais trop petit le recharge à la taille demandée avant de partir", async () => {
    const { service, core, lmstudio } = await setup([{ key: "jean", instances: ["jean"], ctx: 8192 }]);
    await service.setHotswap(true);
    await service.setContextLength("jean", 16384);
    const chat = () => core.providers.client("lmstudio").chat({ model: "jean", system: "", messages: [], tools: [], maxAttempts: 1 }, {}).catch(() => undefined);
    await chat();
    expect(gestures(lmstudio.calls)).toEqual(["unload jean", "load jean"]);
    expect(lmstudio.loads.at(-1)).toEqual({ model: "jean", context_length: 16384 });
    await chat();
    expect(gestures(lmstudio.calls)).toEqual(["unload jean", "load jean"]);
  });

  it("llama.cpp : la liste montre la taille du préréglage (son « Context size »)", async () => {
    const { service, engine } = await setup();
    const v = await service.list();
    expect(v.backends.llamacpp.models.map((m) => m.contextLength)).toEqual(engine.config().presets.map((p) => p.ctxSize));
    expect(v.backends.llamacpp.models.every((m) => (m.contextLength ?? 0) > 0 && m.loadedContext === null)).toBe(true);
  });
});
