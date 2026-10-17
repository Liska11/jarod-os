/**
 * A1 branché dans `run_shell` : MXC (ProcessContainer de Windows) est un mécanisme de confinement du garde du shell, essayé APRÈS
 * jarod-sandbox, absent tant que JAROD_MXC_RUNNER / JAROD_MXC_SDK ne sont pas réglés. Les tests de politique emploient une sonde
 * simulée ; le bloc « moteur réel » lance de VRAIES commandes par l'outil `run_shell` et regarde le disque.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeMechanism, ShellGuardService, type ShellLaunchPlan, type ShellProbe } from "@jarod/plugin-permissions";
import { runShell } from "@jarod/plugin-tools";
import { makeCore, tempDir } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../../../..");
const RUNNER = join(ROOT, "jarod-core", "sidecars", "mxc-run", "mxc_run.mjs");
const SDK = join(ROOT, "engines", "mxc", "node_modules", "@microsoft", "mxc-sdk", "dist", "v1", "index.js");

const plan = async (probe: ShellProbe, env: NodeJS.ProcessEnv, ws: string, envKeys: string[] = []) =>
  new ShellGuardService({ workspace: ws, platform: "win32", env, probe }).plan("echo salut", { writeScope: "workspace", cwd: ws, envKeys });

/** Seul MXC est présent : la sonde dit ce que dirait la machine. */
const onlyMxc: ShellProbe = (input) =>
  input.id === "mxc" ? { ok: true, path: "C:\\outils\\node.exe", detail: "node simulé" } : { ok: false, path: null, detail: `absent (simulé, ${input.id})` };

describe("A1 dans run_shell — la politique", () => {
  const env = { JAROD_MXC_RUNNER: "C:\\x\\mxc_run.mjs", JAROD_MXC_SDK: "C:\\x\\sdk.js" };

  it("avec MXC seul, la ligne part vers le lanceur, dossier de travail en zone d'écriture", async () => {
    const ws = tempDir();
    const p = (await plan(onlyMxc, env, ws)) as ShellLaunchPlan;
    expect(p.kind).toBe("plan");
    expect(p.mechanism).toBe("mxc");
    expect(p.mode).toBe("exec");
    expect(p.bin).toBe("C:\\outils\\node.exe");
    expect(p.args.slice(0, 2)).toEqual(["C:\\x\\mxc_run.mjs", "exec"]);
    expect(p.args).toContain("--workspace");
    expect(p.args.at(-1)).toBe("echo salut");
    expect(p.detail).toMatch(/mxc/);
  });

  it("jarod-sandbox garde la priorité : MXC ne le remplace pas", async () => {
    const both: ShellProbe = (input, platform) =>
      input.platforms.includes(platform) ? { ok: true, path: `C:\\outils\\${input.binary}.exe`, detail: "simulé" } : { ok: false, path: null, detail: "absent" };
    const p = (await plan(both, env, tempDir())) as ShellLaunchPlan;
    expect(p.mechanism).toBe("jarod-sandbox");
  });

  it("sans les deux variables, MXC est absent : le confinement demandé est refusé, jamais promis", () => {
    const g = new ShellGuardService({ workspace: tempDir(), platform: "win32", env: {} });
    const input = { id: "mxc" as const, binary: "node", platforms: ["win32" as const], versionArg: "selftest", mustExitZero: true, launcherEnv: "JAROD_MXC_RUNNER", gateEnv: "JAROD_MXC_SDK" };
    const r = probeMechanism(input, "win32", { PATH: process.env.PATH });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/non configuré/);
    expect(g.mechanism().available).toBe(false);
  });

  it("un lanceur désigné mais un moteur absent : absent aussi", () => {
    const input = { id: "mxc" as const, binary: "node", platforms: ["win32" as const], versionArg: "selftest", mustExitZero: true, launcherEnv: "JAROD_MXC_RUNNER", gateEnv: "JAROD_MXC_SDK" };
    const r = probeMechanism(input, "win32", { PATH: process.env.PATH, JAROD_MXC_RUNNER: RUNNER, JAROD_MXC_SDK: join(tempDir(), "absent.js") });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/moteur/);
  });

  it("les secrets du coffre ne sont pas transmis : refus avant de lancer", async () => {
    const r = await plan(onlyMxc, env, tempDir(), ["TOKEN"]);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toMatch(/secrets/);
  });
});

const supported = process.platform === "win32" && existsSync(SDK) && existsSync(RUNNER);

describe.skipIf(!supported)("A1 dans run_shell — contre MXC réel, par l'outil run_shell", () => {
  const saved = { runner: process.env.JAROD_MXC_RUNNER, sdk: process.env.JAROD_MXC_SDK, bin: process.env.JAROD_SANDBOX_BIN };
  beforeAll(() => {
    process.env.JAROD_MXC_RUNNER = RUNNER;
    process.env.JAROD_MXC_SDK = SDK;
    delete process.env.JAROD_SANDBOX_BIN;
  });
  afterAll(() => {
    for (const [k, v] of [["JAROD_MXC_RUNNER", saved.runner], ["JAROD_MXC_SDK", saved.sdk], ["JAROD_SANDBOX_BIN", saved.bin]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const run = async (ws: string, command: string, extra: Record<string, unknown> = {}) => {
    const core = await makeCore();
    return core.tools.get("run_shell")!.run({ command, isolation: "workspace", timeout_seconds: 90, ...extra }, { sessionId: "s", workspace: ws });
  };

  it("la sortie dit que MXC tient la commande, et une écriture DANS le dossier de travail réussit", async () => {
    const ws = tempDir();
    const out = await run(ws, `cmd /D /S /C "echo bien > dedans.txt & type dedans.txt"`);
    expect(out).toMatch(/mxc/);
    expect(out).toContain("bien");
    expect(readFileSync(join(ws, "dedans.txt"), "utf8")).toContain("bien");
  }, 120_000);

  it("une écriture HORS du dossier de travail est refusée par le noyau : le fichier n'existe pas", async () => {
    const ws = tempDir();
    const outside = tempDir();
    const target = join(outside, "evade.txt");
    const line = `cmd /D /S /C "echo x > "${target}""`;
    await run(ws, line).catch(() => undefined);
    expect(existsSync(target)).toBe(false);
    // Témoin : la même ligne, sans confinement, écrit bien ce fichier — le refus ci-dessus vient donc du noyau, pas de la ligne.
    await runShell(line, ws);
    expect(existsSync(target)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  }, 120_000);

  it("sans variables, la même demande est refusée au lieu de tourner sans protection", async () => {
    const ws = tempDir();
    delete process.env.JAROD_MXC_RUNNER;
    try {
      const marker = join(ws, "ne-doit-pas-exister.txt");
      await expect(run(ws, `cmd /D /S /C "echo x > "${marker}""`)).rejects.toThrow(/PAS été lancée/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.JAROD_MXC_RUNNER = RUNNER;
    }
  }, 120_000);
});
