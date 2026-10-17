/**
 * Recette de référence (phase 6B), écrite à la main et mesurée : chaque étape traverse la porte unique
 * (`executeGuardedTool`) avec les vrais outils, un dossier de travail jeton et un faux accord. Rien n'est lancé en dehors.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "@jarod/plugin-storage";
import { describe, expect, it } from "vitest";
import { type AuditEntry, executeGuardedTool } from "../src/agent.js";
import { compileRecipe, type PlanCall, runPlan } from "../../integrations/src/recipes/index.js";
import { makeCore, tempDir } from "./helpers.js";

const recipe = {
  schema: 1,
  id: "reference.hello",
  name: "Outil de référence",
  version: "1.0.0",
  vars: ["tool"],
  steps: [
    { id: "cfg", verb: "fs.write", params: { path: "tools/{{tool}}/config.txt", content: "installed by recipe\n" } },
    { id: "ver", verb: "fs.read", params: { path: "tools/{{tool}}/config.txt" }, save: "seen" },
    { id: "ls", verb: "fs.list", params: { path: "tools" } },
  ],
};

async function arena(decide: "allow" | "deny" = "allow") {
  const workspace = join(tempDir(), "zone");
  mkdirSync(workspace, { recursive: true });
  const core = await makeCore();
  core.settings.patch({ workspace });
  const audit: AuditEntry[] = [];
  const settings = { ...DEFAULT_SETTINGS, workspace } as Settings;
  const execute = (c: PlanCall) =>
    executeGuardedTool(core.tools, "recipe", { id: c.id, name: c.name, args: c.args }, new AbortController().signal, { approve: async () => true }, settings, {
      audit: (e) => audit.push(e),
      gate: { decide: () => decide },
    });
  return { workspace, audit, execute };
}

describe("recette de référence à travers la porte unique", () => {
  it("installe un petit outil dans la zone, étape par étape, audité, et se mesure", async () => {
    const a = await arena();
    const plan = compileRecipe(recipe);
    const t0 = performance.now();
    const res = await runPlan(plan, { execute: a.execute, vars: { tool: "hello" } });
    const ms = performance.now() - t0;

    expect(res).toMatchObject({ ok: true, completed: 3 });
    expect(readFileSync(join(a.workspace, "tools", "hello", "config.txt"), "utf8")).toBe("installed by recipe\n");
    expect(res.vars.seen).toContain("installed by recipe");
    // l'écriture (outil sensible) laisse sa ligne d'audit : accordée et réussie ; les lectures ne sont pas auditées par la porte
    expect(a.audit.filter((e) => e.tool === "write_file").map((e) => [e.decision, e.ok])).toEqual([["accordé", true]]);
    // mesure : 3 étapes de fichiers dans une zone locale doivent rester très en dessous de la seconde par étape
    expect(ms).toBeLessThan(3000);
    console.info(`[mesure] recette de référence : ${plan.steps.length} étapes en ${ms.toFixed(0)} ms`);
  });

  it("un nom de dossier qui tente de sortir de la zone est refusé avant l'outil, rien n'est écrit", async () => {
    const a = await arena();
    const res = await runPlan(compileRecipe(recipe), { execute: a.execute, vars: { tool: "../../evil" } });
    expect(res).toMatchObject({ ok: false, failedStep: "cfg" });
    expect(a.audit).toHaveLength(0);
    expect(existsSync(join(a.workspace, "..", "..", "evil"))).toBe(false);
  });

  it("si la politique de permissions refuse (deny), aucune étape n'écrit", async () => {
    const a = await arena("deny");
    const res = await runPlan(compileRecipe(recipe), { execute: a.execute, vars: { tool: "hello" } });
    expect(res.ok).toBe(false);
    expect(existsSync(join(a.workspace, "tools"))).toBe(false);
    expect(a.audit.every((e) => e.decision.startsWith("refusé"))).toBe(true);
  });

  it("une étape shell passe par run_shell avec l'isolation « workspace » imposée : elle tourne confinée ou elle est refusée, jamais sans protection", async () => {
    const a = await arena();
    const plan = compileRecipe({ ...recipe, steps: [{ id: "sh", verb: "shell.run", params: { command: "echo built" } }] });
    expect(plan.steps[0]!.args).toMatchObject({ isolation: "workspace" });
    const res = await runPlan(plan, { execute: a.execute, vars: { tool: "hello" } });
    // Sur cette machine le confinement dépend de jarod-sandbox : les deux issues sont admises, la troisième (lancé sans protection) ne l'est pas.
    if (res.ok) expect(a.audit.some((e) => e.tool === "run_shell" && e.ok === true)).toBe(true);
    else expect(res.error).toMatch(/isolation|confin|sandbox|retenue|refus/i);
  });
});
