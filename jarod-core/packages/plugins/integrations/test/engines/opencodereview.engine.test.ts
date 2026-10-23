// G16 contre OpenCodeReview réel (engines/opencodereview/ocr.exe, 1.12.12, empreinte vérifiée), sur un dépôt git FABRIQUÉ :
// plan sans modèle, revue complète contre un faux modèle LOCAL, constat localisé, aucune écriture dans le dépôt ni dans le profil.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeReviewPlanTool, planReview, runReview } from "../../src/impl/code-review.js";
import { AdapterRefused } from "../../src/impl/common.js";
import { startFakeLlm } from "./fake_llm.js";
import { ROOT } from "./helpers.js";

const BIN = process.env.JAROD_OCR ?? join(ROOT, "engines", "opencodereview", "ocr.exe");
const has = existsSync(BIN);
if (!has) console.warn(`[moteurs] ${BIN} absent : les tests OpenCodeReview réels sont ignorés (voir engines.lock/README.md)`);

const dir = mkdtempSync(join(tmpdir(), "jarod-ocr-test-"));
const repo = join(dir, "depot");
// Aucune variable GIT_* héritée par les git du test (incident du 2026-10-22) : git la suivrait avant `-C`, jusque dans un autre dépôt.
// ocr.exe, lui, ne reçoit que la liste ENV_KEEP de code-review.ts.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", env: gitEnv }).toString();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(() => {
  execFileSync("git", ["init", "-q", repo], { env: gitEnv });
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n\n\ndef div(a, b):\n    return a / b\n");
});

describe.skipIf(!has)("G16 contre OpenCodeReview réel", () => {
  it("plan sans modèle : fichiers modifiés et règles applicables", async () => {
    const plan = await planReview({ bin: BIN, repo, scope: { kind: "workspace" } });
    expect(plan.mode).toBe("workspace");
    expect(plan.files).toEqual([{ path: "calc.py", status: "modified", insertions: 5, deletions: 1 }]);
    expect(plan.rules.length).toBeGreaterThan(0);
    expect(plan.rules[0]!.files).toContain("calc.py");
  });

  it("l'outil de l'agent rend le plan, refuse un dépôt hors du dossier de travail et dit quand le moteur manque", async () => {
    const tool = codeReviewPlanTool(() => BIN);
    expect(await tool.run({ scope: "workspace" }, { sessionId: "s", workspace: repo })).toMatch(/calc\.py \[modified\]/);
    expect(await tool.run({ scope: "workspace", repo: ".." }, { sessionId: "s", workspace: repo })).toMatch(/Refusé/);
    expect(await codeReviewPlanTool(() => null).run({ scope: "workspace" }, { sessionId: "s", workspace: repo })).toMatch(/Indisponible/);
    expect(await tool.run({ scope: "commit", ref: "--output=x" }, { sessionId: "s", workspace: repo })).toMatch(/référence invalide/);
  });

  it("revue complète contre un modèle LOCAL : constat avec fichier, ligne retrouvée, extrait ; jeton jamais en argument ; rien écrit", async () => {
    const llm = await startFakeLlm((call) => {
      if (call.tools.includes("code_comment") && !call.afterTool)
        return { tool: "code_comment", args: { comments: [{ path: "calc.py", category: "bug", severity: "high", content: "add soustrait au lieu d'additionner.", existing_code: "    return a - b", suggestion_code: "    return a + b" }] } };
      if (call.tools.includes("task_done")) return { tool: "task_done", args: { state: "DONE" } };
      return { content: '{"keep": [0]}' };
    });
    const statusBefore = git("status", "--porcelain");
    try {
      const r = await runReview({ bin: BIN, repo, scope: { kind: "workspace" }, endpoint: { url: llm.url, model: "faux-modele", protocol: "openai", token: "jeton-factice-0042" }, timeoutMs: 120_000 });
      expect(r.endpoint).toBe("local");
      expect(r.findings).toContainEqual(expect.objectContaining({ file: "calc.py", line: 2, category: "bug", severity: "high", evidence: "    return a - b", confidence: "located" }));
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(llm.calls.every((c) => c.auth)).toBe(true);
    } finally {
      await llm.close();
    }
    expect(git("status", "--porcelain")).toBe(statusBefore);
    expect(readdirSync(repo).sort()).toEqual([".git", "calc.py"]);
  }, 180_000);

  it("point d'accès distant sans accord : refusé avant tout lancement ; identifiants dans l'URL : refusés", async () => {
    await expect(runReview({ bin: BIN, repo, scope: { kind: "workspace" }, endpoint: { url: "https://api.example.invalid/v1", model: "m", protocol: "openai" } })).rejects.toBeInstanceOf(AdapterRefused);
    await expect(runReview({ bin: BIN, repo, scope: { kind: "workspace" }, endpoint: { url: "http://user:pass@127.0.0.1:1/v1", model: "m", protocol: "openai" } })).rejects.toThrow(/identifiants/);
  });

  it("annulation : erreur explicite", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(planReview({ bin: BIN, repo, scope: { kind: "workspace" }, signal: ctrl.signal })).rejects.toThrow(/annulée/);
  });
});
