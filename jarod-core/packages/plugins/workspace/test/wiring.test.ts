/**
 * Le plugin est découvert et démarré par le noyau réel : ses quatre outils sont dans le registre, et ils sortent
 * du registre quand le plugin s'arrête.
 */
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const TOOLS = ["worktree_create", "worktree_diff", "worktree_merge", "cli_agent_run"];

describe("plugin-workspace dans le noyau", () => {
  it("enregistre ses outils dans le registre d'outils", async () => {
    const app = (await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, memory: {}, llm: {}, skills: {}, skillsHub: {}, rag: {}, tools: {}, workspace: {} })) as unknown as {
      tools: { registry: { get(name: string): { dangerous?: boolean } | undefined } };
    };
    for (const name of TOOLS) expect(app.tools.registry.get(name), name).toBeDefined();
    expect(app.tools.registry.get("worktree_diff")?.dangerous).toBeFalsy();
    for (const name of ["worktree_create", "worktree_merge", "cli_agent_run"]) {
      expect(app.tools.registry.get(name)?.dangerous, name).toBe(true);
    }
  });

  it("retire ses outils à l'arrêt du plugin", async () => {
    const app = (await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, memory: {}, llm: {}, skills: {}, skillsHub: {}, rag: {}, tools: {}, workspace: {} })) as unknown as {
      tools: { registry: { get(name: string): unknown } };
    };
    // Cordis retire les services à l'arrêt : on garde le registre avant de couper le noyau.
    const registry = app.tools.registry;
    await shutdown(app as unknown as { started: never });
    expect(registry.get("worktree_create")).toBeUndefined();
  });
});


