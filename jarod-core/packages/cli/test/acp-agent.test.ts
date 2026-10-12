// SPECS-P5-ACP.md §3-§4 (a)(b)(c)(d) au niveau des gestionnaires, sur un cœur FACTICE et un transport FACTICE (aucun processus, aucun réseau).
// La conformité par un client indépendant, en processus réel, est dans acp-conformance.test.ts.
import type { InitializeResponse, LoadSessionResponse, NewSessionResponse, PromptResponse } from "@agentclientprotocol/sdk";
import type { Message, ToolCall } from "@jarod/contracts";
import type { AgentHooks } from "@jarod/plugin-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcpHandlers, type AcpCore, type AcpTransport } from "../src/acp-agent.js";
import { ERR } from "../src/jsonrpc-stdio.js";

// Assemblé à l'exécution : le garde du dépôt refuse la FORME d'une clé dans un fichier suivi.
const KEY = ["sk", "CANARI-AGENT-0123456789abcdef0123"].join("-");
const CWD = process.platform === "win32" ? "C:\\projets\\demo" : "/home/u/demo";

interface FakeSession {
  id: string;
  title: string;
  context?: { workspace?: string; agentMode?: string };
}
function fakeCore(script?: (hooks: AgentHooks, text: string, id: string, signal: { stopped: boolean }) => Promise<void>) {
  const sessions = new Map<string, FakeSession>();
  const messages = new Map<string, Message[]>();
  const calls: string[] = [];
  const signal = { stopped: false };
  let n = 0;
  const core: AcpCore = {
    sessions: {
      create: (title) => {
        const s = { id: `s${++n}`, title };
        sessions.set(s.id, s);
        messages.set(s.id, []);
        return s;
      },
      get: (id) => sessions.get(id),
      rename: (id, title) => void (sessions.get(id)!.title = title),
    },
    messages: { list: (id) => messages.get(id) ?? [] },
    updateSessionContext: (id, patch) => {
      calls.push(`ctx:${id}:${JSON.stringify(patch)}`);
      sessions.get(id)!.context = { ...sessions.get(id)!.context, ...patch };
    },
    runAndWait: async (id, text, hooks) => {
      calls.push(`run:${id}:${text}`);
      signal.stopped = false;
      await script?.(hooks, text, id, signal);
      return { text: "", };
    },
    stop: (id) => {
      calls.push(`stop:${id}`);
      signal.stopped = true;
    },
  };
  return { core, sessions, messages, calls, signal };
}

function fakeTransport(permissionAnswer: (params: any) => Promise<unknown> | unknown = () => ({ outcome: { outcome: "selected", optionId: "allow_once" } })) {
  const frames: { kind: "notify" | "request"; method: string; params: any }[] = [];
  const t: AcpTransport = {
    notify: (method, params) => void frames.push({ kind: "notify", method, params }),
    request: async (method, params) => {
      frames.push({ kind: "request", method, params });
      return permissionAnswer(params);
    },
  };
  return { t, frames, updates: () => frames.filter((f) => f.method === "session/update").map((f) => f.params.update) };
}

const tc = (over: Partial<ToolCall> = {}): ToolCall => ({ id: "c1", name: "run_shell", args: { command: "ls" }, ...over });
const emitText = (hooks: AgentHooks, id: string, text: string) => hooks.emit({ type: "delta", sessionId: id, streamId: "x", text });
const INIT = { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zed", version: "9" } };

let core: ReturnType<typeof fakeCore>;
let tr: ReturnType<typeof fakeTransport>;
function make(script?: Parameters<typeof fakeCore>[0], answer?: Parameters<typeof fakeTransport>[0], extra: { permissionTimeoutMs?: number } = {}) {
  core = fakeCore(script);
  tr = fakeTransport(answer);
  const h = createAcpHandlers({ core: core.core, transport: tr.t, version: "9.9.9", ...extra });
  const req = (m: string, p?: unknown) => h.onRequest(m, p);
  const newSession = async () => ((await req("session/new", { cwd: CWD, mcpServers: [] })) as NewSessionResponse).sessionId;
  return { h, req, newSession };
}
beforeEach(() => vi.spyOn(process.stderr, "write").mockImplementation(() => true));

describe("ACP : initialize", () => {
  it("version 1, infos de l'agent, capacités : load oui ; images, audio, MCP http/sse NON ; ressources intégrées oui ; aucune méthode d'authentification", async () => {
    const { req } = make();
    const r = (await req("initialize", INIT)) as InitializeResponse;
    expect(r.protocolVersion).toBe(1);
    expect(r.agentInfo).toMatchObject({ name: "jarod", version: "9.9.9" });
    expect(r.agentCapabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } });
    expect(r.authMethods ?? []).toEqual([]);
  });
  it("authenticate et toute méthode inconnue → -32601 ; session/* avant initialize → -32600", async () => {
    const { req } = make();
    await expect(req("session/new", { cwd: CWD, mcpServers: [] })).rejects.toMatchObject({ code: ERR.invalidRequest });
    await req("initialize", INIT);
    for (const m of ["authenticate", "session/fork", "session/list", "session/resume", "fs/read_text_file", "x/y"]) await expect(req(m, {})).rejects.toMatchObject({ code: ERR.methodNotFound });
  });
});

describe("ACP : session/new", () => {
  it("crée une conversation Jarod titrée 🔌 <éditeur>, dossier de travail = cwd, mode build ; rend sessionId et les deux modes", async () => {
    const { req } = make();
    await req("initialize", INIT);
    const r = (await req("session/new", { cwd: CWD, mcpServers: [] })) as NewSessionResponse;
    expect(core.sessions.get(r.sessionId)!.title).toMatch(/^🔌 zed/);
    expect(core.calls.some((c) => c.startsWith(`ctx:${r.sessionId}:`) && c.includes(JSON.stringify(CWD).slice(1, -1)) && c.includes('"agentMode":"build"'))).toBe(true);
    expect(r.modes).toMatchObject({ currentModeId: "default" });
    expect(r.modes!.availableModes.map((m) => m.id).sort()).toEqual(["default", "plan"]);
  });
  it("cwd relatif ou absent → -32602 ; serveurs MCP de l'éditeur IGNORÉS (signalés sur stderr), jamais lancés", async () => {
    const { req } = make();
    await req("initialize", INIT);
    await expect(req("session/new", { cwd: "relatif/dossier", mcpServers: [] })).rejects.toMatchObject({ code: ERR.invalidParams });
    await expect(req("session/new", { mcpServers: [] })).rejects.toMatchObject({ code: ERR.invalidParams });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await req("session/new", { cwd: CWD, mcpServers: [{ name: "x", command: "node", args: [], env: [] }] });
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(/ignor/i);
    expect(core.calls.filter((c) => c.startsWith("run:"))).toEqual([]);
  });
});

describe("ACP : session/prompt", () => {
  it("les morceaux arrivent AVANT la réponse, dans l'ordre ; stopReason = end_turn ; le titre suit la première question", async () => {
    const order: string[] = [];
    const { req, newSession } = make(async (hooks, _t, id) => {
      for (const part of ["Bon", "jour", " !"]) emitText(hooks, id, part);
      hooks.emit({ type: "done", sessionId: id });
    });
    await req("initialize", INIT);
    const sid = await newSession();
    const orig = tr.t.notify;
    tr.t.notify = (m, p) => (order.push("notify"), orig(m, p));
    const r = (await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Dis bonjour" }] })) as PromptResponse;
    order.push("response");
    expect(r.stopReason).toBe("end_turn");
    expect(order).toEqual(["notify", "notify", "notify", "response"]);
    expect(tr.updates().map((u) => u.content.text)).toEqual(["Bon", "jour", " !"]);
    expect(core.sessions.get(sid)!.title).toBe("🔌 zed — Dis bonjour");
    expect(core.calls).toContain(`run:${sid}:Dis bonjour`);
  });

  it("prompt : session inconnue → -32602 ; image/audio → -32602 clair ; tour déjà en cours → -32600", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { req, newSession } = make(async () => void (await gate));
    await req("initialize", INIT);
    await expect(req("session/prompt", { sessionId: "inconnue", prompt: [{ type: "text", text: "x" }] })).rejects.toMatchObject({ code: ERR.invalidParams });
    const sid = await newSession();
    await expect(req("session/prompt", { sessionId: sid, prompt: [{ type: "image", data: "A", mimeType: "image/png" }] })).rejects.toMatchObject({ code: ERR.invalidParams, message: expect.stringMatching(/image/) });
    const first = req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "long" }] });
    await new Promise((r) => setTimeout(r, 10));
    await expect(req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "second" }] })).rejects.toMatchObject({ code: ERR.invalidRequest });
    release();
    await first;
  });

  it("outil sensible : demande d'autorisation à l'éditeur ; allow_once → l'outil peut s'exécuter ; reject_once → refusé ; les deux options seulement", async () => {
    const decisions: boolean[] = [];
    for (const optionId of ["allow_once", "reject_once"]) {
      const { req, newSession } = make(
        async (hooks, _t, id) => {
          hooks.emit({ type: "tool-start", sessionId: id, call: tc() });
          decisions.push(await hooks.approve(id, tc(), "Exécute une commande"));
        },
        () => ({ outcome: { outcome: "selected", optionId } }),
      );
      await req("initialize", INIT);
      const sid = await newSession();
      await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] });
      const asked = tr.frames.find((f) => f.method === "session/request_permission")!;
      expect(asked.params.sessionId).toBe(sid);
      expect(asked.params.toolCall).toMatchObject({ toolCallId: "c1", kind: "execute" });
      expect(asked.params.options.map((o: { kind: string }) => o.kind)).toEqual(["allow_once", "reject_once"]);
    }
    expect(decisions).toEqual([true, false]);
  });

  it("éditeur muet pendant le délai → REFUS (échec fermé) ; le tour se termine normalement", async () => {
    let approved: boolean | undefined;
    const { req, newSession } = make(
      async (hooks, _t, id) => void (approved = await hooks.approve(id, tc(), "x")),
      () => new Promise(() => {}),
      { permissionTimeoutMs: 50 },
    );
    await req("initialize", INIT);
    const sid = await newSession();
    const r = (await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] })) as PromptResponse;
    expect(approved).toBe(false);
    expect(r.stopReason).toBe("end_turn");
  });

  it("outil : tool_call puis tool_call_update ; arguments et sorties expurgés", async () => {
    const { req, newSession } = make(async (hooks, _t, id) => {
      hooks.emit({ type: "tool-start", sessionId: id, call: tc({ args: { command: `echo ${KEY}` } }) });
      hooks.emit({ type: "message", sessionId: id, message: { id: "m", sessionId: id, role: "tool", content: `sortie ${KEY}`, toolCallId: "c1", toolName: "run_shell", createdAt: 1 } as Message });
    });
    await req("initialize", INIT);
    const sid = await newSession();
    await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] });
    expect(tr.updates().map((u) => u.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
    expect(JSON.stringify(tr.frames)).not.toContain("CANARI-AGENT");
  });
});

describe("ACP : session/cancel", () => {
  it("annule le tour : core.stop, réponse « cancelled » rapide, AUCUNE mise à jour après la réponse, la session reste utilisable", async () => {
    let id0 = "";
    const { req, h, newSession } = make(async (hooks, text, id) => {
      id0 = id;
      if (text === "long") {
        emitText(hooks, id, "début");
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (core.signal.stopped) {
              clearInterval(t);
              resolve();
            }
          }, 5);
        });
        setTimeout(() => emitText(hooks, id, "TARDIF"), 20); // un événement tardif de l'agent, après la fin du tour
      } else emitText(hooks, id, "ok");
    });
    await req("initialize", INIT);
    const sid = await newSession();
    const p = req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "long" }] });
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    await h.onNotification("session/cancel", { sessionId: sid });
    const r = (await p) as PromptResponse;
    expect(r.stopReason).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(core.calls).toContain(`stop:${sid}`);
    const n = tr.frames.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(tr.frames.length, "aucune trame après la réponse du prompt").toBe(n);
    expect(JSON.stringify(tr.frames)).not.toContain("TARDIF");
    const again = (await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "encore" }] })) as PromptResponse;
    expect(again.stopReason).toBe("end_turn");
    expect(id0).toBe(sid);
  });

  it("annulation PENDANT une demande d'autorisation : refus immédiat, outil non exécuté, réponse « cancelled »", async () => {
    let approved: boolean | undefined;
    const { req, h, newSession } = make(
      async (hooks, _t, id) => void (approved = await hooks.approve(id, tc(), "x")),
      () => new Promise(() => {}),
    );
    await req("initialize", INIT);
    const sid = await newSession();
    const p = req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] });
    await new Promise((r) => setTimeout(r, 20));
    await h.onNotification("session/cancel", { sessionId: sid });
    expect(((await p) as PromptResponse).stopReason).toBe("cancelled");
    expect(approved).toBe(false);
  });

  it("annuler une session inconnue ou au repos ne fait rien et ne lève pas", async () => {
    const { h, newSession, req } = make();
    await req("initialize", INIT);
    const sid = await newSession();
    await expect(Promise.resolve(h.onNotification("session/cancel", { sessionId: "nulle part" }))).resolves.toBeUndefined();
    await expect(Promise.resolve(h.onNotification("session/cancel", { sessionId: sid }))).resolves.toBeUndefined();
  });
});

describe("ACP : session/set_mode", () => {
  it("default → build, plan → plan (lecture seule côté agent) ; mode inconnu → -32602", async () => {
    const { req, newSession } = make();
    await req("initialize", INIT);
    const sid = await newSession();
    await req("session/set_mode", { sessionId: sid, modeId: "plan" });
    expect(core.calls.at(-1)).toContain('"agentMode":"plan"');
    await req("session/set_mode", { sessionId: sid, modeId: "default" });
    expect(core.calls.at(-1)).toContain('"agentMode":"build"');
    await expect(req("session/set_mode", { sessionId: sid, modeId: "accept_edits" })).rejects.toMatchObject({ code: ERR.invalidParams });
    await expect(req("session/set_mode", { sessionId: "x", modeId: "plan" })).rejects.toMatchObject({ code: ERR.invalidParams });
  });
});

describe("ACP : session/load — rejeu avant la réponse", () => {
  const history = (sid: string): Message[] => [
    { id: "1", sessionId: sid, role: "user", content: "Liste les fichiers", createdAt: 1 },
    { id: "2", sessionId: sid, role: "assistant", content: "Je regarde.", thinking: "PENSEE-SECRETE", toolCalls: [tc({ args: { command: `ls ${KEY}` } })], createdAt: 2 },
    { id: "3", sessionId: sid, role: "tool", content: "a.ts\nb.ts", toolCallId: "c1", toolName: "run_shell", createdAt: 3 },
    { id: "4", sessionId: sid, role: "assistant", content: "Il y a deux fichiers.", createdAt: 4 },
    { id: "5", sessionId: sid, role: "assistant", content: "RESUME-COMPACTION", kind: "summary", createdAt: 5 },
  ] as Message[];

  it("rejoue user, assistant, appels d'outils et résultats dans l'ordre, AVANT de répondre ; sans réflexion ni résumé de compaction ; expurgé", async () => {
    const { req } = make();
    await req("initialize", INIT);
    core.core.sessions.create("🔌 zed — ancienne"); // s1
    core.messages.set("s1", history("s1"));
    const r = (await req("session/load", { sessionId: "s1", cwd: CWD, mcpServers: [] })) as LoadSessionResponse;
    expect(tr.updates().map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    expect(tr.updates()[0].content.text).toBe("Liste les fichiers");
    expect(tr.updates()[4].content.text).toBe("Il y a deux fichiers.");
    expect(JSON.stringify(tr.frames)).not.toMatch(/PENSEE-SECRETE|RESUME-COMPACTION|CANARI-AGENT/);
    expect(r.modes).toMatchObject({ currentModeId: "default" });
    expect(core.calls.some((c) => c.startsWith("ctx:s1:") && c.includes('"workspace"'))).toBe(true);
    // La session chargée est utilisable pour un prompt.
    const p = (await req("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "suite" }] })) as PromptResponse;
    expect(p.stopReason).toBe("end_turn");
  });

  it("identifiant inconnu → -32602 ; cwd invalide → -32602", async () => {
    const { req } = make();
    await req("initialize", INIT);
    await expect(req("session/load", { sessionId: "nulle", cwd: CWD, mcpServers: [] })).rejects.toMatchObject({ code: ERR.invalidParams });
    core.core.sessions.create("x");
    await expect(req("session/load", { sessionId: "s1", cwd: "relatif", mcpServers: [] })).rejects.toMatchObject({ code: ERR.invalidParams });
  });
});
