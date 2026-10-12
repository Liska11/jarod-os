/**
 * H4 (audit v4 § 1) — un tour d'agent doit TOUJOURS se terminer, même si un plugin lève.
 *
 * Avant correctif, le préambule du tour (`plugins.beforeSend`, `messages.add`, `settingsFor`,
 * `buildSystemPrompt`) était exécuté AVANT le `try` dont le `finally` émet `done`. Une exception là :
 *  - `runAndWait` ne se résolvait JAMAIS — tâche planifiée, automation ou webhook bloqués pour toujours,
 *    écran figé en « génération » ;
 *  - et `runtime.ts` lançait le tour en `void … .finally(release)` : le rejet devenait non géré, ce qui
 *    arrête le processus sous Node (`jarod serve`).
 *
 * VRAI cœur (kernel réel), client de modèle remplacé.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeCore } from "./helpers.js";

afterEach(() => {
  /* les cœurs sont libérés par le helper (afterEach de helpers.ts) */
});

/** Un client de modèle qui répond toujours, et un titre automatique désactivé (il ferait un 2e appel). */
function answer(core: Awaited<ReturnType<typeof makeCore>>) {
  core.providers.client = () =>
    ({
      chat: async () => ({ text: "ok", thinking: "", toolCalls: [], stopReason: "stop" }),
      listModels: async () => [],
    }) as never;
  core.settings.set("autoTitle", false);
}

/** Le plugin en panne : `beforeSend` lève, comme un plugin de plugins tiers défectueux. */
const brokenPlugins = () => ({
  beforeSend: () => {
    throw new Error("plugin en panne");
  },
  afterResponse() {},
  list: () => [],
});

describe("H4 — le préambule du tour est couvert : le tour se termine toujours", () => {
  it("`runAndWait` rend la main (au lieu de rester bloqué) et rapporte la panne", async () => {
    const core = await makeCore();
    answer(core);
    core.attachPlugins(brokenPlugins());
    const sid = core.sessions.create().id;
    const events: { type: string; error?: string }[] = [];

    const r = await Promise.race([
      core.runAndWait(sid, "salut", { emit: (e) => events.push(e as never), approve: async () => false }),
      new Promise((res) => setTimeout(() => res("BLOQUÉ"), 2000)),
    ]);

    expect(r, "le tour doit se terminer").not.toBe("BLOQUÉ");
    expect(r).toMatchObject({ error: "plugin en panne" });
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(events[0]!.error).toBe("plugin en panne");
    expect(core.isRunning(sid), "la conversation n'est plus occupée").toBe(false);
    await core.dispose();
  });

  it("`start()` ne laisse AUCUN rejet non géré (sous Node, il arrêtait `jarod serve`)", async () => {
    const seen: unknown[] = [];
    const onRejection = (r: unknown) => seen.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      const core = await makeCore();
      answer(core);
      core.attachPlugins(brokenPlugins());
      const sid = core.sessions.create().id;
      core.start(sid, "salut", { emit: () => {}, approve: async () => false });
      await new Promise((r) => setTimeout(r, 400));
      expect(seen).toEqual([]);
      expect(core.isRunning(sid)).toBe(false);
      await core.dispose();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("un tour normal continue de fonctionner (le correctif ne casse rien)", async () => {
    const core = await makeCore();
    answer(core);
    const sid = core.sessions.create().id;
    const r = await core.runAndWait(sid, "salut", { emit: () => {}, approve: async () => false });
    expect(r).toEqual({ text: "ok" });
    await core.dispose();
  });
});