// File de messages et pilotage en cours de tour, de bout en bout : un vrai client WebSocket, un faux noyau dont les tours sont pilotés à la main.
import type { Message, Session } from "@jarod/contracts";
import type { AgentHooks } from "@jarod/plugin-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, type Gateway, type GatewayCore } from "../src/gateway/server.js";
import { WS_PROTOCOL, WS_TOKEN_PREFIX } from "../src/gateway/ws.js";

/** Un tour lancé par le faux noyau : le test décide quand il finit, et comment. */
interface Run {
  text: string;
  hooks: AgentHooks;
  /** Termine le tour comme le noyau réel : la conversation est libérée AVANT l'annonce de `done`. */
  finish(options?: { error?: string }): void;
}

function fakeCore() {
  const sessions = new Map<string, Session>();
  const runs: Run[] = [];
  const stopped: string[] = [];
  const busy = new Set<string>();
  let seq = 0;
  const core: GatewayCore = {
    sessions: {
      create: (title = "Nouvelle conversation") => {
        const s: Session = { id: `s${++seq}`, title, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, pinned: false, messageCount: 0 };
        sessions.set(s.id, s);
        return s;
      },
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
      delete: (id) => void sessions.delete(id),
    },
    messages: { list: (): Message[] => [] },
    start: (id, text, hooks) => {
      if (busy.has(id)) return { kind: "busy" };
      busy.add(id);
      runs.push({
        text: text ?? "",
        hooks,
        finish: ({ error } = {}) => {
          if (error) hooks.emit({ type: "error", sessionId: id, error });
          busy.delete(id);
          hooks.emit({ type: "done", sessionId: id });
        },
      });
      return { kind: "started" };
    },
    stop: (id) => void stopped.push(id),
    updateSessionContext: () => {},
    settings: { get: (key) => (key === "activeModel" ? "stub-model" : "custom") },
  };
  return { core, runs, stopped };
}

interface Client {
  call(method: string, params?: Record<string, unknown>): Promise<{ result?: any; error?: { code: number; message: string } }>;
  events: { type: string; session_id?: string; payload?: any }[];
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
}

async function connect(gw: Gateway, port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${gw.token}`]);
  const events: Client["events"] = [];
  const waiting = new Map<number, (frame: any) => void>();
  let nextId = 0;
  ws.addEventListener("message", (m) => {
    const frame = JSON.parse(String(m.data));
    if (frame.method === "event") events.push(frame.params);
    else if (typeof frame.id === "number") waiting.get(frame.id)?.(frame);
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

async function setup() {
  const fake = fakeCore();
  const gw = createGateway({ core: fake.core, version: "test" });
  open.push(gw);
  const client = await connect(gw, await gw.listen(0));
  const session = (await client.call("session.create", {})).result.session_id as string;
  return { ...fake, client, session };
}

const lastQueue = (c: Client) => [...c.events].reverse().find((e) => e.type === "queue.update")?.payload.items.map((i: { text: string }) => i.text);

describe("prompt.queue", () => {
  it("sans tour en cours, c'est un envoi ordinaire", async () => {
    const { client, session, runs } = await setup();
    expect((await client.call("prompt.queue", { session_id: session, text: "bonjour" })).result).toEqual({ status: "streaming" });
    expect(runs.map((r) => r.text)).toEqual(["bonjour"]);
  });

  it("pendant un tour, met en file ; la file part toute seule, dans l'ordre, quand le tour finit", async () => {
    const { client, session, runs } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "premier" });
    const queued = await client.call("prompt.queue", { session_id: session, text: "deuxième" });
    expect(queued.result).toMatchObject({ status: "queued", position: 1 });
    expect((await client.call("prompt.queue", { session_id: session, text: "troisième" })).result).toMatchObject({ position: 2 });
    await client.waitFor(() => lastQueue(client)?.length === 2);
    expect(lastQueue(client)).toEqual(["deuxième", "troisième"]);
    expect(runs).toHaveLength(1);

    runs[0]!.finish();
    await client.waitFor(() => runs.length === 2);
    expect(runs[1]!.text).toBe("deuxième");
    expect(client.events.find((e) => e.type === "prompt.started")?.payload).toMatchObject({ text: "deuxième", from_queue: true });

    runs[1]!.finish();
    await client.waitFor(() => runs.length === 3);
    expect(runs[2]!.text).toBe("troisième");
    await client.waitFor(() => lastQueue(client)?.length === 0);
  });

  it("un tour interrompu met la file en pause ; prompt.queue.resume la relance", async () => {
    const { client, session, runs, stopped } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "long" });
    await client.call("prompt.queue", { session_id: session, text: "ensuite" });

    expect((await client.call("session.interrupt", { session_id: session })).result).toMatchObject({ interrupted: true });
    expect(stopped).toEqual([session]);
    runs[0]!.finish();
    await new Promise((r) => setTimeout(r, 80));
    expect(runs, "la file attend l'utilisateur").toHaveLength(1);
    expect((await client.call("prompt.queue.list", { session_id: session })).result.items.map((i: { text: string }) => i.text)).toEqual(["ensuite"]);

    expect((await client.call("prompt.queue.resume", { session_id: session })).result.status).toBe("streaming");
    expect(runs.map((r) => r.text)).toEqual(["long", "ensuite"]);
  });

  it("un tour en erreur met aussi la file en pause", async () => {
    const { client, session, runs } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "échoue" });
    await client.call("prompt.queue", { session_id: session, text: "après l'échec" });
    runs[0]!.finish({ error: "clé invalide" });
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toHaveLength(1);
    expect((await client.call("prompt.queue.list", { session_id: session })).result.items).toHaveLength(1);
  });

  it("retirer un message, ou vider la file, prévient la fenêtre", async () => {
    const { client, session } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "en cours" });
    const a = (await client.call("prompt.queue", { session_id: session, text: "a" })).result.id as string;
    await client.call("prompt.queue", { session_id: session, text: "b" });
    expect((await client.call("prompt.queue.remove", { session_id: session, id: a })).result).toEqual({ removed: true });
    await client.waitFor(() => lastQueue(client)?.join() === "b");
    expect((await client.call("prompt.queue.clear", { session_id: session })).result).toEqual({ cleared: 1 });
    await client.waitFor(() => lastQueue(client)?.length === 0);
  });

  it("refuse un message vide ou une conversation inconnue", async () => {
    const { client, session } = await setup();
    expect((await client.call("prompt.queue", { session_id: session, text: "  " })).error).toMatchObject({ code: -32602 });
    expect((await client.call("prompt.queue", { session_id: "nulle-part", text: "x" })).error).toMatchObject({ code: -32602 });
  });
});

describe("prompt.steer", () => {
  it("le message entre dans la boîte que l'agent lit entre deux étapes", async () => {
    const { client, session, runs } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "travaille" });
    expect((await client.call("prompt.steer", { session_id: session, text: "plutôt dans src" })).result).toEqual({ status: "steering", pending: 1 });

    const inbox = runs[0]!.hooks.steering!;
    expect(inbox.peek()).toBe(true);
    expect(inbox.take()).toEqual(["plutôt dans src"]);
    expect(inbox.peek()).toBe(false);
    runs[0]!.finish();
    await new Promise((r) => setTimeout(r, 80));
    expect(runs, "une consigne lue ne repart pas en file").toHaveLength(1);
  });

  it("sans tour en cours, refuse : il n'y a rien à piloter", async () => {
    const { client, session } = await setup();
    expect((await client.call("prompt.steer", { session_id: session, text: "x" })).error).toMatchObject({ code: -32000 });
  });

  it("une consigne que le tour n'a pas eu le temps de lire repart en tête de la file, pas perdue", async () => {
    const { client, session, runs } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "court" });
    await client.call("prompt.queue", { session_id: session, text: "dans la file" });
    await client.call("prompt.steer", { session_id: session, text: "trop tard" });
    runs[0]!.finish(); // l'agent n'a jamais lu la boîte

    await client.waitFor(() => runs.length === 2);
    expect(runs[1]!.text, "la consigne passe avant ce qui était déjà en file").toBe("trop tard");
    runs[1]!.finish();
    await client.waitFor(() => runs.length === 3);
    expect(runs[2]!.text).toBe("dans la file");
  });

  it("une consigne vide est refusée", async () => {
    const { client, session } = await setup();
    await client.call("prompt.submit", { session_id: session, text: "en cours" });
    expect((await client.call("prompt.steer", { session_id: session, text: " " })).error).toMatchObject({ code: -32602 });
  });
});
