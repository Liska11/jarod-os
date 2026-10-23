// 2026-10-21 (réexamen de llama-swap) — deux choses que le gestionnaire de modèles locaux ne faisait pas, éprouvées sur des serveurs FACTICES
// (127.0.0.1 ; ni le vrai LM Studio ni un vrai llama-server de cette machine ne sont appelés) :
//  - une réponse EN COURS n'est jamais coupée par une bascule : le déchargement (LM Studio) ou le redémarrage de llama-server attend sa fin ;
//    une attente trop longue refuse la BASCULE, jamais la réponse ;
//  - déchargement après inactivité : seulement ce que Jarod a chargé, jamais un modèle d'embeddings, jamais pendant une réponse ; éteint par défaut.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineService, newPreset } from "../src/engine.js";
import { LlamaServerSupervisor, type SpawnedProcess } from "../src/llama-server.js";
import { type LocalModelActivity, LocalModelsService } from "../src/local-models.js";
import { makeCore, tempDir } from "./helpers.js";

const servers: Server[] = [];
const services: LocalModelsService[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const s of services.splice(0)) s.dispose();
});

/** Le journal ordonné de ce qui arrive : début et fin de chaque réponse, chargements, déchargements, démarrages et arrêts de llama-server. */
type Log = string[];

/** Une réponse de discussion en flux SSE (comme llama-server et LM Studio), qui dure `ms` ; journalisée au début et à la fin. */
function slowChat(_req: IncomingMessage, res: ServerResponse, body: string, log: Log, delays: Record<string, number>): void {
  const model = String((JSON.parse(body) as { model?: string }).model);
  log.push(`chat-début ${model}`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "réponse " } }] })}\n\n`);
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `complète de ${model}` }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
    log.push(`chat-fin ${model}`);
  }, delays[model] ?? 30);
  // La connexion fermée AVANT la fin de la réponse = une réponse coupée (le serveur arrêté sous elle, ou le client parti).
  res.on("close", () => {
    if (!res.writableEnded) log.push(`chat-COUPÉE ${model}`);
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

type FakeModel = { key: string; type?: string; instances?: string[] };

/** LM Studio factice : son API REST v1 (liste, charger, décharger) et la discussion compatible OpenAI. */
async function fakeLmStudio(models: FakeModel[], log: Log, delays: Record<string, number>) {
  const state = models.map((m) => ({ key: m.key, type: m.type ?? "llm", instances: [...(m.instances ?? [])] }));
  const port = await listen((req, res, body) => {
    const reply = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const json = body ? (JSON.parse(body) as Record<string, string>) : {};
    if (req.method === "GET" && req.url === "/api/v1/models") {
      return reply(200, { models: state.map((m) => ({ type: m.type, key: m.key, display_name: m.key, size_bytes: 1, max_context_length: 32768, loaded_instances: m.instances.map((id) => ({ id, config: { context_length: 16384 } })) })) });
    }
    if (req.method === "POST" && req.url === "/api/v1/models/load") {
      const m = state.find((x) => x.key === json.model);
      if (!m) return reply(404, { error: "inconnu" });
      m.instances.push(m.key);
      log.push(`chargé ${m.key}`);
      return reply(200, { instance_id: m.key, status: "loaded" });
    }
    if (req.method === "POST" && req.url === "/api/v1/models/unload") {
      for (const m of state) m.instances = m.instances.filter((i) => i !== json.instance_id);
      log.push(`déchargé ${json.instance_id}`);
      return reply(200, { instance_id: json.instance_id });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") return slowChat(req, res, body, log, delays);
    reply(404, {});
  });
  return { base: `http://127.0.0.1:${port}/v1`, state };
}

async function setup(o: { lm?: FakeModel[]; delays?: Record<string, number>; drainMaxMs?: number; minuteMs?: number } = {}) {
  const log: Log = [];
  const delays = o.delays ?? {};
  const core = await makeCore();
  const lm = await fakeLmStudio(o.lm ?? [], log, delays);
  core.settings.set("providerOverrides", { ...core.settings.get("providerOverrides"), lmstudio: { baseUrl: lm.base } });
  // llama-server factice : le superviseur ne lance rien de réel ; la discussion arrive à un serveur factice sur le port du moteur.
  const chatPort = await listen((req, res, body) => (req.url === "/v1/chat/completions" ? slowChat(req, res, body, log, delays) : res.end()));
  let live = 0;
  const supervisor = new LlamaServerSupervisor({
    spawn: (_bin, args) => {
      live += 1;
      log.push(`llama-server démarré ${args[args.indexOf("--alias") + 1] ?? "?"}`);
      let dead = false;
      return { pid: 1, kill: () => (dead ? false : ((dead = true), (live -= 1), log.push("llama-server arrêté"), true)), on: () => {} } as SpawnedProcess;
    },
    probe: async () => live > 0,
  });
  const engine = new EngineService({ dir: tempDir(), settings: core.settings, supervisor, hardware: async () => ({ gpus: [], appleSilicon: false }), os: "win32", arch: "x64" });
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  for (const f of ["a.gguf", "b.gguf"]) writeFileSync(join(dir, f), "GGUF");
  core.settings.set("localEngine", { ...core.settings.get("localEngine"), port: chatPort, installed: { tag: "b1", backend: "cpu", dir, bin: process.execPath, at: 0 } });
  engine.savePresets([newPreset({ id: "pa", name: "rapide", model: join(dir, "a.gguf") }), newPreset({ id: "pb", name: "lourd", model: join(dir, "b.gguf") })], "pa");
  const service = new LocalModelsService({
    settings: core.settings,
    engine,
    providers: core.providers,
    ...(o.drainMaxMs !== undefined ? { drainMaxMs: o.drainMaxMs } : {}),
    ...(o.minuteMs !== undefined ? { minuteMs: o.minuteMs, idleCheckMs: 40 } : {}),
  });
  services.push(service);
  const activity: LocalModelActivity[] = [];
  service.onActivity((a) => activity.push(a));
  const chat = (backend: "lmstudio" | "llamacpp", model: string) =>
    core.providers.client(backend).chat({ model, system: "", messages: [{ role: "user", content: "x" }], tools: [], maxAttempts: 1 }, {});
  return { core, engine, service, log, lm, chat, activity };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const before = (log: Log, a: string, b: string) => {
  const i = log.indexOf(a);
  const j = log.indexOf(b);
  expect(i, `« ${a} » absent : ${log.join(" | ")}`).toBeGreaterThanOrEqual(0);
  expect(j, `« ${b} » absent : ${log.join(" | ")}`).toBeGreaterThanOrEqual(0);
  expect(i, log.join(" | ")).toBeLessThan(j);
};

describe("une bascule attend la réponse en cours (serveurs factices)", () => {
  it("LM Studio : le modèle n'est déchargé qu'après la fin de la réponse qu'il donne ; l'autre conversation attend puis est servie", async () => {
    const { service, log, chat } = await setup({ lm: [{ key: "m1" }, { key: "m2" }], delays: { m1: 700, m2: 30 } });
    await service.setHotswap(true);
    const a = chat("lmstudio", "m1");
    await wait(150);
    expect(service.inFlight()).toEqual({ "lmstudio:m1": 1 });
    const b = await chat("lmstudio", "m2");
    const ra = await a;
    expect(ra.text).toBe("réponse complète de m1");
    expect(b.text).toBe("réponse complète de m2");
    before(log, "chat-fin m1", "déchargé m1");
    before(log, "déchargé m1", "chat-début m2");
    expect(log.some((l) => l.startsWith("chat-COUPÉE"))).toBe(false);
    expect(service.inFlight()).toEqual({});
  });

  it("llama.cpp : llama-server n'est redémarré sur l'autre préréglage qu'après la fin de la réponse", async () => {
    const { engine, service, log, chat } = await setup({ delays: { rapide: 700, lourd: 30 } });
    await service.setHotswap(true);
    engine.publishModels();
    const a = chat("llamacpp", "rapide");
    await wait(200);
    const b = await chat("llamacpp", "lourd");
    expect((await a).text).toBe("réponse complète de rapide");
    expect(b.text).toBe("réponse complète de lourd");
    before(log, "chat-fin rapide", "llama-server arrêté");
    before(log, "llama-server arrêté", "llama-server démarré lourd");
    expect(log.some((l) => l.startsWith("chat-COUPÉE"))).toBe(false);
  });

  it("attente trop longue : la BASCULE est refusée avec la raison ; la réponse en cours va à son terme, rien n'est déchargé", async () => {
    const { service, log, chat } = await setup({ lm: [{ key: "m1" }, { key: "m2" }], delays: { m1: 900 }, drainMaxMs: 200 });
    await service.setHotswap(true);
    const a = chat("lmstudio", "m1");
    await wait(150);
    await expect(chat("lmstudio", "m2")).rejects.toThrow(/encore en cours sur « m1 ».*pour ne pas la couper/);
    expect((await a).text).toBe("réponse complète de m1");
    expect(log.filter((l) => l.startsWith("déchargé"))).toEqual([]);
    expect(log).not.toContain("chargé m2");
  });

  it("le déchargement demandé à l'écran attend lui aussi la fin de la réponse", async () => {
    const { service, log, chat } = await setup({ lm: [{ key: "m1" }], delays: { m1: 500 } });
    await service.load("lmstudio", "m1");
    const a = chat("lmstudio", "m1");
    await wait(100);
    await service.unload("lmstudio", "m1");
    await a;
    before(log, "chat-fin m1", "déchargé m1");
  });
});

describe("déchargement après inactivité (serveurs factices ; une « minute » = 100 ms)", () => {
  it("éteint par défaut : rien n'est déchargé", async () => {
    const { service, log } = await setup({ lm: [{ key: "m1" }], minuteMs: 100 });
    await service.load("lmstudio", "m1");
    await wait(400);
    expect(service.idleUnloadMinutes()).toBe(0);
    expect(log).not.toContain("déchargé m1");
  });

  it("ce que Jarod a chargé est déchargé après le délai ; un modèle chargé par l'utilisateur et un modèle d'embeddings ne sont jamais touchés", async () => {
    const { engine, service, log, chat, activity } = await setup({
      lm: [{ key: "m1" }, { key: "perso", instances: ["perso"] }, { key: "emb", type: "embedding", instances: ["emb"] }],
      minuteMs: 100,
    });
    await service.setHotswap(false);
    await service.load("lmstudio", "m1");
    await service.load("llamacpp", "pa");
    engine.publishModels();
    await chat("llamacpp", "rapide");
    await service.setIdleUnload(1);
    await wait(500);
    expect(log).toContain("déchargé m1");
    expect(log).toContain("llama-server arrêté");
    expect(log).not.toContain("déchargé perso");
    expect(log).not.toContain("déchargé emb");
    expect(activity.filter((a) => a.action === "unload" && a.phase === "done").every((a) => a.reason === "inactivité")).toBe(true);
    expect((await service.list()).idleUnloadMinutes).toBe(1);
  });

  it("jamais pendant une réponse : un modèle qui répond plus longtemps que le délai reste chargé, puis part après", async () => {
    const { service, log, chat } = await setup({ lm: [{ key: "m1" }], delays: { m1: 600 }, minuteMs: 100 });
    await service.load("lmstudio", "m1");
    await service.setIdleUnload(1);
    const a = chat("lmstudio", "m1");
    await wait(450);
    expect(log).not.toContain("déchargé m1");
    await a;
    await wait(400);
    before(log, "chat-fin m1", "déchargé m1");
  });

  it("réglage borné : entier de 0 à 1440 minutes", async () => {
    const { service } = await setup();
    await expect(service.setIdleUnload(-1)).rejects.toThrow(/0 \(jamais\) à 1440/);
    await expect(service.setIdleUnload(1.5)).rejects.toThrow(/entier/);
    await expect(service.setIdleUnload(1441)).rejects.toThrow(/1440/);
    expect((await service.setIdleUnload(0)).idleUnloadMinutes).toBe(0);
  });
});
