// G13 — raccordement : l'outil `system_diagnostics` (plugin integrations, osquery réel) passe par la porte unique de la boucle réelle,
// sans accord (lecture seule) mais avec sa ligne d'audit ; une règle deny l'arrête ; Internet coupé ne l'arrête pas (aucun réseau).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatRequest } from "@jarod/contracts";
import { DEFAULT_POLICY, setActivePolicy } from "@jarod/kernel/network";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

const ROOT = resolve(__dirname, "../../../../..");
const BIN = join(ROOT, "engines", "osquery", "osqueryi.exe");
const has = existsSync(BIN);
if (!has) console.warn(`[moteurs] ${BIN} absent : le raccordement osquery est ignoré`);
afterEach(() => {
  setActivePolicy(null);
  delete process.env.JAROD_OSQUERYI;
});

async function boot(rules: { tool: string; decision: "allow" | "ask" | "deny" }[]) {
  process.env.JAROD_OSQUERYI = BIN;
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  plugins.permissions = { rules };
  const core = (await bootApp(plugins)).agent;
  core.settings.set("autoTitle", false);
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: "t1", name: "system_diagnostics", args: { query: "disks" } }], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  return core;
}

describe.skipIf(!has)("G13 — system_diagnostics dans la boucle réelle", () => {
  it("sans accord, Internet coupé : le diagnostic tourne, son résultat entre dans la conversation, la ligne d'audit est écrite", async () => {
    setActivePolicy(() => ({ ...DEFAULT_POLICY, internet: false }));
    const core = await boot([]);
    expect(core.tools.get("system_diagnostics")).toBeTruthy();
    const s = core.sessions.create();
    let asked = 0;
    await core.runAndWait(s.id, "combien d'espace disque ?", {
      emit: () => {},
      approve: async () => {
        asked++;
        return true;
      },
    });
    const tool = core.messages.list(s.id).find((m) => m.role === "tool");
    expect(tool?.isError).not.toBe(true);
    expect(String(tool?.content)).toMatch(/lecteurs, taille et espace libre — \d+ ligne/);
    expect(asked).toBe(0);
    expect(core.auditLog(10).find((a) => a.tool === "system_diagnostics")).toMatchObject({ decision: "automatique", ok: true });
  }, 90_000);

  it("règle deny : refusé avant exécution, et audité", async () => {
    const core = await boot([{ tool: "system_diagnostics", decision: "deny" }]);
    const s = core.sessions.create();
    await core.runAndWait(s.id, "diagnostic", { emit: () => {}, approve: async () => true });
    const tool = core.messages.list(s.id).find((m) => m.role === "tool");
    expect(tool).toMatchObject({ isError: true, content: expect.stringMatching(/politique de permissions/) });
    expect(core.auditLog(10).find((a) => a.tool === "system_diagnostics")).toMatchObject({ decision: "refusé (règle)" });
  }, 90_000);
});
