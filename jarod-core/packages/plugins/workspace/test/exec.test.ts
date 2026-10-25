/**
 * Lancement de commandes externes : sortie, code de sortie, délai, commande absente.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execArgs, shellCommand } from "../src/exec.js";

describe("execArgs", () => {
  it("rend la sortie et le code de sortie d'une commande qui réussit", async () => {
    const result = await execArgs(process.execPath, ["-e", "process.stdout.write('bonjour')"]);
    expect(result.code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout.toString("utf8")).toBe("bonjour");
  });

  it("signale un code de sortie non nul, avec sa sortie d'erreur", async () => {
    const result = await execArgs(process.execPath, ["-e", "process.stderr.write('mauvais'); process.exit(3)"]);
    expect(result.code).toBe(3);
    expect(result.error).toBe("code de sortie 3");
    expect(result.stderr).toBe("mauvais");
  });

  it("passe l'entrée standard", async () => {
    const result = await execArgs(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "écho" });
    expect(result.stdout.toString("utf8")).toBe("écho");
  });

  it("arrête la commande au délai", async () => {
    const result = await execArgs(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
    expect(result.error).toBe("délai dépassé");
  });

  it("une commande absente est signalée, sans lever", async () => {
    const result = await execArgs("jarod-commande-introuvable-xyz", []);
    expect(result.code).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe("environnement de l'enfant", () => {
  const SECRETS = { JAROD_GATEWAY_TOKEN: "g-token", JAROD_OS_CONTROL_TOKEN: "c-token", ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [name, value] of Object.entries(SECRETS)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterEach(() => {
    for (const name of Object.keys(SECRETS)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("ne transmet ni jeton de contrôle interne ni clé de fournisseur de Jarod, mais garde PATH", async () => {
    const script = "const e = process.env; process.stdout.write(JSON.stringify({ g: 'JAROD_GATEWAY_TOKEN' in e, c: 'JAROD_OS_CONTROL_TOKEN' in e, a: 'ANTHROPIC_API_KEY' in e, o: 'OPENAI_API_KEY' in e, p: Boolean(e.PATH || e.Path) }))";
    const result = await execArgs(process.execPath, ["-e", script]);
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({ g: false, c: false, a: false, o: false, p: true });
  });
});

describe("shellCommand", () => {
  it("ne touche pas une commande sans shell ou sans espace, et cite un chemin avec une espace", () => {
    const spaced = "C:/Program Files/nodejs/node.exe";
    expect(shellCommand(spaced, false)).toBe(spaced);
    expect(shellCommand("claude", true)).toBe("claude");
    expect(shellCommand(spaced, true)).toBe(`"${spaced}"`);
  });

  it("refuse un guillemet dans la commande plutôt que de le citer de travers", () => {
    expect(() => shellCommand('C:/a b"c/x.exe', true)).toThrow(/guillemet/);
  });

  it.skipIf(process.platform !== "win32")("lance un .cmd dont le dossier contient une espace (Windows)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarod exec "));
    try {
      const cmd = join(dir, "dit-ok.cmd");
      await writeFile(cmd, "@echo off\r\necho ok\r\n");
      const result = await execArgs(cmd, [], { shell: true });
      expect(result.stdout.toString("utf8").trim()).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
