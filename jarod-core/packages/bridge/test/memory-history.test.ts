/**
 * V-18 — historique de la mémoire par les vrais handlers sur un VRAI kernel : lire, rétablir un souvenir retiré par l'écran, refus des
 * entrées mal formées ; l'effacement passe par la confirmation native (refusée : rien n'est effacé ; acceptée : l'historique est vide).
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

type Change = { seq: number; memoryId: string; action: string; before?: { content: string }; after?: { content: string } };

describe("V-18 — memory-history / memory-restore / memory-history-purge", () => {
  it("un souvenir ajouté puis retiré par l'écran se lit dans l'historique et revient tel quel", async () => {
    const { call } = await setupKernel();
    await call("add-memory-entry", "Le dépôt est sur D:");
    await call("remove-memory-entry", 0);
    const history = (await call("memory-history")) as Change[];
    expect(history.map((c) => c.action)).toEqual(["delete", "add"]);
    expect(history[0]!.before?.content).toBe("Le dépôt est sur D:");

    expect(await call("memory-restore", history[0]!.seq)).toMatchObject({ did: "recreated", memoryId: history[0]!.memoryId });
    const read = (await call("read-memory")) as { memory: { entries: { content: string }[] } };
    expect(read.memory.entries.map((e) => e.content)).toEqual(["Le dépôt est sur D:"]);
    expect(((await call("memory-history", history[0]!.memoryId)) as Change[]).map((c) => c.action)).toEqual(["add", "delete", "add"]);
  }, 60_000);

  it("refus : identifiant ou changement mal formés", async () => {
    const { call } = await setupKernel();
    await expect(async () => call("memory-history", "../x")).rejects.toThrow(/souvenir invalide/);
    await expect(async () => call("memory-restore", "1")).rejects.toThrow(/changement invalide/);
    await expect(async () => call("memory-restore", 0)).rejects.toThrow(/changement invalide/);
    await expect(async () => call("memory-restore", 424242)).rejects.toThrow(/inconnu/);
  }, 60_000);

  it("effacer : confirmation native refusée → rien ; acceptée → l'historique est vide, les souvenirs restent", async () => {
    let answer = false;
    const { call, confirms } = await setupKernel(undefined, [], { confirm: async () => answer });
    await call("add-memory-entry", "A");
    expect(await call("memory-history-purge")).toBe(false);
    expect(confirms.at(-1)).toMatchObject({ action: "Effacer" });
    expect((await call("memory-history")) as Change[]).toHaveLength(1);
    answer = true;
    expect(await call("memory-history-purge")).toEqual({ purged: 1 });
    expect(await call("memory-history")).toEqual([]);
    expect(((await call("read-memory")) as { memory: { entries: unknown[] } }).memory.entries).toHaveLength(1);
  }, 60_000);
});
