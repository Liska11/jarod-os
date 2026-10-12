// Passerelle compatible Hermes (essai) : de bout en bout avec un VRAI client WebSocket (celui de Node) et un faux noyau.
import type { Message, Session, SessionContext } from "@jarod/contracts";
import type { AgentHooks } from "@jarod/plugin-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, type Gateway, type GatewayCore } from "../src/gateway/server.js";
import { WS_PROTOCOL, WS_TOKEN_PREFIX } from "../src/gateway/ws.js";

function fakeCore(script: (sessionId: string, text: string, hooks: AgentHooks) => Promise<void>) {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, Message[]>();
  const contexts: { id: string | null; patch: Partial<SessionContext> }[] = [];
  const stopped: string[] = [];
  let seq = 0;
  const busy = new Set<string>();
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
    start: (id, text, hooks) => {
      if (busy.has(id)) return { kind: "busy" };
      busy.add(id);
      void script(id, text ?? "", hooks).finally(() => busy.delete(id));
      return { kind: "started" };
    },
    stop: (id) => void stopped.push(id),
    updateSessionContext: (id, patch) => void contexts.push({ id, patch }),
    settings: { get: (key) => (key === "activeModel" ? "stub-model" : "custom") },
  };
  return { core, stopped, contexts, messages };
}

interface Client {
  call(method: string, params?: Record<string, unknown>): Promise<{ result?: any; error?: { code: number; message: string } }>;
  events: { type: string; session_id?: string; payload?: any }[];
  requests: { id: string; method: string; params: any }[];
  /** Sous-protocole négocié (vide si le serveur n'en a choisi aucun). */
  protocol: string;
  reply(id: string, result: unknown): void;
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
  close(): void;
}

async function connect(gw: Gateway, port: number, token = gw.token, via: "url" | "protocol" = "url"): Promise<Client> {
  // `protocol` = la fenêtre : jeton en sous-protocole, URL sans jeton. `url` = les clients Hermes existants.
  const ws =
    via === "protocol"
      ? new WebSocket(`ws://127.0.0.1:${port}/api/ws`, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${token}`])
      : new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
  const events: Client["events"] = [];
  const requests: Client["requests"] = [];
  const waiting = new Map<number, (frame: any) => void>();
  let nextId = 0;
  ws.addEventListener("message", (m) => {
    const frame = JSON.parse(String(m.data));
    if (frame.method === "event") events.push(frame.params);
    else if (typeof frame.method === "string") requests.push({ id: frame.id, method: frame.method, params: frame.params });
    else waiting.get(frame.id)?.(frame);
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
    requests,
    protocol: ws.protocol,
    waitFor,
    close: () => ws.close(),
    reply: (id, result) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, result })),
    call: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }),
  };
}

const open: Gateway[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) await g.close();
});
async function start(core: GatewayCore, extra: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const gw = createGateway({ core, version: "test", ...extra });
  open.push(gw);
  return { gw, port: await gw.listen(0) };
}

describe("« Run now » : attente bornée", () => {
  it("attend la fin d'une exécution courte, mais pas plus de triggerWaitMs pour une longue (qui continue seule)", async () => {
    let finish: () => void = () => {};
    let calls = 0;
    const sched = {
      list: () => [],
      get: (id: string) => ({ id, name: "J", prompt: "p", spec: { kind: "interval" as const, minutes: 5 }, enabled: true, lastRun: null, nextRun: null, lastStatus: null }),
      save: () => { throw new Error("non"); },
      delete: () => {},
      runNow: () => (++calls === 1 ? Promise.resolve() : new Promise<void>((resolve) => (finish = resolve))),
    };
    const { core } = fakeCore(async () => {});
    const gw = createGateway({ core: { ...core, scheduler: sched }, version: "test", triggerWaitMs: 150 });
    open.push(gw);
    const port = await gw.listen(0);
    const post = () => fetch(`http://127.0.0.1:${port}/api/cron/jobs/j1/trigger`, { method: "POST", headers: { "X-Hermes-Session-Token": gw.token } });
    expect((await post()).status).toBe(200); // courte : tout de suite
    const t0 = Date.now();
    const res = await post(); // longue : rendue après ~150 ms, sans attendre la fin
    const waited = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "triggered" });
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThan(2000);
    finish();
  });
});

describe("passerelle compatible Hermes", () => {
  it("répond à la sonde publique /api/status et exige le jeton ailleurs", async () => {
    const { gw, port } = await start(fakeCore(async () => {}).core);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(await status.json()).toMatchObject({ status: "ok", version: "test" });
    expect((await fetch(`http://127.0.0.1:${port}/api/config`)).status).toBe(401);
    const authed = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "X-Hermes-Session-Token": gw.token } });
    expect(authed.status).toBe(404);
    expect(gw.unhandled()).toEqual({ "GET /api/config": 1 });
  });

  it("refuse une connexion WebSocket sans le bon jeton, et annonce gateway.ready à la bonne", async () => {
    const { gw, port } = await start(fakeCore(async () => {}).core);
    await expect(connect(gw, port, "mauvais")).rejects.toThrow();
    const c = await connect(gw, port);
    expect(c.events[0]).toMatchObject({ type: "gateway.ready", payload: { change_events: false, heartbeat: false } });
    expect(typeof c.events[0]!.payload.replay_epoch).toBe("string");
    c.close();
  });

  it("authentifie le jeton par sous-protocole : il ne figure alors dans aucune URL, et le 101 en choisit un", async () => {
    const { gw, port } = await start(fakeCore(async () => {}).core);
    const c = await connect(gw, port, gw.token, "protocol");
    // Un client qui a offert un sous-protocole refuse la connexion si le serveur n'en choisit aucun :
    // la connexion ouverte ET ce nom prouvent que le 101 a bien écho `jarod-gw`.
    expect(c.protocol).toBe(WS_PROTOCOL);
    expect(c.events[0]).toMatchObject({ type: "gateway.ready" });
    c.close();
    await expect(connect(gw, port, "mauvais", "protocol")).rejects.toThrow();
  });

  it("crée, liste, reprend et supprime une session", async () => {
    const f = fakeCore(async () => {});
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    const created = await c.call("session.create", { title: "Essai", cwd: "D:\\travail" });
    expect(created.result).toMatchObject({ session_id: "s1", stored_session_id: "s1", message_count: 0, messages: [] });
    expect(created.result.info).toMatchObject({ title: "Essai", model: "stub-model", running: false });
    expect(f.contexts).toEqual([{ id: "s1", patch: { workspace: "D:\\travail" } }]);
    const listed = await c.call("session.list", {});
    expect(listed.result.sessions).toEqual([{ id: "s1", title: "Essai", preview: "", started_at: 1_700_000_000, message_count: 0, source: "desktop" }]);
    expect((await c.call("session.resume", { session_id: "s1" })).result).toMatchObject({ session_id: "s1", running: false, inflight: null });
    expect((await c.call("session.resume", { session_id: "inconnue" })).error).toMatchObject({ code: -32602 });
    expect((await c.call("session.delete", { session_id: "s1" })).result).toEqual({ deleted: "s1" });
    expect((await c.call("session.list", {})).result.sessions).toEqual([]);
    c.close();
  });

  it("fait passer un tour : prompt.submit rend la main, puis les événements arrivent dans l'ordre", async () => {
    const f = fakeCore(async (id, text, hooks) => {
      hooks.emit({ type: "stream-start", sessionId: id, streamId: "a" });
      for (const word of text.split(" ")) hooks.emit({ type: "delta", sessionId: id, streamId: "a", text: `${word} ` });
      hooks.emit({ type: "message", sessionId: id, message: { id: "m", sessionId: id, role: "assistant", content: `${text} `, createdAt: 1 } });
      hooks.emit({ type: "done", sessionId: id });
    });
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    await c.call("session.create", {});
    const submitted = await c.call("prompt.submit", { session_id: "s1", text: "bonjour le monde" });
    expect(submitted.result).toEqual({ status: "streaming" });
    await c.waitFor(() => c.events.some((e) => e.type === "message.complete"));
    expect(c.events.map((e) => e.type)).toEqual(["gateway.ready", "message.start", "message.delta", "message.delta", "message.delta", "message.complete"]);
    expect(c.events.at(-1)).toMatchObject({ session_id: "s1", payload: { text: "bonjour le monde ", status: "complete" } });
    expect((await c.call("prompt.submit", { session_id: "s1", text: "  " })).error).toMatchObject({ code: -32602 });
    c.close();
  });

  it("demande l'accord d'un outil au shell et ne le donne que sur « once »", async () => {
    const answers: boolean[] = [];
    const f = fakeCore(async (id, _text, hooks) => {
      answers.push(await hooks.approve(id, { id: "c1", name: "run_shell", args: { command: "dir" } }, "Exécute une commande"));
      answers.push(await hooks.approve(id, { id: "c2", name: "write_file", args: { path: "x" } }, "Écrit un fichier"));
      hooks.emit({ type: "done", sessionId: id });
    });
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    await c.call("session.create", {});
    await c.call("prompt.submit", { session_id: "s1", text: "fais-le" });
    await c.waitFor(() => c.requests.length === 1);
    expect(c.requests[0]).toMatchObject({ method: "approval", params: { session_id: "s1", tool_name: "run_shell", choices: ["once", "deny"], allow_permanent: false } });
    c.reply(c.requests[0]!.id, { choice: "once" });
    await c.waitFor(() => c.requests.length === 2);
    c.reply(c.requests[1]!.id, { choice: "deny" });
    await c.waitFor(() => c.events.some((e) => e.type === "message.complete"));
    expect(answers).toEqual([true, false]);
    c.close();
  });

  it("une fenêtre muette ne gèle pas le tour : l'accord est refusé à l'échéance, la fenêtre est prévenue, le tour finit", async () => {
    let answer: boolean | undefined;
    const f = fakeCore(async (id, _text, hooks) => {
      answer = await hooks.approve(id, { id: "c1", name: "run_shell", args: {} }, "x");
      hooks.emit({ type: "done", sessionId: id });
    });
    const { gw, port } = await start(f.core, { approvalTimeoutMs: 60 });
    const c = await connect(gw, port);
    await c.call("session.create", {});
    await c.call("prompt.submit", { session_id: "s1", text: "go" });
    await c.waitFor(() => c.requests.length === 1);
    // la fenêtre ne répond pas
    await c.waitFor(() => answer !== undefined && c.events.some((e) => e.type === "message.complete"));
    expect(answer).toBe(false);
    expect(c.events.find((e) => e.type === "status.update")).toMatchObject({ session_id: "s1", payload: { kind: "approval-timeout", text: expect.stringContaining("run_shell") } });
    // une réponse tardive ne réveille personne et ne casse rien
    c.reply(c.requests[0]!.id, { choice: "once" });
    expect((await c.call("session.list", {})).error).toBeUndefined();
    expect(answer).toBe(false);
    c.close();
  });

  it("une réponse donnée à temps l'emporte sur l'échéance (pas de message, pas de refus)", async () => {
    let answer: boolean | undefined;
    const f = fakeCore(async (id, _text, hooks) => {
      answer = await hooks.approve(id, { id: "c1", name: "run_shell", args: {} }, "x");
      hooks.emit({ type: "done", sessionId: id });
    });
    const { gw, port } = await start(f.core, { approvalTimeoutMs: 150 });
    const c = await connect(gw, port);
    await c.call("session.create", {});
    await c.call("prompt.submit", { session_id: "s1", text: "go" });
    await c.waitFor(() => c.requests.length === 1);
    c.reply(c.requests[0]!.id, { choice: "once" });
    await c.waitFor(() => c.events.some((e) => e.type === "message.complete"));
    await new Promise((r) => setTimeout(r, 250)); // l'échéance passe sans effet
    expect(answer).toBe(true);
    expect(c.events.some((e) => e.type === "status.update")).toBe(false);
    c.close();
  });

  it("un geste natif sans réponse (boîte laissée ouverte) rend null à l'échéance", async () => {
    const f = fakeCore(async () => {});
    const { gw, port } = await start(f.core, { shellTimeoutMs: 60 });
    const c = await connect(gw, port);
    const asked = gw.link.ask("pickFile", { title: "x" });
    await c.waitFor(() => c.requests.length === 1);
    expect(c.requests[0]).toMatchObject({ method: "jarod.shell", params: { kind: "pickFile" } });
    expect(await asked).toBeNull();
    c.close();
  });

  it("refuse l'outil si le shell se déconnecte avant de répondre", async () => {
    let answer: boolean | undefined;
    const f = fakeCore(async (id, _text, hooks) => {
      answer = await hooks.approve(id, { id: "c1", name: "run_shell", args: {} }, "x");
      hooks.emit({ type: "done", sessionId: id });
    });
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    await c.call("session.create", {});
    await c.call("prompt.submit", { session_id: "s1", text: "go" });
    await c.waitFor(() => c.requests.length === 1);
    c.close();
    await c.waitFor(() => answer !== undefined);
    expect(answer).toBe(false);
  });

  it("refuse un second tour dans la même session et sait interrompre", async () => {
    let release: () => void = () => {};
    const f = fakeCore(async (id, _t, hooks) => {
      await new Promise<void>((r) => (release = r));
      hooks.emit({ type: "done", sessionId: id });
    });
    const { gw, port } = await start(f.core);
    const c = await connect(gw, port);
    await c.call("session.create", {});
    await c.call("prompt.submit", { session_id: "s1", text: "long" });
    expect((await c.call("prompt.submit", { session_id: "s1", text: "encore" })).error).toMatchObject({ code: -32000 });
    expect((await c.call("session.interrupt", { session_id: "s1" })).result).toMatchObject({ status: "interrupted", interrupted: true });
    expect(f.stopped).toEqual(["s1"]);
    release();
    await c.waitFor(() => c.events.some((e) => e.type === "message.complete"));
    expect(c.events.at(-1)).toMatchObject({ payload: { status: "interrupted" } });
    expect((await c.call("session.interrupt", { session_id: "s1" })).result).toMatchObject({ status: "not_interrupted" });
    c.close();
  });

  it("slash.exec : une commande qui change la posture de sécurité est REFUSÉE sans la voie gardée ; une commande courante s'exécute", async () => {
    const base = fakeCore(async () => {}).core;
    const ran: string[] = [];
    const core = { ...base, commands: { list: () => [], execute: async (input: string) => (ran.push(input), { text: "fait" }) } };
    const { gw, port } = await start(core);
    const c = await connect(gw, port);
    for (const name of ["plugin", "hub", "build", "workspace", "rewind", "persona", "curator"]) {
      const r = await c.call("slash.exec", { command: `/${name} x` });
      expect(r.error, name).toMatchObject({ code: -32602, message: expect.stringContaining("posture de sécurité") });
    }
    expect((await c.call("slash.exec", { command: "/help" })).result).toEqual({ output: "fait" });
    expect((await c.call("slash.exec", { command: "pas une commande" })).error?.code).toBe(-32602);
    expect(ran).toEqual(["/help"]); // aucune commande gardée n'a été exécutée
    c.close();
  });

  it("répond -32601 à une méthode non servie et la consigne", async () => {
    const { gw, port } = await start(fakeCore(async () => {}).core);
    const c = await connect(gw, port);
    expect((await c.call("usage.bars", { key: "model" })).error).toMatchObject({ code: -32601 });
    expect((await c.call("usage.bars", {})).error).toMatchObject({ code: -32601 });
    expect(gw.unhandled()).toEqual({ "rpc usage.bars": 2 });
    c.close();
  });

  it("masque un secret dans un message d'erreur RPC, pour la fenêtre comme pour le journal", async () => {
    const lines: string[] = [];
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const { core } = fakeCore(async () => {});
    const gw = createGateway({
      core: { ...core, sessions: { ...core.sessions, create: () => { throw new Error(`le fournisseur a refusé la clé (api_key=${secret})`); } } },
      version: "test",
      log: (s: string) => void lines.push(s),
    });
    open.push(gw);
    const c = await connect(gw, await gw.listen(0));
    const refused = await c.call("session.create", { title: "Essai" });
    expect(refused.error).toMatchObject({ code: -32603 });
    expect(refused.error?.message).toContain("sk-[masqué]");
    expect(refused.error?.message).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    c.close();
  });

  it("ne journalise que le chemin d'une requête REST et masque les secrets des réponses d'erreur", async () => {
    const lines: string[] = [];
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const job = { id: "j1", name: "J", prompt: "p", spec: { kind: "interval" as const, minutes: 5 }, enabled: true, lastRun: null, nextRun: null, lastStatus: null };
    const sched = {
      list: (): never => { throw new Error(`le planificateur a échoué (api_key=${secret})`); },
      get: () => job,
      save: (): never => { throw new Error(`enregistrement refusé (secret=${secret})`); },
      delete: () => {},
      runNow: () => Promise.resolve(),
    };
    const { core } = fakeCore(async () => {});
    const gw = createGateway({ core: { ...core, scheduler: sched }, version: "test", log: (s: string) => void lines.push(s) });
    open.push(gw);
    const port = await gw.listen(0);
    const headers = { "X-Hermes-Session-Token": gw.token };

    const listed = await fetch(`http://127.0.0.1:${port}/api/cron/jobs?token=${secret}`, { headers });
    expect(listed.status).toBe(500);
    expect(lines.join("\n")).toContain("REST GET /api/cron/jobs");
    expect(lines.join("\n")).not.toContain(secret);

    const patched = await fetch(`http://127.0.0.1:${port}/api/cron/jobs/j1`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ updates: { name: "n" } }) });
    expect(patched.status).toBe(400);
    const { detail } = (await patched.json()) as { detail: string };
    expect(detail).toContain("[masqué]");
    expect(detail).not.toContain(secret);
  });
});
