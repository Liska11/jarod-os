/**
 * Interrupteur Internet : la porte unique des outils refuse hors ligne ce qui sort par Internet ou lance un programme non isolable,
 * AVANT toute demande d'accord (un « oui » ne suffit pas), et le refus est audité. Politique injectée, aucun réseau.
 */
import type { ToolCall } from "@jarod/contracts";
import { DEFAULT_POLICY, setActivePolicy } from "@jarod/kernel/network";
import { DEFAULT_SETTINGS, type Settings } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditEntry, executeGuardedTool } from "../src/agent.js";
import { makeCore, tempDir } from "./helpers.js";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "t1", name, args });

describe("porte des outils hors ligne", () => {
  afterEach(() => setActivePolicy(null));

  it("refuse web_fetch et run_shell sans demander l'accord, et l'audite", async () => {
    setActivePolicy(() => ({ ...DEFAULT_POLICY, internet: false }));
    const core = await makeCore();
    const audit: AuditEntry[] = [];
    let asked = 0;
    for (const c of [call("web_fetch", { url: "https://example.com" }), call("run_shell", { command: "curl https://example.com" })]) {
      const r = await executeGuardedTool(
        core.tools,
        "s1",
        c,
        new AbortController().signal,
        {
          approve: async () => {
            asked++;
            return true;
          },
        },
        { ...DEFAULT_SETTINGS, workspace: tempDir() } as Settings,
        { gate: { decide: () => "allow" as const }, audit: (e) => audit.push(e) },
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/Internet est désactivé/);
    }
    expect(asked).toBe(0);
    expect(audit.map((e) => [e.tool, e.decision])).toEqual([
      ["web_fetch", "refusé (règle)"],
      ["run_shell", "refusé (règle)"],
    ]);
  });

  it("garde les outils locaux hors ligne", async () => {
    setActivePolicy(() => ({ ...DEFAULT_POLICY, internet: false }));
    const core = await makeCore();
    const r = await executeGuardedTool(core.tools, "s1", call("list_dir", { path: "." }), new AbortController().signal, { approve: async () => true }, { ...DEFAULT_SETTINGS, workspace: tempDir() } as Settings, {
      gate: { decide: () => "allow" as const },
    });
    expect(r.content).not.toMatch(/Internet est désactivé/);
  });
});
