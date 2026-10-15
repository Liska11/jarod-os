// Portage de packages/core/test/subagents.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { SubagentsService } from "../src/subagents.js";

function deferred() {
  let settle: (value: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

describe("sous-agents tenus et comptés", () => {
  it("borne le nombre d'exécutions simultanées, et refuse lisiblement au-delà", async () => {
    const service = new SubagentsService({ maxConcurrent: 1 });
    const first = deferred();
    const running = service.run("tâche 1", "s1", () => first.promise);
    expect(service.running()).toBe(1);

    await expect(service.run("tâche 2", "s1", async () => "jamais")).rejects.toThrow(/SUBAGENT_LIMIT/);
    // Le refus ne doit pas laisser de trace fantôme : une seule exécution existe.
    expect(service.list()).toHaveLength(1);

    first.settle("fini");
    await expect(running).resolves.toBe("fini");
    expect(service.running()).toBe(0);
  });

  it("journalise ce qui a tourné, combien de temps, et ce que ça a rendu", async () => {
    const service = new SubagentsService({ now: () => 5_000 });
    await service.run("explore le dépôt", "s1", async () => "compte rendu");
    const [run] = service.list();
    expect(run).toMatchObject({
      status: "done",
      task: "explore le dépôt",
      chars: 12,
      startedAt: 5_000,
      endedAt: 5_000,
    });
  });

  it("garde l'erreur d'un échec au lieu de la perdre", async () => {
    const service = new SubagentsService();
    await expect(
      service.run("tâche qui casse", "s1", async () => {
        throw new Error("le fournisseur a refusé");
      }),
    ).rejects.toThrow(/refusé/);
    expect(service.list().at(0)).toMatchObject({ status: "failed", error: "le fournisseur a refusé" });
  });

  it("arrête une exécution en cours, et distingue un arrêt voulu d'une panne", async () => {
    const service = new SubagentsService();
    let seen: AbortSignal | null = null;
    const started = service.run(
      "longue tâche",
      "s1",
      (_task, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const id = service.list().at(0)?.id as string;
    expect(service.cancel(id)).toBe(true);
    await expect(started).rejects.toThrow();
    expect(service.get(id)).toMatchObject({ status: "cancelled", error: null });
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    // Arrêter une exécution déjà finie rend false : ça ne relance rien, et ça le dit.
    expect(service.cancel(id)).toBe(false);
  });

  it("l'annulation de l'appelant se propage à l'exécution", async () => {
    const service = new SubagentsService();
    const outer = new AbortController();
    const started = service.run(
      "tâche",
      "s1",
      (_task, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      outer.signal,
    );
    outer.abort();
    await expect(started).rejects.toThrow();
    expect(service.get(service.list().at(0)?.id as string)?.status).toBe("cancelled");
  });

  it("un journal borné : il informe, il n'archive pas", async () => {
    const service = new SubagentsService({ journalLimit: 3 });
    for (let i = 0; i < 5; i += 1) await service.run(`tâche ${i}`, "s1", async () => "ok");
    expect(service.list()).toHaveLength(3);
    expect(service.list().at(0)?.task).toBe("tâche 4");
  });

  it("cancelAll() arrête toutes les exécutions lancées sans signal d'appelant (Q18, R3.5)", async () => {
    const service = new SubagentsService({ maxConcurrent: 3 });
    const signals: AbortSignal[] = [];
    const run = (task: string) =>
      service.run(
        task,
        "s1",
        (_task, signal) =>
          new Promise((_resolve, reject) => {
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
    const a = run("a");
    const b = run("b");
    await Promise.resolve();
    expect(service.running(), "deux exécutions en vol").toBe(2);

    // L'arrêt du noyau ne peut pas dépendre d'un signal d'appelant qu'aucun n'a fourni.
    service.cancelAll();
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(service.running()).toBe(0);
  });

  it("dit son plafond : un écran doit pouvoir expliquer un refus (« 3 sur 3 »)", async () => {
    expect(new SubagentsService().limit()).toBe(3);
    const serre = new SubagentsService({ maxConcurrent: 1 });
    expect(serre.limit()).toBe(1);
    // Et le plafond ANNONCÉ est bien celui qui refuse : sinon la vue mentirait sur la cause du refus.
    await serre.run("la seule", "s1", async () => "ok");
    const occupe = serre.run("la suivante", "s1", () => new Promise<string>(() => {}));
    await Promise.resolve();
    expect(serre.running()).toBe(1);
    await expect(serre.run("en trop", "s1", async () => "jamais")).rejects.toThrow(/SUBAGENT_LIMIT: 1/);
    void occupe;
  });
});
