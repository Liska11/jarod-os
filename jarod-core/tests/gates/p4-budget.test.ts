/**
 * GATE P4 — budget (PLAN §6 « new : budget » ; G4, décision utilisateur 2026-09-28), sur de VRAIS processus.
 *
 * Chaîne : processus `jarod ask -c` successifs → kernel cordis → boucle d'agent → fournisseur
 * OpenAI-compatible en streaming (serveur HTTP local qui renvoie un `usage` réel : 300 + 200 tokens par
 * réponse) → messages et tokens en base chiffrée → plafond relu depuis la base au tour suivant.
 *
 * Plafond global 1 200 tokens :
 *   tour 1 → 500 (42 %), rien ; tour 2 → 1 000 (83 %) : alerte « 80 % » une fois ;
 *   tour 3 → vérifié AVANT l'appel (1 000 < 1 200) donc servi, et dépasse (1 500) — un appel en cours ne
 *   peut pas être coupé, sa sortie n'est pas connue d'avance ; tour 4 → REFUSÉ avant l'appel : code 1,
 *   message « Plafond … atteint », le fournisseur n'est PAS appelé ;
 *   `/budget 5000` (le plafond relevé pour CETTE conversation, par le kernel ouvert sur le même profil —
 *   `jarod ask` n'exécute pas les commandes `/`, c'est le chemin du desktop) → tour 5 servi ;
 *   une AUTRE conversation reste sous le plafond global.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "packages", "cli", "bin", "jarod.mjs");
const IN = 300;
const OUT = 200;
const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-p4-budget] ${l}`);
};

afterAll(async () => {
  await cleanup(); // T16 : profil et dossiers de travail supprimés
  mkdirSync(join(ROOT, ".work"), { recursive: true });
  writeFileSync(join(ROOT, ".work", `gate-p4-budget-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
});

/** Fournisseur de test (motif de la gate P1) qui compte ses appels et renvoie un `usage` (include_usage). */
function startStub(reply: string): Promise<{ port: number; close: () => void; completions: () => number }> {
  let completions = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const payload = body ? (JSON.parse(body) as { model?: string }) : {};
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: payload.model ?? "jarod-test-model" }] }));
        return;
      }
      completions++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: IN, completion_tokens: OUT } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      done({ port: typeof a === "object" && a ? a.port : 0, close: () => server.close(), completions: () => completions });
    });
  });
}

function pluginsFor(dataDir: string): Record<string, Record<string, unknown>> {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir };
  plugins.scheduler = { autoStart: false };
  plugins.agent = { runtimeLock: false };
  return plugins;
}

interface Core {
  storage: { settings: { patch(v: Record<string, unknown>): unknown } };
  agent: {
    commands: { execute(line: string, ctx: { sessionId: string }): Promise<{ text?: string } | undefined> };
    sessionUsage(id: string): { inputTokens: number; outputTokens: number };
  };
}

/** Le kernel ouvert sur le profil, le temps d'une action (comme le desktop), puis refermé. */
async function withKernel<T>(dataDir: string, f: (k: Core) => Promise<T> | T): Promise<T> {
  const app = new JarodApp({ plugins: pluginsFor(dataDir) });
  const started = await start(app);
  try {
    return await f(app as unknown as Core);
  } finally {
    await stop(started);
  }
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function jarod(home: string, args: string[]): Promise<Run> {
  return new Promise((done) => {
    const cwd = tempDir();
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")));
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...env, JAROD_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
}

describe("GATE P4 — budget : plafond par conversation, en processus réels", () => {
  it("alerte à 80 %, arrêt avant l'appel au plafond, relance par /budget, autre conversation intacte", { timeout: 180_000 }, async () => {
    const stub = await startStub("pong");
    try {
      const home = tempDir();
      const dataDir = join(home, "profiles", "default");
      mkdirSync(dataDir, { recursive: true });
      await withKernel(dataDir, (k) => {
        k.storage.settings.patch({
          activeProvider: "custom",
          activeModel: "jarod-test-model",
          providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${stub.port}/v1` } },
          sessionBudget: { maxTokens: 1200, maxCostUsd: 0, perSession: {} },
        });
      });

      const turn = async (n: number, args: string[]) => {
        const before = stub.completions();
        const r = await jarod(home, ["ask", ...args]);
        const calls = stub.completions() - before;
        log(`tour ${n} : exit=${r.code} appels fournisseur=${calls} stdout=${JSON.stringify(r.stdout.trim())} stderr=${JSON.stringify(r.stderr.trim().slice(0, 300))}`);
        return { ...r, calls };
      };

      const t1 = await turn(1, ["tour un"]);
      expect(t1.code, t1.stderr).toBe(0);
      expect(t1.stdout.trim()).toBe("pong");
      expect(t1.calls).toBe(1);
      expect(t1.stderr).not.toMatch(/plafond/i);

      const t2 = await turn(2, ["-c", "tour deux"]);
      expect(t2.code, t2.stderr).toBe(0);
      expect(t2.calls).toBe(1);
      expect(t2.stderr).toMatch(/80 % du plafond de la conversation atteint \(1 000 \/ 1 200 tokens\)/);

      const t3 = await turn(3, ["-c", "tour trois"]);
      expect(t3.code, t3.stderr).toBe(0);
      expect(t3.stdout.trim()).toBe("pong");
      expect(t3.calls).toBe(1);
      expect(t3.stderr).not.toMatch(/80 %/);

      const t4 = await turn(4, ["-c", "tour quatre"]);
      expect(t4.code).toBe(1);
      expect(t4.calls).toBe(0);
      expect(t4.stderr).toMatch(/Plafond de la conversation atteint \(1 500 \/ 1 200 tokens\)\. Pour poursuivre, relevez-le : `\/budget <tokens> \[<usd>\]`/);

      const sessionId = readFileSync(join(dataDir, "cli-last-session.txt"), "utf8").trim();
      const raised = await withKernel(dataDir, async (k) => {
        const usage = k.agent.sessionUsage(sessionId);
        log(`base après le refus : ${usage.inputTokens} + ${usage.outputTokens} tokens`);
        expect(usage.inputTokens + usage.outputTokens).toBe(3 * (IN + OUT));
        return (await k.agent.commands.execute("/budget 5000", { sessionId }))?.text ?? "";
      });
      log(`/budget 5000 → ${JSON.stringify(raised)}`);
      expect(raised).not.toMatch(/^Erreur/);

      const t5 = await turn(5, ["-c", "tour cinq"]);
      expect(t5.code, t5.stderr).toBe(0);
      expect(t5.stdout.trim()).toBe("pong");
      expect(t5.calls).toBe(1);

      // Nouvelle conversation : le plafond global (1 200) s'applique, pas celui relevé ci-dessus.
      const other = await turn(6, ["autre conversation"]);
      expect(other.code, other.stderr).toBe(0);
      expect(other.calls).toBe(1);
      expect(readFileSync(join(dataDir, "cli-last-session.txt"), "utf8").trim()).not.toBe(sessionId);
      log("GATE P4 budget : verte");
    } finally {
      stub.close();
    }
  });
});
