/**
 * Lancement d'un agent de code : arguments, lecture des flux JSON, échecs, délai et annulation. Un faux agent
 * (fixtures/fake-agent.mjs) remplace Claude Code et Codex : aucun modèle n'est appelé.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchFor, readAgentLine, runCliAgent, type Launch } from "../src/cli-agent.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const fake = (mode: string): Launch => ({ command: process.execPath, args: [FAKE, mode] });
const cwd = process.cwd();

describe("arguments des agents", () => {
  it("Claude Code : sortie en flux JSON, écriture acceptée dans le dossier, modèle optionnel", () => {
    const launch = launchFor("claude", undefined, {});
    expect(launch.command).toBe("claude");
    expect(launch.args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
    expect(launchFor("claude", "opus-5", {}).args).toContain("--model");
  });

  it("Codex : exec en JSON, sandbox limité au dossier, prompt lu sur l'entrée standard (« - »)", () => {
    const launch = launchFor("codex", undefined, {});
    expect(launch.command).toBe("codex");
    expect(launch.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(launch.args.at(-1)).toBe("-");
  });

  it("les binaires se changent par variable d'environnement", () => {
    expect(launchFor("claude", undefined, { JAROD_CLAUDE_BIN: "/opt/claude" }).command).toBe("/opt/claude");
    expect(launchFor("codex", undefined, { JAROD_CODEX_BIN: "C:/tools/codex.cmd" }).command).toBe("C:/tools/codex.cmd");
  });

  it("refuse un nom de modèle qui pourrait servir à injecter une option ou une commande", () => {
    expect(() => launchFor("claude", "x; rm -rf /", {})).toThrow(/modèle refusé/);
    expect(() => launchFor("codex", "--yolo", {})).toThrow(/modèle refusé/);
  });
});

describe("lecture des flux", () => {
  it("ignore les lignes qui ne sont pas du JSON", () => {
    const into = { texts: [] as string[] };
    readAgentLine("claude", "pas du json", into);
    readAgentLine("claude", "", into);
    expect(into.texts).toEqual([]);
  });
});

describe("runCliAgent", () => {
  it("Claude : rend la réponse finale et le coût, et transmet le prompt par l'entrée standard", async () => {
    const result = await runCliAgent({ harness: "claude", cwd, prompt: "ajoute un test" }, fake("claude-ok"));
    expect(result).toMatchObject({ ok: true, text: "reçu: ajoute un test", costUsd: 0.0123, exitCode: 0 });
  });

  it("Codex : rend le dernier message de l'agent, sans le raisonnement", async () => {
    const result = await runCliAgent({ harness: "codex", cwd, prompt: "corrige" }, fake("codex-ok"));
    expect(result).toMatchObject({ ok: true, text: "reçu: corrige", exitCode: 0 });
    expect(result.costUsd).toBeUndefined();
  });

  it("Codex : un tour échoué est un échec, avec son message", async () => {
    const result = await runCliAgent({ harness: "codex", cwd, prompt: "x" }, fake("codex-fail"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("quota atteint");
  });

  it("un code de sortie non nul sans événement est un échec, et l'erreur d'agent est gardée", async () => {
    const result = await runCliAgent({ harness: "claude", cwd, prompt: "x" }, fake("exit2"));
    expect(result).toMatchObject({ ok: false, error: "code de sortie 2", exitCode: 2 });
    expect(result.stderr).toContain("boom");
  });

  it("un agent absent du système est signalé, sans lever", async () => {
    const result = await runCliAgent({ harness: "claude", cwd, prompt: "x" }, { command: "jarod-agent-introuvable-xyz", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("au-delà du délai, l'agent est arrêté et l'échec le dit", async () => {
    const result = await runCliAgent({ harness: "claude", cwd, prompt: "x", timeoutMs: 300 }, fake("hang"));
    expect(result).toMatchObject({ ok: false, error: "délai dépassé" });
  });

  it("une annulation arrête l'agent", async () => {
    const controller = new AbortController();
    const pending = runCliAgent({ harness: "claude", cwd, prompt: "x", signal: controller.signal }, fake("hang"));
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it("refuse un dossier relatif ou un prompt vide", async () => {
    await expect(runCliAgent({ harness: "claude", cwd: "relatif", prompt: "x" }, fake("claude-ok"))).rejects.toThrow(/absolu/);
    await expect(runCliAgent({ harness: "claude", cwd, prompt: "   " }, fake("claude-ok"))).rejects.toThrow(/prompt vide/);
  });
});

describe("environnement de l'agent", () => {
  it("l'agent ne reçoit ni jeton de contrôle interne ni clé de fournisseur de Jarod, mais garde son PATH", async () => {
    const names = ["JAROD_GATEWAY_TOKEN", "JAROD_OS_CONTROL_TOKEN", "ANTHROPIC_API_KEY"];
    const saved = names.map((n) => process.env[n]);
    for (const n of names) process.env[n] = "valeur-secrete";
    try {
      const result = await runCliAgent({ harness: "claude", cwd, prompt: "x" }, fake("env"));
      expect(JSON.parse(result.text)).toEqual({ gatewayToken: false, controlToken: false, providerKey: false, path: true });
    } finally {
      names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
    }
  });
});

describe("un seul agent par dossier", () => {
  it("refuse un second agent dans le même dossier tant que le premier travaille, sans gêner un autre dossier", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { agentBusy } = await import("../src/cli-agent.js");
    const dir = await mkdtemp(join(tmpdir(), "jarod-busy-a-"));
    const other = await mkdtemp(join(tmpdir(), "jarod-busy-b-"));
    const controller = new AbortController();
    try {
      const first = runCliAgent({ harness: "claude", cwd: dir, prompt: "x", signal: controller.signal }, fake("hang"));
      expect(agentBusy(dir)).toBe(true);
      expect(agentBusy(other)).toBe(false);

      await expect(runCliAgent({ harness: "claude", cwd: dir, prompt: "y" }, fake("claude-ok"))).rejects.toThrow(/travaille déjà/);
      expect((await runCliAgent({ harness: "claude", cwd: other, prompt: "z" }, fake("claude-ok"))).ok).toBe(true);

      controller.abort();
      await first;
      expect(agentBusy(dir)).toBe(false);
      expect((await runCliAgent({ harness: "claude", cwd: dir, prompt: "encore" }, fake("claude-ok"))).ok).toBe(true);
    } finally {
      controller.abort();
      await Promise.all([dir, other].map((d) => rm(d, { recursive: true, force: true })));
    }
  });

  it("libère le dossier même si le lancement échoue", async () => {
    const { agentBusy } = await import("../src/cli-agent.js");
    const missing = { command: "jarod-agent-introuvable-xyz", args: [] };
    await runCliAgent({ harness: "claude", cwd, prompt: "x" }, missing);
    expect(agentBusy(cwd)).toBe(false);
  });
});
