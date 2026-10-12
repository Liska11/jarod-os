/**
 * GATE P1 (PLAN §6) — e2e « boots, sends prompt, streamed answer » sur le nouveau kernel.
 *
 * Portage de `e2e/smoke.spec.ts:61` (rév. 2e180305). La source pilotait le desktop Electron (porté en
 * Phase 3) ; ici la même chaîne sans fenêtre : processus réel `jarod ask` → kernel cordis (10 plugins)
 * → boucle d'agent → fournisseur OpenAI-compatible en streaming → deltas sur stdout → base.
 *
 * 1. Même fournisseur de test que la source : un vrai serveur HTTP local compatible OpenAI (le stub
 *    réseau de `smoke.spec.ts:21-58`), qui prouve que la requête est bien partie en `stream: true`.
 *    Il espace ses deltas de 120 ms pour que le streaming soit OBSERVABLE côté processus.
 * 2. Preuve supplémentaire sur le vrai modèle local (llama-server :8080), s'il répond.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterAll, describe, expect, it } from "vitest";

// T16 : les profils et dossiers de travail des processus lancés sont supprimés en fin de fichier.
afterAll(cleanup);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "packages", "cli", "bin", "jarod.mjs");
const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-p1] ${l}`);
};

interface Stub {
  port: number;
  close: () => void;
  /** Every completion payload the app sent, so the test can prove the request really left the app. */
  requests: { stream?: boolean; model?: string }[];
}

/** smoke.spec.ts:21-58, plus un délai entre deltas (observabilité du streaming côté processus). */
function startStubProvider(reply: string, gapMs = 120): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const payload = body ? (JSON.parse(body) as { stream?: boolean; model?: string }) : {};
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: payload.model ?? "jarod-test-model" }] }));
        return;
      }
      requests.push(payload);
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const char of reply) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, gapMs));
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done({ port: typeof address === "object" && address ? address.port : 0, close: () => server.close(), requests });
    });
  });
}

/** Un profil neuf (JAROD_HOME), préparé par le kernel lui-même : base chiffrée DPAPI, réglages du fournisseur. */
async function freshProfile(settings: Record<string, unknown>): Promise<string> {
  const home = tempDir();
  const dataDir = join(home, "profiles", "default");
  mkdirSync(dataDir, { recursive: true });
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir };
  plugins.scheduler = { autoStart: false };
  plugins.agent = { runtimeLock: false };
  const app = new JarodApp({ plugins });
  const started = await start(app);
  const s = (app as unknown as { storage: { settings: { patch(v: Record<string, unknown>): unknown } } }).storage.settings;
  s.patch(settings);
  await stop(started);
  return home;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Chaque morceau reçu sur stdout, avec son instant : la preuve du streaming. */
  chunks: { at: number; text: string }[];
  exitedAt: number;
}

function jarod(home: string, args: string[]): Promise<Run> {
  return new Promise((done) => {
    const cwd = tempDir();
    // Un vrai processus utilisateur : sans les variables du lanceur de tests (VITEST court-circuite `main()`).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")));
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...env, JAROD_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Run["chunks"] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push({ at: Date.now(), text: c.toString("utf8") }));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("exit", (code) =>
      done({ code, stdout: chunks.map((c) => c.text).join(""), stderr, chunks, exitedAt: Date.now() }),
    );
  });
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

describe("GATE P1 — boots, sends a prompt and shows the streamed answer", () => {
  it("fournisseur de test (smoke.spec.ts) : requête stream:true, réponse en plusieurs deltas, persistée", async () => {
    const stub = await startStubProvider("pong");
    try {
      const home = await freshProfile({
        activeProvider: "custom",
        activeModel: "jarod-test-model",
        providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${stub.port}/v1` } },
      });
      const t0 = Date.now();
      const r = await jarod(home, ["ask", "ping"]);
      log(`stub : exit=${r.code} en ${r.exitedAt - t0} ms, stdout=${JSON.stringify(r.stdout)}`);
      log(`stub : ${r.chunks.length} morceaux stdout ${JSON.stringify(r.chunks.map((c) => c.text))}`);
      if (r.stderr.trim()) log(`stub : stderr=${r.stderr.trim().slice(0, 300)}`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("pong");
      // La requête est bien partie de l'app, en streaming, vers le modèle choisi.
      expect(stub.requests.some((q) => q.stream === true && q.model === "jarod-test-model")).toBe(true);
      // Streamé : la réponse arrive en plusieurs morceaux, étalés dans le temps, avant la fin.
      const answerChunks = r.chunks.filter((c) => c.text.trim());
      expect(answerChunks.length).toBeGreaterThanOrEqual(2);
      expect(answerChunks.at(-1)!.at - answerChunks[0]!.at).toBeGreaterThanOrEqual(200);

      // Persisté : la conversation et la réponse sont dans la base du profil.
      const plugins: Record<string, Record<string, unknown>> = {};
      for (const p of discoverPlugins()) plugins[p.name] = {};
      plugins.storage = { dataDir: join(home, "profiles", "default") };
      plugins.scheduler = { autoStart: false };
      plugins.agent = { runtimeLock: false };
      const app = new JarodApp({ plugins });
      const started = await start(app);
      const core = (app as unknown as {
        agent: { sessions: { list(): { id: string }[] }; messages: { list(id: string): { role: string; content: string }[] } };
      }).agent;
      const [session] = core.sessions.list();
      const msgs = core.messages.list(session!.id).map((m) => [m.role, m.content]);
      await stop(started);
      log(`stub : base → ${JSON.stringify(msgs)}`);
      expect(msgs).toEqual([
        ["user", "ping"],
        ["assistant", "pong"],
      ]);
    } finally {
      stub.close();
    }
  });

  it("vrai modèle local (llama-server :8080) : réponse streamée en plusieurs deltas", async () => {
    const up = await reachable("http://127.0.0.1:8080/v1/models");
    log(`llama-server :8080 ${up ? "joignable" : "NON joignable"}`);
    if (!up) return; // preuve supplémentaire seulement : le critère de gate est le test précédent
    const models = (await (await fetch("http://127.0.0.1:8080/v1/models")).json()) as { data: { id: string }[] };
    const model = models.data[0]!.id;
    const home = await freshProfile({ activeProvider: "llamacpp", activeModel: model });
    const t0 = Date.now();
    const r = await jarod(home, ["ask", "Réponds en une courte phrase : quelle est la capitale de la France ?"]);
    const answer = r.chunks.filter((c) => c.text.trim());
    log(`llama-server (${model}) : exit=${r.code} en ${r.exitedAt - t0} ms, ${answer.length} morceaux, réponse=${JSON.stringify(r.stdout.trim().slice(0, 200))}`);
    if (r.stderr.trim()) log(`llama-server : stderr=${r.stderr.trim().slice(0, 300)}`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    expect(answer.length).toBeGreaterThanOrEqual(2);
    writeFileSync(join(ROOT, ".work", `gate-p1-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
  });
});
