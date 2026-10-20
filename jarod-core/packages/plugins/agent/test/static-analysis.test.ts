// Cockpit, lot 6 — scénario 8 de la mission : lancer une analyse statique autorisée ; aucun exécutable cible n'est lancé implicitement.
// Analyseurs (REA, Ghidra headless) SIMULÉS ; la porte unique et le registre des tâches sont réels. Vérifie la liste blanche statique,
// le confinement au dossier de travail, l'invariant « cible inchangée », l'artefact d'analyse, et l'annulation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionGuard, unifiedGate } from "@jarod/plugin-permissions";
import { ToolRegistry, type ToolDef } from "@jarod/plugin-tools";
import { describe, expect, it } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { ArtifactStore } from "../src/artifacts.js";
import { REA_STATIC, staticAnalysisTools } from "../src/static-analysis.js";
import { TaskLedger } from "../src/tasks.js";
import type { Runner } from "../src/video.js";
import { makeCore, tempDir } from "./helpers.js";

async function rig(run: Runner, o: { rea?: boolean; ghidra?: string | null; java?: number | null } = {}) {
  const core = await makeCore();
  const ws = tempDir();
  writeFileSync(join(ws, "app.exe"), "MZ-faux-binaire");
  writeFileSync(join(ws, "old.exe"), "MZ-ancienne-version");
  const artifacts = new ArtifactStore(core.db);
  const calls: string[][] = [];
  const traced: Runner = (file, args, opts) => (calls.push([file, ...args]), run(file, args, opts));
  const tools = staticAnalysisTools({
    artifacts,
    run: traced,
    which: (n) => (n === "rea" && o.rea !== false ? "C:\\bin\\rea.cmd" : null),
    ghidraRoot: () => (o.ghidra === undefined ? "C:\\Tools\\ghidra" : o.ghidra),
    javaMajor: async () => (o.java === undefined ? 21 : o.java),
  });
  return { core, ws, artifacts, calls, tools: Object.fromEntries(tools.map((t) => [t.name, t as unknown as ToolDef])) };
}

const ctxOf = (ws: string) => ({ sessionId: "s", workspace: ws });
const emits: Runner = async () => ({ code: 0, stdout: "== REA ==\nformat: PE32\narchitecture: x86_64\nfonctions: 42", stderr: "" });

describe("liste blanche statique (fail-closed)", () => {
  it("n'inclut aucune commande qui exécute, débogue ou capture un processus vivant", () => {
    for (const k of Object.keys(REA_STATIC)) expect(k, k).not.toMatch(/^(capture-|debug-with-|cutter-)|scenario/);
    expect(Object.keys(REA_STATIC)).toContain("analyze");
    expect(Object.keys(REA_STATIC)).toContain("decompile");
    expect(Object.keys(REA_STATIC)).not.toContain("debug-with-gdb");
  });
});

describe("rea_static", () => {
  it("analyze : lit le fichier, écrit l'analyse, l'enregistre en artefact, la cible reste inchangée", async () => {
    const { core, ws, calls, artifacts, tools } = await rig(emits);
    const before = readFileSync(join(ws, "app.exe"));
    const out = await tools.rea_static!.run({ action: "analyze", path: "app.exe" }, ctxOf(ws));
    const o = JSON.parse(out);
    expect(o).toMatchObject({ analysis: "app.exe.rea-analyze.md", targetUnchanged: true });
    expect(calls[0]).toEqual(["C:\\bin\\rea.cmd", "analyze", join(ws, "app.exe"), "--format", "md"]);
    expect(readFileSync(join(ws, "app.exe.rea-analyze.md"), "utf8")).toMatch(/architecture: x86_64/);
    expect(artifacts.list({ kind: "analysis" })[0]).toMatchObject({ origin: "rea_static", sourcePath: join(ws, "app.exe") });
    expect(readFileSync(join(ws, "app.exe"))).toEqual(before); // la cible n'a pas été touchée
    expect((await tools.rea_static!.verify!({}, out, ctxOf(ws))).status).toBe("verified");
    await core.dispose();
  });

  it("decompile passe l'adresse ; compare passe deux chemins ; le format json est honoré", async () => {
    const { core, ws, calls, tools } = await rig(emits);
    await tools.rea_static!.run({ action: "decompile", path: "app.exe", address: "0x401000" }, ctxOf(ws));
    expect(calls[0]).toEqual(["C:\\bin\\rea.cmd", "decompile", join(ws, "app.exe"), "0x401000", "--format", "md"]);
    await tools.rea_static!.run({ action: "compare", path: "app.exe", path2: "old.exe", format: "json" }, ctxOf(ws));
    expect(calls[1]).toEqual(["C:\\bin\\rea.cmd", "compare", join(ws, "app.exe"), join(ws, "old.exe"), "--format", "json"]);
    await core.dispose();
  });

  it("refuse AVANT de lancer : commande hors liste, fichier hors du dossier de travail, cible absente, REA manquant", async () => {
    const { core, ws, calls, tools } = await rig(emits);
    const c = ctxOf(ws);
    await expect(Promise.resolve().then(() => tools.rea_static!.precheck!({ action: "debug-with-gdb", path: "app.exe" }, c as never))).rejects.toThrow(/non autorisée/);
    await expect(Promise.resolve().then(() => tools.rea_static!.precheck!({ action: "analyze", path: "..\\secret.exe" }, c as never))).rejects.toThrow(/hors du dossier/);
    await expect(Promise.resolve().then(() => tools.rea_static!.precheck!({ action: "analyze", path: "absent.exe" }, c as never))).rejects.toThrow(/n'existe pas/);
    expect(calls).toEqual([]);
    const noRea = await rig(emits, { rea: false });
    await expect(Promise.resolve().then(() => noRea.tools.rea_static!.precheck!({ action: "analyze", path: "app.exe" }, ctxOf(noRea.ws) as never))).rejects.toThrow(/pas installé/);
    await noRea.core.dispose();
    await core.dispose();
  });

  it("si l'analyseur modifiait la cible, l'analyse est arrêtée (invariant : une analyse statique ne modifie pas son entrée)", async () => {
    const tamper: Runner = async (_f, args) => (writeFileSync(args[1]!, "MODIFIÉ"), { code: 0, stdout: "x", stderr: "" });
    const { core, ws, tools } = await rig(tamper);
    await expect(tools.rea_static!.run({ action: "analyze", path: "app.exe" }, ctxOf(ws))).rejects.toThrow(/cible a changé/);
    await core.dispose();
  });

  it("annulation dans la vraie boucle : le signal est transmis, la tâche est annulée, aucun artefact", async () => {
    const slow: Runner = (_f, _a, o) => new Promise((res) => o.signal?.addEventListener("abort", () => res({ code: null, stdout: "", stderr: "", aborted: true })));
    const { core, ws, artifacts, tools } = await rig(slow);
    const reg = new ToolRegistry();
    reg.register(tools.rea_static!);
    const tasks = new TaskLedger();
    const settings = { disabledTools: [], agentMode: "build", autoApproveTools: false, alwaysAllowTools: [], workspace: ws } as never;
    const pending = executeGuardedTool(reg, "s", { id: "c", name: "rea_static", args: { action: "analyze", path: "app.exe" } }, new AbortController().signal, { approve: async () => true }, settings, { gate: unifiedGate(new PermissionGuard(), () => true), tasks });
    await new Promise((r) => setTimeout(r, 20));
    expect(tasks.list()[0]!.status).toBe("running");
    tasks.cancel(tasks.list()[0]!.id);
    expect((await pending).isError).toBe(true);
    expect(tasks.list()[0]!.status).toBe("cancelled");
    expect(artifacts.list()).toEqual([]);
    await core.dispose();
  });
});

describe("ghidra_analyze", () => {
  it("importe en headless sans exécuter la cible (-import, -deleteProject), écrit le rapport, enregistre l'artefact", async () => {
    const log: Runner = async () => ({ code: 0, stdout: "INFO  REPORT: Analysis succeeded for file /app.exe (HeadlessAnalyzer)", stderr: "" });
    const { core, ws, calls, artifacts, tools } = await rig(log);
    const out = await tools.ghidra_analyze!.run({ path: "app.exe", timeout_seconds: 90 }, ctxOf(ws));
    const argv = calls[0]!;
    expect(argv[0]).toContain("analyzeHeadless");
    expect(argv).toContain("-import");
    expect(argv).toContain("-deleteProject");
    expect(argv).toContain("90");
    expect(argv.some((a) => /-postScript|-preScript|-process/.test(a))).toBe(false); // aucun script, aucune exécution
    expect(JSON.parse(out).analysis).toBe("app.exe.ghidra.txt");
    expect(readFileSync(join(ws, "app.exe.ghidra.txt"), "utf8")).toMatch(/Analysis succeeded/);
    expect(artifacts.list({ kind: "analysis" })[0]!.origin).toBe("ghidra_analyze");
    await core.dispose();
  });

  it("refuse si Ghidra manque ou si le JDK n'est pas 21+", async () => {
    const noop: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
    const noGhidra = await rig(noop, { ghidra: null });
    await expect(Promise.resolve().then(() => noGhidra.tools.ghidra_analyze!.precheck!({ path: "app.exe" }, ctxOf(noGhidra.ws) as never))).rejects.toThrow(/Ghidra introuvable/);
    await noGhidra.core.dispose();
    const oldJava = await rig(noop, { java: 17 });
    await expect(Promise.resolve().then(() => oldJava.tools.ghidra_analyze!.precheck!({ path: "app.exe" }, ctxOf(oldJava.ws) as never))).rejects.toThrow(/JDK 21/);
    await oldJava.core.dispose();
  });
});
