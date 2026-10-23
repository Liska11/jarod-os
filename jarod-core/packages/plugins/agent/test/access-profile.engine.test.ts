// V-09 — les profils d'accès sur la boucle RÉELLE (kernel, porte d'outils, journal), dans un dossier de travail jetable. `run_shell` n'est
// jamais accordé ici : on voit seulement que l'accord est DEMANDÉ (limite dure), rien n'est exécuté.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, PermissionRule } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { planGrant } from "@jarod/plugin-permissions";
import { describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

async function boot(settings: Record<string, unknown>) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  const core = (await bootApp(plugins)).agent;
  const workspace = tempDir();
  core.settings.set("autoTitle", false);
  core.settings.set("workspace", workspace);
  for (const [k, v] of Object.entries(settings)) core.settings.set(k as never, v as never);
  let next: { name: string; args: Record<string, unknown> } | null = null;
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.at(-1)?.role === "tool" || !next
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: `t${Date.now()}${Math.random()}`, ...next }], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  /** Un appel dans une conversation neuve : le nombre d'accords demandés (toujours refusés) et la dernière ligne du journal. */
  const call = async (name: string, args: Record<string, unknown>) => {
    next = { name, args };
    const s = core.sessions.create().id;
    let asked = 0;
    await core.runAndWait(s, "fais-le", {
      emit: () => {},
      approve: async () => {
        asked++;
        return false;
      },
    });
    const audit = core.auditOf(s).at(-1);
    return { asked, decision: audit?.decision };
  };
  return { core, call, workspace };
}

describe("V-09 — profils d'accès, boucle réelle", () => {
  it("Plein : une écriture passe sans accord (journalisée « automatique ») ; run_shell, limite dure, demande quand même", async () => {
    const { call, workspace } = await boot({ accessProfile: "full" });
    expect(await call("write_file", { path: join(workspace, "plein.txt"), content: "ok" })).toEqual({ asked: 0, decision: "automatique" });
    expect(existsSync(join(workspace, "plein.txt"))).toBe(true);
    expect(await call("run_shell", { command: "echo jamais" })).toEqual({ asked: 1, decision: "refusé" });
  });

  it("Plein ne lève pas un refus de règle : refusé sans même demander", async () => {
    const { core, call, workspace } = await boot({ accessProfile: "full" });
    core.settings.set("permissionsRules", planGrant([], { tool: "write_file", decision: "deny" }, Date.now()).rules as PermissionRule[]);
    expect(await call("write_file", { path: join(workspace, "non.txt"), content: "x" })).toEqual({ asked: 0, decision: "refusé (règle)" });
    expect(existsSync(join(workspace, "non.txt"))).toBe(false);
  });

  it("Demander : même une lecture demande ; une règle « sans accord » ne joue pas", async () => {
    const { core, call, workspace } = await boot({ accessProfile: "ask" });
    expect((await call("list_dir", { path: workspace })).asked).toBe(1);
    core.settings.set("permissionsRules", planGrant([], { tool: "write_file", decision: "allow", autonomous: true, target: `${workspace}${process.platform === "win32" ? "\\" : "/"}*` }, Date.now()).rules as PermissionRule[]);
    expect(await call("write_file", { path: join(workspace, "a.txt"), content: "x" })).toEqual({ asked: 1, decision: "refusé" });
    expect(existsSync(join(workspace, "a.txt"))).toBe(false);
  });

  it("M'approuver : l'interrupteur global « sans demander » est ignoré ; une lecture passe", async () => {
    const { call, workspace } = await boot({ accessProfile: "approve", autoApproveTools: true });
    expect((await call("write_file", { path: join(workspace, "b.txt"), content: "x" })).asked).toBe(1);
    expect((await call("list_dir", { path: workspace })).asked).toBe(0);
  });

  it("Personnalisé (défaut) : le comportement d'avant — l'interrupteur global dispense d'accord", async () => {
    const { core, call, workspace } = await boot({ autoApproveTools: true });
    expect(core.settings.get("accessProfile")).toBe("custom");
    expect((await call("write_file", { path: join(workspace, "c.txt"), content: "x" })).asked).toBe(0);
  });
});
