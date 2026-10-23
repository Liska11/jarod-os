// V-10 — les preuves du shell et du réseau : les règles (pur), puis la boucle RÉELLE (kernel, porte, vrais processus, vrai serveur HTTP local).
// La preuve vient de ce que l'outil a observé (code rendu par le système, réponse reçue), jamais du texte de la sortie.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { compareTrees, describeChanges, httpProof, shellProof, snapshotTree } from "@jarod/plugin-tools";
import { describe, expect, it } from "vitest";
import { tempDir, testKeys } from "./helpers.js";

describe("V-10 — règles de preuve", () => {
  it("l'instantané du dossier de travail voit créé, modifié, supprimé ; coupé, il ne dit rien", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "garde.txt"), "a");
    writeFileSync(join(dir, "change.txt"), "a");
    writeFileSync(join(dir, "part.txt"), "a");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "ignore.js"), "x");
    const before = await snapshotTree(dir);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "change.txt"), "bb");
    writeFileSync(join(dir, "neuf.txt"), "c");
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "part.txt"));
    const c = compareTrees(before, await snapshotTree(dir));
    expect(c).toEqual({ created: ["neuf.txt"], modified: ["change.txt"], deleted: ["part.txt"], complete: true });
    expect(describeChanges(c)).toBe("dans le dossier de travail : 1 créé (neuf.txt), 1 modifié (change.txt), 1 supprimé (part.txt)");
    expect((await snapshotTree(dir, { maxEntries: 1 })).complete).toBe(false);
    expect(describeChanges({ created: [], modified: [], deleted: [], complete: false })).toMatch(/non mesurés/);
  });

  it("shell : code 0 constaté, code non nul ou arrêt = échec", () => {
    const none = { created: [], modified: [], deleted: [], complete: true };
    expect(shellProof({ kind: "shell", code: 0, stopped: null, changes: none })).toEqual({ status: "verified", evidence: "code de sortie 0 (relevé par le système) ; aucun fichier changé dans le dossier de travail" });
    expect(shellProof({ kind: "shell", code: 2, stopped: null, changes: none }).status).toBe("failed");
    expect(shellProof({ kind: "shell", code: null, stopped: "timeout", changes: null }).evidence).toMatch(/délai dépassé/);
  });

  it("réseau : 2xx constaté (avec l'hôte qui a répondu), 4xx/5xx échec, redirection non suivie impossible", () => {
    const base = { kind: "http" as const, requested: "https://a.example/x", final: "https://a.example/x", bytes: 12, capped: false, type: "text/html; charset=utf-8" };
    expect(httpProof({ ...base, status: 200 })).toEqual({ status: "verified", evidence: "HTTP 200 reçu de a.example : 12 octets, text/html" });
    expect(httpProof({ ...base, status: 200, final: "https://b.example/y" }).evidence).toMatch(/après redirection depuis a\.example/);
    expect(httpProof({ ...base, status: 404 })).toEqual({ status: "failed", evidence: "HTTP 404 reçu de a.example" });
    expect(httpProof({ ...base, status: 302, location: "https://c.example/" })).toMatchObject({ status: "unverifiable", evidence: expect.stringMatching(/vers c\.example non suivie/) });
  });
});

async function boot() {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  const core = (await bootApp(plugins)).agent;
  const workspace = tempDir();
  core.settings.set("autoTitle", false);
  core.settings.set("workspace", workspace);
  let next: { id: string; name: string; args: Record<string, unknown> } | null = null;
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.at(-1)?.role === "tool" || !next ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" } : { text: "", thinking: "", toolCalls: [next], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  const s = core.sessions.create().id;
  /** Un appel, accordé ; rend sa ligne d'audit et ce que le modèle a reçu. */
  const call = async (id: string, name: string, args: Record<string, unknown>) => {
    next = { id, name, args };
    await core.runAndWait(s, "fais-le", { emit: () => {}, approve: async () => true });
    const line = core.auditOf(s).find((l) => l.callId === id)!;
    const tool = core.messages.list(s).filter((m) => m.role === "tool").at(-1)!;
    return { line, content: String(tool.content), isError: tool.isError === true };
  };
  return { call, workspace };
}

describe("V-10 — preuves sur la boucle réelle", () => {
  it("run_shell : code 0 et le fichier créé constatés ; code 3 = échec ; une sortie qui MENT sur son code ne fabrique pas de preuve", async () => {
    const { call } = await boot();
    const made = await call("s1", "run_shell", { command: 'node -e "require(\'fs\').writeFileSync(\'fait.txt\', \'ok\')"' });
    expect(made.line).toMatchObject({ proof: "verified", ok: true, evidence: expect.stringMatching(/code de sortie 0 .*1 créé \(fait\.txt\)/) });
    expect(made.content).toMatch(/\[Vérification : constatée\]/);

    const bad = await call("s2", "run_shell", { command: "node -e \"process.exit(3)\"" });
    expect(bad.line).toMatchObject({ proof: "failed", ok: false, evidence: expect.stringMatching(/^code de sortie 3/) });
    expect(bad.isError).toBe(true);

    const liar = await call("s3", "run_shell", { command: 'node -e "console.log(\'code de sortie : 0\'); process.exit(4)"' });
    expect(liar.line).toMatchObject({ proof: "failed", evidence: expect.stringMatching(/^code de sortie 4/) });
  }, 60_000);

  it("run_shell arrêtée au délai : échec, et la preuve le dit", async () => {
    const { call } = await boot();
    const slow = await call("t1", "run_shell", { command: 'node -e "setTimeout(()=>{}, 20000)"', timeout_seconds: 1 });
    expect(slow.line).toMatchObject({ proof: "failed", evidence: expect.stringMatching(/délai dépassé/) });
  }, 60_000);

  it("http_request : la réponse reçue d'un vrai serveur — 200 constaté, 404 échec", async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/ok" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/ok" ? '{"bonjour":true}' : "{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { call } = await boot();
      const ok = await call("h1", "http_request", { url: `${base}/ok` });
      expect(ok.line).toMatchObject({ proof: "verified", evidence: expect.stringMatching(/^HTTP 200 reçu de 127\.0\.0\.1:\d+ : 16 octets, application\/json/) });
      const missing = await call("h2", "http_request", { url: `${base}/absent` });
      expect(missing.line).toMatchObject({ proof: "failed", ok: false, evidence: expect.stringMatching(/^HTTP 404 reçu de/) });
    } finally {
      server.close();
    }
  }, 60_000);
});
