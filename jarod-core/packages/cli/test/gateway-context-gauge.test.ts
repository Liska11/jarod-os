// La jauge de contexte de la fenêtre : `Usage` du contrat (context_used / context_max / context_percent) calculé depuis les jetons que le fournisseur a rapportés,
// joint à `session.info`, à `message.complete` et, après `/compact` ou `/model`, à un événement `session.usage`.
import type { Message, Session } from "@jarod/contracts";
import type { AgentHooks } from "@jarod/plugin-agent";
import { afterEach, describe, expect, it } from "vitest";
import { sessionUsage } from "../src/gateway/protocol.js";
import { createGateway, type Gateway, type GatewayCore } from "../src/gateway/server.js";
import { WS_TOKEN_PREFIX, WS_PROTOCOL } from "../src/gateway/ws.js";

const msg = (role: Message["role"], extra: Partial<Message> = {}): Message => ({ id: `m${Math.random()}`, sessionId: "s1", role, content: "", createdAt: 1, ...extra });

describe("sessionUsage", () => {
  it("rend null sans message", () => {
    expect(sessionUsage([], 16384)).toBeNull();
  });

  it("prend les jetons rapportés pour la dernière réponse (invite + réponse) et en tire la part de la fenêtre", () => {
    const usage = sessionUsage([msg("user", { content: "salut" }), msg("assistant", { content: "bonjour", inputTokens: 7000, outputTokens: 500 }), msg("user", { content: "encore" }), msg("assistant", { content: "oui", inputTokens: 8000, outputTokens: 200 })], 16384, "qwen");

    expect(usage).toEqual({ model: "qwen", calls: 2, compressions: 0, context_used: 8200, context_max: 16384, context_percent: 50, context_estimated: false });
  });

  it("sans fenêtre connue : le nombre de jetons, pas de pourcentage", () => {
    const usage = sessionUsage([msg("assistant", { inputTokens: 1000, outputTokens: 24 })], 0);

    expect(usage).toMatchObject({ context_used: 1024, context_max: null, context_percent: null });
  });

  it("plafonne le pourcentage à 100", () => {
    expect(sessionUsage([msg("assistant", { inputTokens: 30000, outputTokens: 10 })], 16384)).toMatchObject({ context_percent: 100 });
  });

  it("après un résumé du contexte, la mesure rapportée est périmée : estimation sur ce qui part encore au modèle", () => {
    const usage = sessionUsage(
      [
        msg("user", { content: "x".repeat(8000), compacted: true }),
        msg("assistant", { content: "y".repeat(8000), inputTokens: 9000, outputTokens: 2000, compacted: true }),
        msg("assistant", { content: "résumé ".repeat(100), kind: "summary" }),
        msg("user", { content: "suite ".repeat(100) }),
      ],
      16384,
    );

    expect(usage).toMatchObject({ context_estimated: true, compressions: 1 });
    // 700 + 600 caractères / 4 : bien au-dessous des 11 000 jetons d'avant le résumé.
    expect(usage?.context_used).toBe(325);
  });

  it("une réponse rapportée APRÈS le résumé redevient la mesure", () => {
    const usage = sessionUsage([msg("assistant", { kind: "summary", content: "r" }), msg("user", { content: "q" }), msg("assistant", { content: "a", inputTokens: 1200, outputTokens: 80 })], 16384);

    expect(usage).toMatchObject({ context_used: 1280, context_estimated: false });
  });
});

// ── Bout en bout, avec un faux noyau ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function rig(script: (id: string, hooks: AgentHooks, messages: Map<string, Message[]>) => Promise<void>, settings: Record<string, unknown> = {}) {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, Message[]>();
  let seq = 0;
  const ran: string[] = [];
  const core: GatewayCore = {
    sessions: {
      create: (title = "Nouvelle conversation") => {
        const s: Session = { id: `s${++seq}`, title, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, pinned: false, messageCount: 0 };
        sessions.set(s.id, s);
        messages.set(s.id, []);
        return s;
      },
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
      delete: (id) => void sessions.delete(id),
    },
    messages: { list: (id) => messages.get(id) ?? [] },
    start: (id) => {
      void script(id, hooksOf.current!, messages);
      return { kind: "started" };
    },
    stop: () => {},
    updateSessionContext: () => {},
    settings: { get: (key) => (key in settings ? settings[key] : key === "activeModel" ? "stub-model" : "custom") },
    commands: {
      list: () => [],
      execute: async (input) => {
        ran.push(input);
        // `/compact` : les anciens échanges sont remplacés par un résumé.
        if (input.startsWith("/compact")) messages.set("s1", [msg("assistant", { kind: "summary", content: "résumé" })]);
        return { text: "fait" };
      },
    },
  };
  const hooksOf: { current?: AgentHooks } = {};
  const original = core.start;
  core.start = (id, text, hooks) => {
    hooksOf.current = hooks;
    return original(id, text, hooks);
  };

  return { core, messages, ran };
}

async function connect(gw: Gateway, port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${gw.token}`]);
  const events: { type: string; session_id?: string; payload?: any }[] = [];
  const waiting = new Map<number, (frame: any) => void>();
  let next = 0;
  ws.addEventListener("message", (m) => {
    const frame = JSON.parse(String(m.data));
    if (frame.method === "event") events.push(frame.params);
    else if (frame.id !== undefined) waiting.get(frame.id)?.(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connexion refusée")));
  });
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await waitFor(() => events.length > 0);

  return {
    events,
    waitFor,
    close: () => ws.close(),
    call: (method: string, params: Record<string, unknown> = {}): Promise<{ result?: any; error?: { code: number; message: string } }> =>
      new Promise((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }),
  };
}

const open: Gateway[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
});
async function start(core: GatewayCore) {
  const gw = createGateway({ core, version: "test" });
  open.push(gw);
  return { gw, port: await gw.listen(0) };
}

describe("la jauge de contexte sur le fil", () => {
  it("une conversation vide n'a pas de jauge ; une conversation reprise porte celle de sa dernière réponse, avec la fenêtre du réglage", async () => {
    const f = rig(async () => {}, { contextWindow: 16384 });
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    const created = await c.call("session.create", {});
    expect(created.result.info.usage).toBeUndefined();

    f.messages.set("s1", [msg("user", { content: "salut" }), msg("assistant", { content: "bonjour", inputTokens: 4000, outputTokens: 96 })]);
    const resumed = await c.call("session.resume", { session_id: "s1" });
    expect(resumed.result.info.usage).toMatchObject({ context_used: 4096, context_max: 16384, context_percent: 25, model: "stub-model" });
    c.close();
  });

  it("la fin d'un tour apporte l'occupation du contexte (message.complete)", async () => {
    const f = rig(
      async (id, hooks, messages) => {
        const answer = msg("assistant", { content: "voilà", inputTokens: 12000, outputTokens: 400 });
        messages.set(id, [msg("user", { content: "q" }), answer]);
        hooks.emit({ type: "stream-start", sessionId: id, streamId: "a" });
        hooks.emit({ type: "delta", sessionId: id, streamId: "a", text: "voilà" });
        hooks.emit({ type: "message", sessionId: id, message: answer });
        hooks.emit({ type: "done", sessionId: id });
      },
      { contextWindow: 16384 },
    );
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    await c.call("session.create", {});
    await c.call("prompt.submit", { session_id: "s1", text: "q" });
    await c.waitFor(() => c.events.some((e) => e.type === "message.complete"));
    const done = c.events.find((e) => e.type === "message.complete");
    expect(done?.payload.usage).toMatchObject({ context_used: 12400, context_max: 16384, context_percent: 75.7 });
    c.close();
  });

  it("une conversation qui porte son propre modèle utilise la fenêtre de CE modèle (LM Studio : le contexte demandé)", async () => {
    const f = rig(async () => {}, { localModels: { lmstudioContext: { "qwen-9b": 32768 } }, activeProvider: "anthropic", activeModel: "claude" });
    const { gw, port } = await start(f.core);
    const own = f.core.sessions.create();
    own.context = { workspace: null, provider: "lmstudio", model: "qwen-9b", agentMode: "build" };
    f.messages.set(own.id, [msg("assistant", { inputTokens: 8000, outputTokens: 192 })]);
    const c = await connect(gw, port);
    const resumed = await c.call("session.resume", { session_id: own.id });
    expect(resumed.result.info.usage).toMatchObject({ context_max: 32768, context_percent: 25, model: "qwen-9b" });
    c.close();
  });

  it("/compact et /model poussent un événement session.usage, les autres commandes non", async () => {
    const f = rig(async () => {}, { contextWindow: 16384 });
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    await c.call("session.create", {});
    f.messages.set("s1", [msg("user", { content: "a".repeat(40000) }), msg("assistant", { content: "ok", inputTokens: 15000, outputTokens: 600 })]);

    await c.call("slash.exec", { session_id: "s1", command: "/help" });
    expect(c.events.some((e) => e.type === "session.usage")).toBe(false);

    await c.call("slash.exec", { session_id: "s1", command: "/compact" });
    await c.waitFor(() => c.events.some((e) => e.type === "session.usage"));
    const pushed = c.events.find((e) => e.type === "session.usage");
    expect(pushed).toMatchObject({ session_id: "s1", payload: { usage: { context_estimated: true, compressions: 1, context_max: 16384 } } });
    expect(pushed?.payload.usage.context_used).toBeLessThan(100);
    c.close();
  });
});
