/**
 * U4 (G7) — chemins du chat et de l'ouverture du kernel que `handlers.test.ts` ne traversait pas, sur un
 * VRAI kernel ; seul le fournisseur LLM est un stub OpenAI-compatible local (réponses scriptées par requête).
 * - chat : raisonnement, appel d'outil (refusé fail-closed → événement « failed »), usage avec cache,
 *   contexte de conversation (dossier, modèle), abandon par runId / global, relance du même runId,
 *   transcription refusée sur entrée invalide, application (quitter, relancer) ;
 * - kernel : `openDesktopKernel` (mode test : fournisseur, dictée locale, pas de minuteurs ; mode normal :
 *   verrou « desktop » exclusif puis libéré), `readVoiceConfig`.
 */
import { realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { plainCipher } from "@jarod/contracts";
import { bootApp, cleanup, discoverPlugins, tempDir } from "@jarod/kernel/testing";
import { type AgentRuntime, readRuntimeLock, RUNTIME_LOCK_FILE, RuntimeLockError } from "@jarod/plugin-agent";
import type { GatewayHub } from "@jarod/plugin-gateways";
import type { Scheduler } from "@jarod/plugin-scheduler";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHandlers, type DesktopKernel } from "../src/main/handlers/index.js";
import { dispatchOneaiCall } from "../src/main/ipc.js";
import { openDesktopKernel, readRagConfig, readVoiceConfig } from "../src/main/kernel.js";

afterEach(cleanup);

type Chunk = Record<string, unknown>;
/** Stub SSE : la n-ième requête reçoit `script[n]` (liste de morceaux `choices[0].delta` ou objets complets). */
function scripted(script: Chunk[][], delayMs = 0): Promise<{ port: number; close: () => void; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      bodies.push(JSON.parse(body || "{}"));
      const chunks = script[Math.min(bodies.length - 1, script.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify(c)}\n\n`);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      ok({ port: typeof a === "object" && a ? a.port : 0, close: () => server.close(), bodies });
    }),
  );
}
const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] });
const stop = (usage: Chunk, reason = "stop"): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage });

async function setup(port: number) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  plugins.mcp = { autoSync: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.updates = { appVersion: "0.1.0" };
  const app = (await bootApp(plugins)) as unknown as { agent: AgentRuntime; scheduler: Scheduler; gateways: GatewayHub };
  app.agent.settings.patch({
    activeProvider: "custom",
    activeModel: "jarod-test-model",
    providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${port}/v1`, models: ["jarod-test-model"] } },
    autoTitle: false,
  });
  const kernel: DesktopKernel = { agent: app.agent, scheduler: app.scheduler, gateways: app.gateways, profile: "default", dataRoot: tempDir() };
  const sent: unknown[][] = [];
  const shell = {
    appVersion: () => "0.1.0",
    quit: () => void sent.push(["<quit>"]),
    relaunch: () => void sent.push(["<relaunch>"]),
    writeClipboard: () => {},
    openExternal: async () => {},
    send: (channel: string, ...args: unknown[]) => void sent.push([channel, ...args]),
    tempDir: () => tempDir(),
    isInstalled: () => false,
    installSilently: () => {},
    openPath: async () => "",
    setThemeSource: () => {},
    spellChecker: () => ({ available: [], selected: [], preferredSystem: [] }),
    setSpellCheckerLanguages: () => {},
    logsDir: () => tempDir(),
    pickFolder: async () => picks.shift() ?? null,
  };
  const picks: string[] = [];
  const handlers = createHandlers({ kernel: () => kernel, shell });
  const call = (channel: string, ...args: unknown[]) => dispatchOneaiCall(handlers, channel, args, true) as Promise<unknown> | unknown;
  const on = (ch: string, runId?: string) => sent.filter(([c, r]) => c === ch && (runId === undefined || r === runId));
  return { app, call, sent, on, picks };
}

describe("U4 chat : outils, raisonnement, usage, contexte", () => {
  it("raisonnement poussé à part ; outil refusé (fail-closed) → running puis failed ; usage avec cache ; réponse finale", async () => {
    const stub = await scripted([
      [
        delta({ reasoning_content: "Je vérifie l'heure." }),
        delta({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "outil_inexistant", arguments: "{}" } }] }),
        stop({ prompt_tokens: 40, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 32 } }, "tool_calls"),
      ],
      [delta({ content: "Impossible, " }), delta({ content: "outil absent." }), stop({ prompt_tokens: 60, completion_tokens: 4 })],
    ]);
    try {
      const { call, on } = await setup(stub.port);
      const r = (await call("send-message", "Quelle heure ?", undefined, undefined, [], [], undefined, "run-t")) as { response: string; sessionId: string };
      expect(r.response).toBe("Impossible, outil absent.");
      expect(on("chat-reasoning-chunk", "run-t").map(([, , t]) => t)).toEqual(["Je vérifie l'heure."]);
      const tools = on("chat-tool-event", "run-t").map(([, , e]) => e as { callId: string; status: string; name: string; hasStableCallId: boolean; result?: string });
      expect(tools.map((e) => [e.callId, e.name, e.status, e.hasStableCallId])).toEqual([
        ["call-1", "outil_inexistant", "running", true],
        ["call-1", "outil_inexistant", "failed", true],
      ]);
      expect(tools[1]!.result).toBeTruthy();
      expect(on("chat-usage", "run-t").map(([, , u]) => u)).toEqual([
        { promptTokens: 40, completionTokens: 6, totalTokens: 46, cacheReadTokens: 32 },
        { promptTokens: 60, completionTokens: 4, totalTokens: 64 },
      ]);
      expect(on("chat-done", "run-t")).toEqual([["chat-done", "run-t", r.sessionId]]);
      expect(stub.bodies).toHaveLength(2);
    } finally {
      stub.close();
    }
  });

  it("dossier de contexte et modèle choisis : appliqués à CETTE conversation seulement", async () => {
    const stub = await scripted([[delta({ content: "ok" }), stop({ prompt_tokens: 1, completion_tokens: 1 })]]);
    try {
      const { call, app, picks } = await setup(stub.port);
      // Q12 : le dossier lié devient une racine de la garde fichiers → choisi dans la boîte native d'abord.
      const unpicked = tempDir();
      await expect(Promise.resolve().then(() => call("send-message", "Non", undefined, undefined, [], [], unpicked, "run-x"))).rejects.toThrow(/garde fichiers : dossier non choisi/);
      const folder = realpathSync.native(tempDir());
      picks.push(folder);
      expect(await call("select-folder")).toBe(folder);
      const r = (await call("send-message", "Salut", undefined, undefined, [], [], folder, "run-c", { provider: "custom", model: "jarod-test-model", baseUrl: "http://ignorée" })) as {
        sessionId: string;
      };
      expect(app.agent.sessions.get(r.sessionId)!.context).toMatchObject({ workspace: folder, provider: "custom", model: "jarod-test-model" });
      const other = app.agent.sessions.create("autre");
      expect(app.agent.sessions.get(other.id)!.context).toBeUndefined();
      // Forme incomplète : pas de modèle inventé → le modèle ACTIF (Hermes relit config.yaml à chaque message).
      app.agent.settings.patch({ activeModel: "modele-actif" });
      await call("send-message", "Encore", undefined, r.sessionId, [], [], undefined, "run-c", { provider: "custom" });
      expect(app.agent.sessions.get(r.sessionId)!.context).toMatchObject({ provider: "custom", model: "modele-actif" });
      // Sans choix propre, la conversation suit set-model-config au message suivant.
      await call("set-model-config", "custom", "choisi-dans-le-chat", "");
      await call("send-message", "Et là ?", undefined, r.sessionId, [], [], undefined, "run-c");
      expect(app.agent.sessions.get(r.sessionId)!.context).toMatchObject({ workspace: folder, provider: "custom", model: "choisi-dans-le-chat" });
      expect(stub.bodies.map((b) => (b as { model: string }).model)).toEqual(["jarod-test-model", "modele-actif", "choisi-dans-le-chat"]);
    } finally {
      stub.close();
    }
  });
});

describe("Q10 : modèle « pour cette conversation seulement » (get/set-session-model-override)", () => {
  it("épinglée → réouvre et répond sur SON modèle ; non épinglée → suit l'actif ; null → suit de nouveau l'actif", async () => {
    const one = [delta({ content: "ok" }), stop({ prompt_tokens: 1, completion_tokens: 1 })];
    const stub = await scripted([one]);
    try {
      const { call, app } = await setup(stub.port);
      const models = () => stub.bodies.map((b) => (b as { model: string }).model);
      const send = async (text: string, sessionId?: string, override?: unknown) =>
        ((await call("send-message", text, undefined, sessionId, [], [], undefined, `run-${text}`, override)) as { sessionId: string }).sessionId;

      // Conversation jamais lancée (pas de contexte) : rien d'épinglé ; id inconnu : null (SANK-UI).
      const blank = app.agent.sessions.create("vide");
      expect(call("get-session-model-override", blank.id)).toBeNull();
      expect(call("get-session-model-override", "inconnue")).toBeNull();

      // ÉPINGLÉE : choix fait dans le Chat (l'écran l'enregistre dès que la conversation existe).
      const pinned = await send("a1", undefined, { provider: "custom", model: "m-choisi", baseUrl: "" });
      expect(call("set-session-model-override", pinned, { provider: "custom", model: "m-choisi", baseUrl: "http://hote-du-renderer/v1" })).toBe(true);
      // NON ÉPINGLÉE : aucun choix propre.
      const free = await send("b1");
      expect(call("get-session-model-override", free)).toBeNull();

      // Le modèle actif change (set-model-config)…
      await call("set-model-config", "custom", "m-actif-2", "");
      // … la conversation épinglée se rouvre sur son modèle (URL = celle du catalogue, pas celle du renderer)
      expect(call("get-session-model-override", pinned)).toEqual({ provider: "custom", model: "m-choisi", baseUrl: `http://127.0.0.1:${stub.port}/v1` });
      // … et y répond même si l'écran n'envoie pas de choix ; la non épinglée suit l'actif.
      await send("a2", pinned);
      await send("b2", free);
      expect(app.agent.sessions.get(pinned)!.context).toMatchObject({ model: "m-choisi", modelPinned: true });
      expect(app.agent.sessions.get(free)!.context).toMatchObject({ model: "m-actif-2" });

      // null (désépingler, forme SANK-UI) : la conversation suit de nouveau le modèle actif.
      expect(call("set-session-model-override", pinned, null)).toBe(true);
      expect(call("get-session-model-override", pinned)).toBeNull();
      await send("a3", pinned);
      expect(app.agent.sessions.get(pinned)!.context).toMatchObject({ model: "m-actif-2" });
      expect(models()).toEqual(["m-choisi", "jarod-test-model", "m-choisi", "m-actif-2", "m-actif-2"]);

      // Garde : conversation inconnue, fournisseur hors catalogue, forme invalide.
      expect(() => call("set-session-model-override", "inconnue", { provider: "custom", model: "x" })).toThrow(/conversation inconnue/);
      expect(() => call("set-session-model-override", pinned, { provider: "fournisseur-pirate", model: "x" })).toThrow(/fournisseur inconnu/);
      expect(() => call("set-session-model-override", pinned, { provider: 1, model: "x" })).toThrow(/texte attendus/);
      expect(call("get-session-model-override", pinned)).toBeNull();
    } finally {
      stub.close();
    }
  });
});

describe("U4 chat : abandon et relance", () => {
  const slow = () =>
    scripted(
      [[...["Il ", "était ", "une ", "fois ", "une ", "longue ", "histoire."].map((t) => delta({ content: t })), stop({ prompt_tokens: 3, completion_tokens: 7 })]],
      150,
    );

  it("abort-chat(runId) : ce tour-là s'arrête, le texte reçu est gardé et marqué interrompu", async () => {
    const stub = await slow();
    try {
      const { call, on, app } = await setup(stub.port);
      const p = call("send-message", "Raconte", undefined, undefined, [], [], undefined, "run-a") as Promise<{ response: string; sessionId: string }>;
      while (on("chat-chunk", "run-a").length < 2) await new Promise((r) => setTimeout(r, 20));
      call("abort-chat", "run-a");
      const r = await p;
      expect(r.response).toMatch(/\*\[interrompu\]\*$/);
      expect(r.response.length).toBeLessThan("Il était une fois une longue histoire.".length + 20);
      const last = app.agent.messages.list(r.sessionId).at(-1)!;
      expect(last).toMatchObject({ role: "assistant" });
      expect(last.content).toMatch(/interrompu/);
      // runId inconnu : sans effet ; sans runId : tout s'arrête (rien en cours ici).
      expect(call("abort-chat", "run-inconnu")).toBeUndefined();
      expect(call("abort-chat")).toBeUndefined();
    } finally {
      stub.close();
    }
  });

  it("abort-chat() sans runId arrête tous les tours en cours", async () => {
    const stub = await slow();
    try {
      const { call, on } = await setup(stub.port);
      const p1 = call("send-message", "Un", undefined, undefined, [], [], undefined, "run-1") as Promise<{ response: string }>;
      const p2 = call("send-message", "Deux", undefined, undefined, [], [], undefined, "run-2") as Promise<{ response: string }>;
      while (on("chat-chunk", "run-1").length < 1 || on("chat-chunk", "run-2").length < 1) await new Promise((r) => setTimeout(r, 20));
      call("abort-chat");
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.response).toMatch(/interrompu/);
      expect(r2.response).toMatch(/interrompu/);
    } finally {
      stub.close();
    }
  });

  it("relance du même runId : le tour précédent est abandonné (SANK-UI register.ts)", async () => {
    const stub = await slow();
    try {
      const { call, on } = await setup(stub.port);
      const first = call("send-message", "Premier", undefined, undefined, [], [], undefined, "run-r") as Promise<{ response: string }>;
      while (on("chat-chunk", "run-r").length < 1) await new Promise((r) => setTimeout(r, 20));
      const second = call("send-message", "Second", undefined, undefined, [], [], undefined, "run-r") as Promise<{ response: string }>;
      expect((await first).response).toMatch(/interrompu/);
      expect((await second).response).toBe("Il était une fois une longue histoire.");
    } finally {
      stub.close();
    }
  });

  it("une réponse déjà en cours dans la conversation : chat-error + rejet (busy)", async () => {
    const stub = await slow();
    try {
      const { call, on } = await setup(stub.port);
      const first = call("send-message", "Un", undefined, undefined, [], [], undefined, "run-x") as Promise<{ response: string; sessionId: string }>;
      while (on("chat-session-started", "run-x").length < 1) await new Promise((r) => setTimeout(r, 10));
      const sessionId = on("chat-session-started", "run-x")[0]![2] as string;
      await expect(call("send-message", "Deux", undefined, sessionId, [], [], undefined, "run-y")).rejects.toThrow(/déjà en cours/);
      expect(on("chat-error", "run-y")).toHaveLength(1);
      await first;
    } finally {
      stub.close();
    }
  });

  it("transcription : audio invalide refusé ; application : quitter, relancer", async () => {
    const stub = await scripted([[stop({})]]);
    try {
      const { call, sent } = await setup(stub.port);
      await expect(call("transcribe-audio", "pas de l'audio", "audio/webm")).rejects.toThrow(/audio invalide/);
      await expect(call("transcribe-audio", new Uint8Array(4), 42)).rejects.toThrow(/audio invalide/);
      await expect(call("transcribe-audio", new Uint8Array(4), "audio/webm", "autre")).rejects.toThrow(/non servi/);
      expect(() => call("send-message", 42)).toThrow(/message invalide/);
      call("quit-app");
      call("relaunch-app");
      expect(sent.filter(([c]) => String(c).startsWith("<"))).toEqual([["<quit>"], ["<relaunch>"]]);
    } finally {
      stub.close();
    }
  });
});

describe("U4 kernel du desktop : openDesktopKernel", () => {
  it("mode test : fournisseur stub, dictée locale sur le port de voice.json, mises à jour sans minuteur", async () => {
    const root = tempDir();
    const voice = join(root, "voice.json");
    writeFileSync(voice, JSON.stringify({ whisper: { bin: "whisper-server.exe", model: "m.bin", port: 8999 } }));
    const k = await openDesktopKernel({
      dataRoot: root,
      cipher: plainCipher,
      appVersion: "1.2.3",
      testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "stub-model" },
      voiceConfigPath: voice,
      updateFolder: join(root, "releases"),
    });
    try {
      expect(k.profile).toBe("default");
      expect(k.dataDir.startsWith(root)).toBe(true);
      const s = k.agent.settings.getAll();
      expect(s).toMatchObject({ activeProvider: "custom", activeModel: "stub-model", autoTitle: false });
      expect(s.providerOverrides).toMatchObject({ custom: { baseUrl: "http://127.0.0.1:1/v1", models: ["stub-model"] }, "local-whisper-cpp": { baseUrl: "http://127.0.0.1:8999/v1" } });
      expect(s.voice).toMatchObject({ sttProvider: "local-whisper-cpp", sttModel: "" });
      expect(s.updates.autoCheck).toBe(false);
      expect(k.updates!.updateFolder()).toBe(join(root, "releases"));
      expect(k.voice).toBeDefined();
      expect(k.persona).toBeDefined();
    } finally {
      await k.dispose();
    }
  });

  it("mode normal : verrou « desktop » posé puis libéré ; profil tenu par un AUTRE processus vivant → refus", async () => {
    const root = tempDir();
    const k = await openDesktopKernel({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3" });
    try {
      expect(readRuntimeLock(k.dataDir)).toMatchObject({ pid: process.pid, mode: "desktop" });
    } finally {
      await k.dispose();
    }
    expect(readRuntimeLock(k.dataDir)).toBeNull();
    // Un autre processus vivant (le parent de ce worker) tient le profil : `RuntimeLockError`, rien d'ouvert.
    writeFileSync(join(k.dataDir, RUNTIME_LOCK_FILE), JSON.stringify({ pid: process.ppid, mode: "serve", startedAt: Date.now() }));
    await expect(openDesktopKernel({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3" })).rejects.toBeInstanceOf(RuntimeLockError);
  });

  it("readVoiceConfig : absent → null ; objet → config ; autre JSON → erreur explicite", () => {
    const dir = tempDir();
    expect(readVoiceConfig(join(dir, "absent.json"))).toBeNull();
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ capture: { speechRms: 700 } }));
    expect(readVoiceConfig(join(dir, "ok.json"))).toEqual({ capture: { speechRms: 700 } });
    writeFileSync(join(dir, "liste.json"), "[1,2]");
    expect(() => readVoiceConfig(join(dir, "liste.json"))).toThrow(/un objet JSON est attendu/);
  });

  it("readRagConfig : absent → null ; sidecar turbovec = chemin absolu explicite, sinon erreur", () => {
    const dir = tempDir();
    expect(readRagConfig(join(dir, "absent.json"))).toBeNull();
    const bin = join(dir, "turbovec-sidecar.exe");
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ turbovec: { bin } }));
    expect(readRagConfig(join(dir, "ok.json"))).toEqual({ turbovec: { bin } });
    writeFileSync(join(dir, "vide.json"), "{}");
    expect(readRagConfig(join(dir, "vide.json"))).toEqual({});
    writeFileSync(join(dir, "relatif.json"), JSON.stringify({ turbovec: { bin: "turbovec-sidecar.exe" } }));
    expect(() => readRagConfig(join(dir, "relatif.json"))).toThrow(/chemin absolu/);
  });

  it("rag.json du profil → mode fantôme câblé mais inactif tant que le profil ne pose pas vectorShadow", async () => {
    const root = tempDir();
    const rag = join(root, "rag.json");
    writeFileSync(rag, JSON.stringify({ turbovec: { bin: join(root, "absent.exe") } }));
    const k = await openDesktopKernel({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", ragConfigPath: rag });
    try {
      const shadow = (k.app as unknown as { rag: { shadow: { kind: string; report(): { state: string; queries: number } } | null } }).rag.shadow;
      expect(shadow?.kind).toBe("turbovec");
      expect(shadow?.report()).toMatchObject({ state: "idle", queries: 0 });
      expect(k.agent.settings.get("ecosystem").vectorShadow).toBeNull();
    } finally {
      await k.dispose();
    }
  });
});
