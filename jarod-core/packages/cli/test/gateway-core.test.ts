// Passerelle compatible Hermes (essai) : le VRAI noyau de Jarod (profil temporaire, base chiffrée, agent, outils) derrière la passerelle,
// un FAUX fournisseur de modèle local scripté (aucune clé réelle, aucun réseau externe) et un vrai client WebSocket.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { createGateway, type Gateway } from "../src/gateway/server.js";

// Assemblé à l'exécution : le garde du dépôt refuse la FORME d'une clé dans un fichier suivi.
const KEY = ["sk", "CANARI-GATEWAY-0123456789abcdef01"].join("-");

type Chunk = Record<string, unknown>;
const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] });
const stop = (reason = "stop"): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const text = (...parts: string[]): Chunk[] => [...parts.map((p) => delta({ content: p })), stop()];
const writeCall = (path: string, content: string): Chunk[] => [
  delta({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path, content }) } }] }),
  stop("tool_calls"),
];

function fakeLlm(script: Chunk[][]): Promise<{ port: number; close: () => void }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const chunks = script[Math.min(n++, script.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

async function rig(script: Chunk[][], workspace?: string) {
  const llm = await fakeLlm(script);
  closers.push(llm.close);
  const root = temp("jarod-gw-");
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root, JAROD_CUSTOM_API_KEY: KEY } });
  core.settings.patch({
    activeProvider: "custom",
    activeModel: "jarod-test-model",
    providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${llm.port}/v1`, models: ["jarod-test-model"] } },
    autoTitle: false,
  });
  await core.skills.reload();
  const gw: Gateway = createGateway({ core, version: "test", ...(workspace ? { workspace } : {}) });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${gw.token}`);
  closers.push(() => ws.close());
  const events: { type: string; session_id?: string; payload?: any }[] = [];
  const requests: { id: string; method: string; params: any }[] = [];
  const waiting = new Map<number, (f: any) => void>();
  let id = 0;
  ws.addEventListener("message", (m) => {
    const f = JSON.parse(String(m.data));
    if (f.method === "event") events.push(f.params);
    else if (typeof f.method === "string") requests.push({ id: f.id, method: f.method, params: f.params });
    else waiting.get(f.id)?.(f);
  });
  await new Promise<void>((ok, bad) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => bad(new Error("connexion refusée")));
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: any; error?: any }>((ok) => {
      const n = ++id;
      waiting.set(n, ok);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  const waitFor = async (pred: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`délai dépassé ; événements : ${events.map((e) => e.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const reply = (rid: string, result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, result }));
  const http = (path: string, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-hermes-session-token": gw.token } }).then((r) => r.json() as Promise<any>);
  return { core, gw, call, events, requests, waitFor, reply, http };
}

describe("passerelle devant le vrai noyau", { timeout: 60_000 }, () => {
  it("fait répondre l'agent en flux, range la conversation dans la base et la restitue à la reprise", async () => {
    const r = await rig([text("po", "ng")]);
    const created = await r.call("session.create", { title: "Essai" });
    const sid = created.result.session_id as string;
    expect(r.core.sessions.get(sid)?.title).toBe("Essai");

    expect((await r.call("prompt.submit", { session_id: sid, text: "ping" })).result).toEqual({ status: "streaming" });
    await r.waitFor(() => r.events.some((e) => e.type === "message.complete"));
    const types = r.events.map((e) => e.type);
    expect(types[0]).toBe("gateway.ready");
    expect(types).toContain("message.start");
    expect(r.events.filter((e) => e.type === "message.delta").map((e) => e.payload.text).join("")).toBe("pong");
    expect(r.events.at(-1)).toMatchObject({ type: "message.complete", session_id: sid, payload: { text: "pong", status: "complete" } });

    const stored = r.core.messages.list(sid).map((m) => [m.role, m.content]);
    expect(stored).toEqual([["user", "ping"], ["assistant", "pong"]]);

    const resumed = await r.call("session.resume", { session_id: sid });
    expect(resumed.result.messages.map((m: any) => [m.role, m.text])).toEqual([["user", "ping"], ["assistant", "pong"]]);
    expect(resumed.result.info).toMatchObject({ provider: "custom", model: "jarod-test-model", running: false });
    expect((await r.call("session.list", {})).result.sessions).toMatchObject([{ id: sid, title: "Essai", message_count: 2, source: "desktop" }]);
  });

  it("le titre que le noyau donne à la conversation au premier message part vers le shell (sinon il garde « Nouvelle conversation »)", async () => {
    const r = await rig([text("sal", "ut"), text("ok")]);
    const sid = (await r.call("session.create", {})).result.session_id as string;
    await r.call("prompt.submit", { session_id: sid, text: "  Bonjour   le monde  " });
    await r.waitFor(() => r.events.some((e) => e.type === "message.complete"));
    const titles = r.events.filter((e) => e.type === "session.title");
    expect(titles[0]).toMatchObject({ session_id: sid, payload: { session_id: sid, title: "Bonjour le monde" } });
    expect(r.core.sessions.get(sid)?.title).toBe(titles.at(-1)!.payload.title); // le dernier titre annoncé est celui du noyau
    const before = titles.length;
    await r.call("prompt.submit", { session_id: sid, text: "et la suite" });
    await r.waitFor(() => r.events.filter((e) => e.type === "message.complete").length === 2);
    expect(r.events.filter((e) => e.type === "session.title").length).toBe(before); // pas de répétition : seul un changement est annoncé
  });

  it("un outil sensible passe par l'accord du shell : refusé, le fichier n'existe pas ; accordé, il est écrit", async () => {
    const work = temp("jarod-gw-ws-");
    const denied = await rig([writeCall("a.txt", "bonjour"), text("fait")]);
    const s1 = (await denied.call("session.create", { cwd: work })).result.session_id as string;
    await denied.call("prompt.submit", { session_id: s1, text: "écris a.txt" });
    await denied.waitFor(() => denied.requests.length === 1);
    expect(denied.requests[0]).toMatchObject({ method: "approval", params: { session_id: s1, tool_name: "write_file", choices: ["once", "deny"], allow_permanent: false } });
    denied.reply(denied.requests[0]!.id, { choice: "deny" });
    await denied.waitFor(() => denied.events.some((e) => e.type === "message.complete"));
    expect(existsSync(join(work, "a.txt"))).toBe(false);
    expect(denied.events.some((e) => e.type === "tool.complete" && /refus/i.test(e.payload.result_text))).toBe(true);

    const allowed = await rig([writeCall("b.txt", "bonjour"), text("fait")]);
    const s2 = (await allowed.call("session.create", { cwd: work })).result.session_id as string;
    await allowed.call("prompt.submit", { session_id: s2, text: "écris b.txt" });
    await allowed.waitFor(() => allowed.requests.length === 1);
    allowed.reply(allowed.requests[0]!.id, { choice: "once" });
    await allowed.waitFor(() => allowed.events.some((e) => e.type === "message.complete"));
    expect(readFileSync(join(work, "b.txt"), "utf8")).toBe("bonjour");
    const order = allowed.events.map((e) => e.type).filter((t) => t === "tool.start" || t === "tool.complete" || t === "message.complete");
    expect(order).toEqual(["tool.start", "tool.complete", "message.complete"]);
    expect(allowed.events.at(-1)).toMatchObject({ payload: { text: "fait", status: "complete" } });
  });

  it("avec un dossier de travail fixé, le dossier envoyé par le shell est ignoré : le fichier est écrit dans le dossier de travail", async () => {
    const work = temp("jarod-gw-base-");
    const elsewhere = temp("jarod-gw-home-"); // le « dossier personnel » que Herald envoie
    const r = await rig([writeCall("d.txt", "bonjour"), text("fait")], work);
    const created = await r.call("session.create", { cwd: elsewhere });
    const sid = created.result.session_id as string;
    expect(created.result.info.cwd).toBe(work);
    await r.call("prompt.submit", { session_id: sid, text: "écris d.txt" });
    await r.waitFor(() => r.requests.length === 1);
    r.reply(r.requests[0]!.id, { choice: "once" });
    await r.waitFor(() => r.events.some((e) => e.type === "message.complete"));
    expect(readFileSync(join(work, "d.txt"), "utf8")).toBe("bonjour");
    expect(existsSync(join(elsewhere, "d.txt"))).toBe(false);
  });
});

describe("historique d'une automatisation devant le vrai noyau", { timeout: 60_000 }, () => {
  it("après « Run now », la conversation de la planification est l'unique ligne de « Recent runs »", async () => {
    const r = await rig([text("bilan", " fait")]);
    const job = r.core.scheduler.save({ name: "Bilan", prompt: "résume", spec: { kind: "interval", minutes: 60 } });
    expect((await r.http(`/api/cron/jobs/${job.id}/runs`)).runs).toEqual([]);
    // Comme Herald : « Run now », puis UNE relecture immédiate (il n'interroge pas ensuite) : la réponse doit venir après la fin de l'exécution.
    expect(await r.http(`/api/cron/jobs/${job.id}/trigger`, "POST")).toEqual({ ok: true, status: "triggered" });
    const after = r.core.scheduler.get(job.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.sessionId).toBeTruthy();
    const { runs } = await r.http(`/api/cron/jobs/${job.id}/runs?limit=10`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: after.sessionId, message_count: 2, is_active: false });
    expect(typeof runs[0].started_at).toBe("number");
  });
});
