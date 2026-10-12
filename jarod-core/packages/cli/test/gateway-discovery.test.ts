// Passerelle compatible Hermes (essai) : le sélecteur de modèles de Herald ne montre que les fournisseurs qui ont des modèles. Les serveurs locaux
// (LM Studio, Ollama…) n'en ont pas dans le catalogue : la passerelle les lit à la demande (`GET <base>/models`). Logique pure avec des faux, puis le VRAI
// noyau devant un FAUX serveur LM Studio.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { type ProviderLike, modelOptions } from "../src/gateway/config.js";
import { isEmbeddingModel, ModelDiscovery } from "../src/gateway/discovery.js";
import { createGateway } from "../src/gateway/server.js";

const catalogue = (): ProviderLike[] => [
  { id: "anthropic", name: "Anthropic", models: ["claude-a"], baseUrl: "https://api.anthropic.com", configured: true },
  { id: "lmstudio", name: "LM Studio (local)", models: [], baseUrl: "http://localhost:1234/v1", local: true, configured: true },
  { id: "ollama", name: "Ollama (local)", models: ["declare"], baseUrl: "http://localhost:11434/v1", local: true, configured: true },
  { id: "local-whisper-cpp", name: "Whisper local", models: ["large-v3-turbo"], baseUrl: "http://127.0.0.1:8910/v1", local: true, configured: true },
];

function rigUnit(models: Record<string, string[] | Error | "hang">) {
  const calls: string[] = [];
  let clock = 1_000;
  const providers = catalogue();
  const discovery = new ModelDiscovery({
    list: () => providers,
    fetchModels: async (id) => {
      calls.push(id);
      const r = models[id];
      if (r === "hang") return new Promise<string[]>(() => {});
      if (r instanceof Error) throw r;
      if (!r) throw new Error("injoignable");
      return r;
    },
    ttlMs: 5_000,
    failureTtlMs: 1_000,
    timeoutMs: 30,
    now: () => clock,
  });
  return { calls, discovery, providers, models, advance: (ms: number) => void (clock += ms) };
}

describe("découverte des modèles locaux", () => {
  it("ajoute les modèles lus aux fournisseurs LOCAUX seulement ; un fournisseur distant et le Whisper local ne sont jamais interrogés", async () => {
    const r = rigUnit({ lmstudio: ["qwen3-8b", "gemma-3-4b"], ollama: ["llama3"], anthropic: ["ne-doit-pas-venir"], "local-whisper-cpp": ["ne-doit-pas-venir"] });
    const out = await r.discovery.providers();
    expect(out.find((p) => p.id === "lmstudio")!.models).toEqual(["qwen3-8b", "gemma-3-4b"]);
    expect(out.find((p) => p.id === "ollama")!.models).toEqual(["llama3", "declare"]); // lu d'abord, puis ce que l'utilisateur déclare
    expect(out.find((p) => p.id === "anthropic")!.models).toEqual(["claude-a"]);
    expect(out.find((p) => p.id === "local-whisper-cpp")!.models).toEqual(["large-v3-turbo"]);
    expect([...r.calls].sort()).toEqual(["lmstudio", "ollama"]);
  });

  it("serveur éteint, refusé ou trop lent : le fournisseur garde sa liste du catalogue, sans erreur", async () => {
    const r = rigUnit({ lmstudio: new Error("ECONNREFUSED"), ollama: "hang" });
    const out = await r.discovery.providers();
    expect(out.find((p) => p.id === "lmstudio")!.models).toEqual([]);
    expect(out.find((p) => p.id === "ollama")!.models).toEqual(["declare"]);
  });

  it("les modèles d'embedding ne sont pas proposés pour converser", async () => {
    const r = rigUnit({ lmstudio: ["qwen3-8b", "text-embedding-nomic-embed-text-v1.5"], ollama: [] });
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["qwen3-8b"]);
    expect(isEmbeddingModel("nomic-embed-text")).toBe(true);
    expect(isEmbeddingModel("llama3")).toBe(false);
  });

  it("cache court : pas de relecture dans le délai ; un modèle chargé après coup apparaît ensuite SANS redémarrage", async () => {
    const r = rigUnit({ lmstudio: ["a"], ollama: [] });
    await r.discovery.providers();
    r.models.lmstudio = ["a", "b"];
    r.advance(4_999);
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["a"]);
    expect(r.calls.filter((c) => c === "lmstudio")).toHaveLength(1);
    r.advance(2);
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["a", "b"]);
    expect(r.calls.filter((c) => c === "lmstudio")).toHaveLength(2);
  });

  it("un échec est retenu moins longtemps qu'un succès : un serveur lancé après l'ouverture est vu vite", async () => {
    const r = rigUnit({ lmstudio: new Error("éteint"), ollama: [] });
    await r.discovery.providers();
    r.models.lmstudio = ["demarre"];
    r.advance(999);
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual([]);
    r.advance(2);
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["demarre"]);
  });

  it("invalidate() force la relecture (changement de fournisseur) ; changer l'adresse d'un fournisseur la force aussi", async () => {
    const r = rigUnit({ lmstudio: ["a"], ollama: [] });
    await r.discovery.providers();
    r.models.lmstudio = ["b"];
    r.discovery.invalidate();
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["b"]);
    r.models.lmstudio = ["c"];
    r.discovery.invalidate("ollama"); // un autre fournisseur : la lecture de LM Studio reste valable
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["b"]);
    r.providers.find((p) => p.id === "lmstudio")!.baseUrl = "http://127.0.0.1:5678/v1";
    expect((await r.discovery.providers()).find((p) => p.id === "lmstudio")!.models).toEqual(["c"]);
  });

  it("deux ouvertures simultanées du sélecteur ne font qu'UNE lecture par serveur", async () => {
    const r = rigUnit({ lmstudio: ["a"], ollama: [] });
    await Promise.all([r.discovery.providers(), r.discovery.providers()]);
    expect(r.calls.filter((c) => c === "lmstudio")).toHaveLength(1);
  });

  it("sans moyen de lire (faux noyau) : les fournisseurs sont rendus tels quels", async () => {
    const providers = catalogue();
    expect(await new ModelDiscovery({ list: () => providers }).providers()).toEqual(providers);
  });

  it("model.options ne propose jamais le Whisper local (il ne fait que transcrire), même en demandant tous les fournisseurs", () => {
    const s = { get: (k: string) => (k === "activeProvider" ? "anthropic" : "claude-a"), patch: () => {} };
    expect(modelOptions(catalogue(), s, true).providers.map((p) => p.slug)).toEqual(["anthropic", "lmstudio", "ollama"]);
    expect(modelOptions(catalogue(), s, false).providers.map((p) => p.slug)).not.toContain("local-whisper-cpp");
  });
});

// --- le vrai noyau devant un faux serveur LM Studio --------------------------------------------------------------

const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeLmStudio(initial: string[]): Promise<{ port: number; ids: string[]; hits: () => number; paths: string[]; close: () => Promise<void> }> {
  const state = { ids: initial, hits: 0, paths: [] as string[] };
  const server: Server = createServer((req, res) => {
    state.hits += 1;
    state.paths.push(req.url ?? "");
    if (req.url !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: state.ids.map((id) => ({ id, object: "model" })) }));
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        port: (server.address() as { port: number }).port,
        get ids() {
          return state.ids;
        },
        set ids(v: string[]) {
          state.ids = v;
        },
        hits: () => state.hits,
        paths: state.paths,
        close: () => new Promise<void>((done) => server.close(() => done())),
      } as never),
    ),
  );
}

async function rigCore(lmPort: number) {
  const root = mkdtempSync(join(tmpdir(), "jarod-disc-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  core.settings.patch({
    activeProvider: "lmstudio",
    activeModel: "qwen3-8b",
    providerOverrides: { lmstudio: { baseUrl: `http://127.0.0.1:${lmPort}/v1` } },
    autoTitle: false,
  });
  const gw = createGateway({ core, version: "test" });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${gw.token}`);
  closers.push(() => ws.close());
  const waiting = new Map<number, (f: any) => void>();
  let id = 0;
  ws.addEventListener("message", (m) => {
    const f = JSON.parse(String(m.data));
    if (f.id !== undefined && typeof f.method !== "string") waiting.get(f.id)?.(f);
  });
  await new Promise<void>((ok, bad) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => bad(new Error("connexion refusée")));
  });
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: any; error?: any }>((ok) => {
      const n = ++id;
      waiting.set(n, ok);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  const put = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT", headers: { "x-hermes-session-token": gw.token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { core, rpc, put };
}

describe("devant le vrai noyau et un faux LM Studio", { timeout: 60_000 }, () => {
  it("le sélecteur voit les modèles de LM Studio (profil neuf, aucune clé) ; le Whisper local n'y est pas", async () => {
    const lm = await fakeLmStudio(["qwen3-8b", "gemma-3-4b", "text-embedding-nomic-embed-text-v1.5"]);
    closers.push(lm.close);
    const { rpc } = await rigCore(lm.port);
    const r = (await rpc("model.options", { include_unconfigured: false })).result;
    const row = r.providers.find((p: any) => p.slug === "lmstudio");
    expect(row).toMatchObject({ is_current: true, authenticated: true, auth_type: "none", models: ["gemma-3-4b", "qwen3-8b"], total_models: 2 });
    expect(r.providers.map((p: any) => p.slug)).not.toContain("local-whisper-cpp");
    expect(lm.paths).toContain("/v1/models");
  });

  it("changer de fournisseur ou de modèle relit tout de suite : un modèle chargé après l'ouverture apparaît sans redémarrage ni attente", async () => {
    const lm = await fakeLmStudio(["qwen3-8b"]);
    closers.push(lm.close);
    const { core, rpc } = await rigCore(lm.port);
    expect((await rpc("model.options", {})).result.providers.find((p: any) => p.slug === "lmstudio").models).toEqual(["qwen3-8b"]);
    lm.ids = ["qwen3-8b", "nouveau-modele"];
    // dans le délai du cache, la lecture précédente vaut encore
    expect((await rpc("model.options", {})).result.providers.find((p: any) => p.slug === "lmstudio").models).toEqual(["qwen3-8b"]);
    expect((await rpc("config.set", { key: "model", value: "lmstudio:nouveau-modele" })).result).toMatchObject({ value: "lmstudio:nouveau-modele" });
    expect(core.settings.get("activeModel")).toBe("nouveau-modele");
    expect((await rpc("model.options", {})).result.providers.find((p: any) => p.slug === "lmstudio").models).toEqual(["nouveau-modele", "qwen3-8b"]);
  });

  it("le choix par /model (ce qu'envoie le sélecteur de Herald) relit aussi : le modèle chargé après coup apparaît, et le fournisseur est bien celui choisi", async () => {
    const lm = await fakeLmStudio(["qwen3-8b"]);
    closers.push(lm.close);
    const { core, rpc } = await rigCore(lm.port);
    const sid = (await rpc("session.create", {})).result.session_id as string;
    await rpc("model.options", {});
    lm.ids = ["qwen3-8b", "charge-apres"];
    await rpc("slash.exec", { session_id: sid, command: "/model lmstudio:charge-apres" });
    expect([core.settings.get("activeProvider"), core.settings.get("activeModel")]).toEqual(["lmstudio", "charge-apres"]);
    expect((await rpc("model.options", {})).result.providers.find((p: any) => p.slug === "lmstudio").models).toEqual(["charge-apres", "qwen3-8b"]);
  });

  it("le choix par PUT /api/config relit aussi les modèles (même règle que config.set)", async () => {
    const lm = await fakeLmStudio(["qwen3-8b"]);
    closers.push(lm.close);
    const { rpc, put } = await rigCore(lm.port);
    await rpc("model.options", {});
    lm.ids = ["qwen3-8b", "charge-apres"];
    expect((await put("/api/config", { config: { model: { provider: "lmstudio", default: "charge-apres" } } })).status).toBe(200);
    expect((await rpc("model.options", {})).result.providers.find((p: any) => p.slug === "lmstudio").models).toEqual(["charge-apres", "qwen3-8b"]);
  });

  it("LM Studio éteint : le sélecteur répond quand même (fournisseur sans modèle), sans erreur", async () => {
    const lm = await fakeLmStudio(["qwen3-8b"]);
    const port = lm.port;
    await lm.close();
    const { rpc } = await rigCore(port);
    const res = await rpc("model.options", {});
    expect(res.error).toBeUndefined();
    expect(res.result.providers.find((p: any) => p.slug === "lmstudio")).toMatchObject({ models: [], authenticated: true });
  });
});
