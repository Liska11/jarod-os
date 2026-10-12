// Portage de packages/core/test/loop-guards.test.ts (rév. 2e180305).
import { describe, expect, it, vi } from "vitest";
import { LoopGuardService } from "../src/loop-guards.js";

describe("garde-fou de répétition", () => {
  it("laisse passer les premiers appels, puis rappelle au modèle qu'il tourne en rond", () => {
    const guard = new LoopGuardService({ repeatThreshold: 3 });
    expect(guard.observe("read_file", { path: "a.ts" }).reminder).toBeNull();
    expect(guard.observe("read_file", { path: "a.ts" }).reminder).toBeNull();
    const third = guard.observe("read_file", { path: "a.ts" });
    expect(third.count).toBe(3);
    expect(third.reminder).toMatch(/read_file 3 fois/);
    expect(third.reminder).toMatch(/Change d'approche/);
  });

  it("l'ordre des clés ne fait pas deux appels différents", () => {
    const guard = new LoopGuardService({ repeatThreshold: 2 });
    expect(guard.observe("run_shell", { cmd: "ls", cwd: "/s" }).reminder).toBeNull();
    // Même appel, écrit autrement : un garde-fou qui ne le verrait pas ne verrait rien.
    expect(guard.observe("run_shell", { cwd: "/s", cmd: "ls" }).reminder).not.toBeNull();
  });

  it("un autre outil, ou d'autres arguments, repart de zéro", () => {
    const guard = new LoopGuardService({ repeatThreshold: 2 });
    guard.observe("read_file", { path: "a.ts" });
    expect(guard.observe("read_file", { path: "b.ts" }).reminder).toBeNull();
    expect(guard.observe("write_file", { path: "a.ts" }).reminder).toBeNull();
  });

  it("un nouveau tour efface la mémoire du précédent", () => {
    const guard = new LoopGuardService({ repeatThreshold: 2 });
    guard.observe("read_file", { path: "a.ts" });
    guard.reset();
    expect(guard.observe("read_file", { path: "a.ts" }).reminder).toBeNull();
    expect(guard.seen()).toHaveLength(1);
  });
});

describe("garde-fou de délai", () => {
  it("un outil qui ne rend jamais la main devient une erreur lisible, pas un tour bloqué", async () => {
    const guard = new LoopGuardService();
    await expect(guard.guard("lent", () => new Promise(() => {}), 30)).rejects.toThrow(/TOOL_TIMEOUT: lent/);
  });

  it("interrompt l'outil en cours, pour qu'il ne travaille pas dans le vide", async () => {
    const guard = new LoopGuardService();
    const onAbort = vi.fn();
    await expect(
      guard.guard(
        "lent",
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              onAbort();
              reject(new Error("aborted"));
            });
          }),
        30,
      ),
    ).rejects.toThrow(/TOOL_TIMEOUT/);
    expect(onAbort).toHaveBeenCalled();
  });

  it("un outil qui répond à temps passe intact, et son résultat n'est pas transformé", async () => {
    const guard = new LoopGuardService({ callTimeoutMs: 1000 });
    await expect(guard.guard("rapide", async () => ({ ok: 42 }))).resolves.toEqual({ ok: 42 });
  });
});
