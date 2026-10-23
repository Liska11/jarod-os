/**
 * Modèles locaux (llama.cpp, LM Studio) : canaux `local-models-*` et hotswap au choix du modèle dans le chat. VRAI kernel, VRAI `LocalModelsService` ;
 * LM Studio est un faux serveur HTTP local (jamais celui de la machine) ; aucun llama-server n'est lancé (le superviseur est remplacé).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModelsView } from "@jarod/plugin-llm";
import { bindLocalModelsEvents } from "../src/main/handlers/local-models.js";
import { setupKernel } from "./ui-parite-helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await cleanup();
});
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

/** Faux LM Studio (API REST v1) : `jean` et `qwen` (chargé), un modèle d'embeddings chargé. */
async function fakeLmStudio() {
  const models = [
    { key: "qwen", type: "llm", instances: ["qwen"] },
    { key: "jean", type: "llm", instances: [] as string[] },
    { key: "nomic", type: "embedding", instances: ["nomic"] },
  ];
  const calls: string[] = [];
  const contexts: Record<string, number | undefined> = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? (JSON.parse(body) as Record<string, string>) : {};
      const ctx = body ? (JSON.parse(body) as { context_length?: number }).context_length : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/v1/models") return res.end(JSON.stringify({ models: models.map((m) => ({ type: m.type, key: m.key, display_name: m.key, max_context_length: 65536, loaded_instances: m.instances.map((id) => ({ id, config: { context_length: contexts[id] ?? 8192 } })) })) }));
      if (req.url === "/api/v1/models/load") {
        calls.push(`load ${json.model}${ctx ? ` ctx=${ctx}` : ""}`);
        contexts[json.model!] = ctx;
        models.find((m) => m.key === json.model)!.instances.push(json.model!);
        return res.end(JSON.stringify({ instance_id: json.model, status: "loaded" }));
      }
      if (req.url === "/api/v1/models/unload") {
        calls.push(`unload ${json.instance_id}`);
        for (const m of models) m.instances = m.instances.filter((i) => i !== json.instance_id);
        return res.end(JSON.stringify({ instance_id: json.instance_id }));
      }
      res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

/** The real contract (owner, contextLength, … included), not a hand-copied subset: a fixture that drifts from it fails the typecheck. */
type View = LocalModelsView;

async function wired() {
  const k = await setupKernel();
  const lm = await fakeLmStudio();
  k.app.agent.settings.set("providerOverrides", { ...k.app.agent.settings.get("providerOverrides"), lmstudio: { baseUrl: lm.base } });
  return { ...k, lm };
}

describe("modèles locaux : canaux", () => {
  it("liste, charge et décharge un modèle de LM Studio ; l'état rendu est celui du serveur", async () => {
    const { call, lm } = await wired();
    let v = (await call("local-models-list")) as View;
    expect(v.hotswap).toBe(false);
    expect(v.backends.lmstudio.models.map((m) => [m.id, m.loaded, m.kind])).toEqual([
      ["qwen", true, "chat"],
      ["jean", false, "chat"],
      ["nomic", true, "embedding"],
    ]);
    v = (await call("local-models-load", "lmstudio", "jean")) as View;
    expect(v.backends.lmstudio.models.find((m) => m.id === "jean")!.loaded).toBe(true);
    // Sans hotswap : rien d'autre n'est déchargé.
    expect(lm.calls).toEqual(["load jean ctx=16384"]);
    v = (await call("local-models-unload", "lmstudio", "jean")) as View;
    expect(v.backends.lmstudio.models.find((m) => m.id === "jean")!.loaded).toBe(false);
  });

  it("refuse un moteur hors liste, un identifiant absent ou de contrôle, un champ de réglage inconnu", async () => {
    const { call } = await wired();
    await rejects(() => call("local-models-load", "ollama", "x"), /moteur attendu/);
    await rejects(() => call("local-models-load", "lmstudio", ""), /identifiant/);
    await rejects(() => call("local-models-load", "lmstudio", "a\nb"), /identifiant/);
    await rejects(() => call("local-models-unload", "lmstudio", 3), /identifiant/);
    await rejects(() => call("local-models-configure", { hotswap: "oui" }), /booléen/);
    await rejects(() => call("local-models-configure", { hotswap: true, baseUrl: "http://ailleurs" }), /non accepté/);
    await rejects(() => call("local-models-load", "lmstudio", "inconnu"), /ne connaît pas/);
  });

  it("propriété : chaque modèle chargé dit qui l'a chargé ; « reprendre » refuse un modèle externe", async () => {
    const { call } = await wired();
    let v = (await call("local-models-list")) as View;
    expect(v.backends.lmstudio.models.map((m) => [m.id, m.owner])).toEqual([
      ["qwen", "externe"],
      ["jean", null],
      ["nomic", "externe"],
    ]);
    v = (await call("local-models-load", "lmstudio", "jean")) as typeof v;
    expect(v.backends.lmstudio.models.find((m) => m.id === "jean")!.owner).toBe("jarod");
    await rejects(() => call("local-models-adopt", "qwen"), /rien à reprendre/);
    await rejects(() => call("local-models-adopt", ""), /identifiant/);
  });

  it("déchargement après inactivité (2026-10-21) : un entier de 0 à 1440 minutes, un réglage à la fois, rendu dans la vue", async () => {
    const { call, app } = await wired();
    await rejects(() => call("local-models-configure", { idleUnloadMinutes: -1 }), /0 \(jamais\) à 1440/);
    await rejects(() => call("local-models-configure", { idleUnloadMinutes: "10" }), /entier/);
    await rejects(() => call("local-models-configure", { idleUnloadMinutes: 10, hotswap: true }), /un seul réglage/);
    const v = (await call("local-models-configure", { idleUnloadMinutes: 15 })) as View & { idleUnloadMinutes: number };
    expect(v.idleUnloadMinutes).toBe(15);
    expect(app.agent.settings.get("localModels").idleUnloadMinutes).toBe(15);
  });

  it("hotswap : choisir un modèle LM Studio dans le chat (set-model-config) le charge tout de suite et décharge l'autre modèle de chat chargé par Jarod, jamais les embeddings", async () => {
    const { call, lm, app } = await wired();
    // qwen est en mémoire SANS que Jarod l'ait chargé (externe) : l'utilisateur le décharge puis le charge depuis Jarod, il devient le sien.
    await call("local-models-unload", "lmstudio", "qwen");
    await call("local-models-load", "lmstudio", "qwen");
    lm.calls.length = 0;
    const v = (await call("local-models-configure", { hotswap: true })) as View;
    expect(v.hotswap).toBe(true);
    expect(app.agent.settings.get("localModels").hotswap).toBe(true);
    // Le sélecteur du chat liste les modèles de chat de LM Studio (pas les embeddings).
    expect(app.agent.settings.get("providerOverrides").lmstudio?.models).toEqual(["qwen", "jean"]);
    await call("set-model-config", "lmstudio", "jean", "");
    await expect.poll(() => lm.calls).toEqual(["unload qwen", "load jean ctx=16384"]);
    expect(app.agent.settings.get("activeModel")).toBe("jean");
  });

  it("chaque chargement / déchargement part vers la fenêtre (événement local-models-activity), y compris ceux du hotswap ; débranché ensuite", async () => {
    const { call, kernel } = await wired();
    const sent: [string, { phase: string; action: string; model: string }][] = [];
    await call("local-models-unload", "lmstudio", "qwen");
    await call("local-models-load", "lmstudio", "qwen"); // chargé par Jarod : le hotswap pourra le décharger
    const off = bindLocalModelsEvents(kernel.localEngine?.models, (channel, a) => sent.push([channel, a as never]));
    await call("local-models-configure", { hotswap: true });
    await call("local-models-load", "lmstudio", "jean");
    expect(sent.map(([c, a]) => `${c} ${a.phase} ${a.action} ${a.model}`)).toEqual([
      "local-models-activity start unload qwen",
      "local-models-activity done unload qwen",
      "local-models-activity start load jean",
      "local-models-activity done load jean",
    ]);
    off();
    await call("local-models-unload", "lmstudio", "jean");
    expect(sent).toHaveLength(4);
    expect(bindLocalModelsEvents(undefined, () => {})).toBeTypeOf("function");
  });

  it("longueur de contexte : réglée par le volet, envoyée à LM Studio au chargement ; un modèle en mémoire à 8192 est rechargé à la taille demandée", async () => {
    const { call, lm, app } = await wired();
    let v = (await call("local-models-configure", { contextLength: { model: "qwen", tokens: 16384 } })) as View & { backends: { lmstudio: { models: { contextLength: number | null; loadedContext: number | null }[] } } };
    expect(app.agent.settings.get("localModels").lmstudioContext).toEqual({ qwen: 16384 });
    expect(v.backends.lmstudio.models[0]).toMatchObject({ id: "qwen", contextLength: 16384, loadedContext: 8192 });
    v = (await call("local-models-load", "lmstudio", "qwen")) as typeof v;
    expect(lm.calls).toEqual(["unload qwen", "load qwen ctx=16384"]);
    expect(v.backends.lmstudio.models[0]).toMatchObject({ loadedContext: 16384 });
    await call("local-models-configure", { contextLength: { model: "qwen", tokens: null } });
    expect(app.agent.settings.get("localModels").lmstudioContext).toEqual({});
  });

  it("longueur de contexte : refuse un nombre non entier ou négatif, un champ en trop, deux réglages à la fois, plus que le maximum du modèle", async () => {
    const { call } = await wired();
    await rejects(() => call("local-models-configure", { contextLength: { model: "qwen", tokens: "16384" } }), /entier positif/);
    await rejects(() => call("local-models-configure", { contextLength: { model: "qwen", tokens: -1 } }), /entier positif/);
    await rejects(() => call("local-models-configure", { contextLength: { model: "qwen", tokens: 4096.5 } }), /entier positif/);
    await rejects(() => call("local-models-configure", { contextLength: { model: "qwen", tokens: 4096, gpu: 1 } }), /\{ model, tokens \}/);
    await rejects(() => call("local-models-configure", { contextLength: { model: "a\nb", tokens: 4096 } }), /identifiant/);
    await rejects(() => call("local-models-configure", { hotswap: true, contextLength: { model: "qwen", tokens: 4096 } }), /un seul réglage/);
    await rejects(() => call("local-models-configure", {}), /un seul réglage/);
    await rejects(() => call("local-models-configure", { contextLength: { model: "qwen", tokens: 65537 } }), /au plus 65536/);
    await rejects(() => call("local-models-configure", { contextLength: { model: "inconnu", tokens: 4096 } }), /ne connaît pas/);
  });

  it("hotswap éteint : choisir un modèle dans le chat ne charge rien", async () => {
    const { call, lm } = await wired();
    await call("set-model-config", "lmstudio", "jean", "");
    await new Promise((r) => setTimeout(r, 200));
    expect(lm.calls).toEqual([]);
  });
});
