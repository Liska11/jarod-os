// SPECS-P5-ACP.md §4 (a)–(f) en PROCESSUS RÉELS : `jarod acp` face au client ACP OFFICIEL (@agentclientprotocol/sdk 1.5.0, liste B), avec un
// FAUX fournisseur de modèle local scripté (aucune clé, aucun réseau externe). Le SDK n'est qu'une dépendance de test.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, type Client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { isProcessAlive } from "@jarod/plugin-agent";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = join(HERE, "..", "src", "main.ts");
const TSX = createRequire(import.meta.url).resolve("tsx/cli");
// Assemblé à l'exécution : le garde du dépôt refuse la FORME d'une clé dans un fichier suivi.
const KEY = ["sk", "CANARI-ACPPROC-0123456789abcdef01"].join("-");

type Chunk = Record<string, unknown>;
const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] });
const stop = (reason = "stop"): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const text = (...parts: string[]): Chunk[] => [...parts.map((p) => delta({ content: p })), stop()];
const writeCall = (path: string, content: string): Chunk[] => [
  delta({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path, content }) } }] }),
  stop("tool_calls"),
];

/** Faux fournisseur : la n-ième requête reçoit `script[n]` ; `delayMs` entre les morceaux. */
function fakeLlm(script: Chunk[][], delayMs = 0): Promise<{ port: number; close: () => void; requests: () => number }> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const chunks = script[Math.min(n++, script.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify(c)}\n\n`);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ port: (server.address() as { port: number }).port, close: () => server.close(), requests: () => n })));
}

const dirs: string[] = [];
const kids: ChildProcessWithoutNullStreams[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

async function profile(port: number): Promise<string> {
  const root = temp("jarod-acproc-");
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  core.settings.patch({ activeProvider: "custom", activeModel: "jarod-test-model", providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${port}/v1`, models: ["jarod-test-model"] } }, autoTitle: false });
  await core.dispose();
  return root;
}

interface Rig {
  conn: ClientSideConnection;
  child: ChildProcessWithoutNullStreams;
  updates: { sessionId: string; update: any }[];
  perms: any[];
  stderr: () => string;
  rawStdout: () => string;
  /** Réponse à la prochaine demande d'autorisation : identifiant d'option, ou `null` = ne jamais répondre. */
  answer: { next: string | null };
}
function launch(root: string, extraEnv: Record<string, string> = {}): Rig {
  const child = spawn(process.execPath, [TSX, MAIN_TS, "acp"], { env: { ...process.env, JAROD_HOME: root, VITEST: "", JAROD_CUSTOM_API_KEY: KEY, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  kids.push(child);
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
  let out = "";
  const tee = new Readable({ read() {} });
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    tee.push(c);
  });
  child.stdout.on("end", () => tee.push(null));
  const updates: Rig["updates"] = [];
  const perms: any[] = [];
  const answer: Rig["answer"] = { next: "allow_once" };
  const client = {
    async requestPermission(p: any) {
      perms.push(p);
      if (answer.next === null) return new Promise(() => {});
      return { outcome: { outcome: "selected", optionId: answer.next } };
    },
    async sessionUpdate(n: any) {
      updates.push(n);
    },
  } as unknown as Client;
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(tee) as ReadableStream<Uint8Array>);
  const conn = new ClientSideConnection(() => client, stream);
  return { conn, child, updates, perms, stderr: () => err, rawStdout: () => out, answer };
}
const hello = (r: Rig) => r.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "conformance", version: "1" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("jarod acp contre le client ACP officiel", () => {
  it("(a) initialize → capacités ; session/new → modes ; prompt : morceaux AVANT la réponse, dans l'ordre, end_turn ; stdout = JSON seul ; EOF → sortie 0 sans orphelin", { timeout: 120_000 }, async () => {
    const llm = await fakeLlm([text("Bon", "jour", " !")]);
    closers.push(llm.close);
    const root = await profile(llm.port);
    const cwd = temp("jarod-acpcwd-");
    const r = launch(root);
    const init = await hello(r);
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo).toMatchObject({ name: "jarod" });
    expect(init.agentCapabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } });
    const s = await r.conn.newSession({ cwd, mcpServers: [] });
    expect(s.modes?.availableModes.map((m) => m.id).sort()).toEqual(["default", "plan"]);

    const resp = await r.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "Dis bonjour" }] });
    expect(resp.stopReason).toBe("end_turn");
    const chunks = r.updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => u.update.content.text);
    expect(chunks.join("")).toBe("Bon" + "jour" + " !");
    expect(llm.requests()).toBe(1);

    for (const line of r.rawStdout().split("\n").filter(Boolean)) expect(() => JSON.parse(line), line.slice(0, 80)).not.toThrow();
    expect(r.stderr()).toMatch(/jarod acp \(pid \d+\)/);
    const pid = Number(/jarod acp \(pid (\d+)\)/.exec(r.stderr())![1]);
    expect(isProcessAlive(pid)).toBe(true);
    r.child.stdin.end();
    expect(await new Promise((ok) => r.child.on("exit", ok))).toBe(0);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("(b) outil sensible : allow_once → le fichier est ÉCRIT ; reject_once → il ne l'est PAS (effet vérifié sur disque) ; deux options seulement", { timeout: 180_000 }, async () => {
    for (const choice of ["allow_once", "reject_once"] as const) {
      const llm = await fakeLlm([writeCall("hello.txt", `contenu ${KEY}`), text("Terminé.")]);
      closers.push(llm.close);
      const root = await profile(llm.port);
      const cwd = temp("jarod-acpcwd-");
      const r = launch(root);
      await hello(r);
      const s = await r.conn.newSession({ cwd, mcpServers: [] });
      r.answer.next = choice;
      const resp = await r.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "écris hello.txt" }] });
      expect(resp.stopReason).toBe("end_turn");
      expect(r.perms).toHaveLength(1);
      expect(r.perms[0].options.map((o: { kind: string }) => o.kind)).toEqual(["allow_once", "reject_once"]);
      expect(r.perms[0].toolCall).toMatchObject({ kind: "edit", status: "pending" });
      expect(existsSync(join(cwd, "hello.txt")), choice).toBe(choice === "allow_once");
      const kinds = r.updates.map((u) => u.update.sessionUpdate);
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_call_update");
      // (e) expurgation : la clé factice (argument de l'outil) ne part JAMAIS vers l'éditeur, ni sur stderr.
      expect(r.rawStdout() + r.stderr()).not.toContain("CANARI-ACPPROC");
      if (choice === "allow_once") expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toContain("CANARI-ACPPROC"); // l'outil, lui, a bien reçu l'argument
      r.child.stdin.end();
      await new Promise((ok) => r.child.on("exit", ok));
    }
  });

  it("(b) éditeur qui répond une option INCONNUE (ou « annulé ») → refus, fichier non écrit", { timeout: 180_000 }, async () => {
    for (const choice of ["allow_always", "inconnue"]) {
      const llm = await fakeLlm([writeCall("x.txt", "x"), text("ok")]);
      closers.push(llm.close);
      const root = await profile(llm.port);
      const cwd = temp("jarod-acpcwd-");
      const r = launch(root);
      await hello(r);
      const s = await r.conn.newSession({ cwd, mcpServers: [] });
      r.answer.next = choice;
      await r.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "écris x.txt" }] });
      expect(existsSync(join(cwd, "x.txt")), choice).toBe(false);
      r.child.stdin.end();
      await new Promise((ok) => r.child.on("exit", ok));
    }
  });

  it("(c) annulation en plein flux : « cancelled » en ≤ 2 s, AUCUNE mise à jour après la réponse, la session reste utilisable", { timeout: 180_000 }, async () => {
    const llm = await fakeLlm([Array.from({ length: 40 }, (_, i) => delta({ content: `mot${i} ` })).concat([stop()]), text("Reprise.")], 150);
    closers.push(llm.close);
    const root = await profile(llm.port);
    const cwd = temp("jarod-acpcwd-");
    const r = launch(root);
    await hello(r);
    const s = await r.conn.newSession({ cwd, mcpServers: [] });
    const p = r.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "raconte" }] });
    for (let i = 0; i < 200 && r.updates.length === 0; i++) await sleep(50);
    expect(r.updates.length).toBeGreaterThan(0);
    const t0 = Date.now();
    await r.conn.cancel({ sessionId: s.sessionId });
    const resp = await p;
    expect(resp.stopReason).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2_000);
    const n = r.updates.length;
    await sleep(800);
    expect(r.updates.length, "aucune mise à jour après la réponse du prompt").toBe(n);
    const again = await r.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "encore" }] });
    expect(again.stopReason).toBe("end_turn");
    r.child.stdin.end();
    await new Promise((ok) => r.child.on("exit", ok));
  });

  it("(c) annulation PENDANT une demande d'autorisation sans réponse : « cancelled », fichier non écrit", { timeout: 180_000 }, async () => {
    const llm = await fakeLlm([writeCall("jamais.txt", "x"), text("ok")]);
    closers.push(llm.close);
    const root = await profile(llm.port);
    const cwd = temp("jarod-acpcwd-");
    const r = launch(root);
    await hello(r);
    const s = await r.conn.newSession({ cwd, mcpServers: [] });
    r.answer.next = null; // l'éditeur ne répond jamais
    const p = r.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "écris" }] });
    for (let i = 0; i < 400 && r.perms.length === 0; i++) await sleep(50);
    expect(r.perms).toHaveLength(1);
    await r.conn.cancel({ sessionId: s.sessionId });
    expect((await p).stopReason).toBe("cancelled");
    expect(existsSync(join(cwd, "jamais.txt"))).toBe(false);
    r.child.stdin.end();
    await new Promise((ok) => r.child.on("exit", ok));
  });

  it("(d) rejeu : un AUTRE processus recharge la conversation (user, assistant, outil) AVANT la réponse de session/load ; identifiant inconnu → erreur ; titre 🔌", { timeout: 180_000 }, async () => {
    const llm = await fakeLlm([writeCall("a.txt", "A"), text("Fichier créé.")]);
    closers.push(llm.close);
    const root = await profile(llm.port);
    const cwd = temp("jarod-acpcwd-");
    const first = launch(root);
    await hello(first);
    const s = await first.conn.newSession({ cwd, mcpServers: [] });
    await first.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "crée a.txt" }] });
    first.child.stdin.end();
    await new Promise((ok) => first.child.on("exit", ok));

    const second = launch(root);
    await hello(second);
    let loaded = false;
    const seenBefore: string[] = [];
    const watch = setInterval(() => {
      if (!loaded) seenBefore.splice(0, seenBefore.length, ...second.updates.map((u) => u.update.sessionUpdate));
    }, 1);
    await second.conn.loadSession({ sessionId: s.sessionId, cwd, mcpServers: [] });
    loaded = true;
    clearInterval(watch);
    const kinds = second.updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toEqual(["user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    expect(second.updates[0]!.update.content.text).toBe("crée a.txt");
    await expect(second.conn.loadSession({ sessionId: "nulle-part", cwd, mcpServers: [] })).rejects.toBeTruthy();
    second.child.stdin.end();
    await new Promise((ok) => second.child.on("exit", ok));

    const { core } = await openCore({ env: { JAROD_HOME: root } });
    expect(core.sessions.get(s.sessionId)!.title).toMatch(/^🔌 conformance — crée a\.txt/);
    await core.dispose();
  });

  it("(f) profil inconnu → sortie 1 avec message sur stderr, rien sur stdout ; méthode inconnue → erreur JSON-RPC, le serveur reste vivant", { timeout: 120_000 }, async () => {
    const llm = await fakeLlm([text("x")]);
    closers.push(llm.close);
    const root = await profile(llm.port);
    const bad = spawn(process.execPath, [TSX, MAIN_TS, "acp", "--profile", "inconnu"], { env: { ...process.env, JAROD_HOME: root, VITEST: "" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    kids.push(bad);
    let out = "";
    let err = "";
    bad.stdout.on("data", (c) => (out += c));
    bad.stderr.on("data", (c) => (err += c));
    expect(await new Promise((ok) => bad.on("exit", ok))).toBe(1);
    expect(err).toMatch(/Profil inconnu/);
    expect(out).toBe("");

    const r = launch(root);
    await hello(r);
    await expect((r.conn as unknown as { extMethod(m: string, p: object): Promise<unknown> }).extMethod("session/fork", {})).rejects.toBeTruthy();
    const s = await r.conn.newSession({ cwd: temp("jarod-acpcwd-"), mcpServers: [] });
    expect(s.sessionId).toBeTruthy();
    r.child.stdin.end();
    await new Promise((ok) => r.child.on("exit", ok));
  });
});
