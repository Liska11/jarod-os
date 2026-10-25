/**
 * Vue GitHub : validation des arguments avant tout appel à gh. Les appels réels exigent un dépôt et un compte gh.
 */
import { describe, expect, it } from "vitest";
import { createPull, listIssues, listPulls, viewPull } from "../src/github.js";

describe("validation avant gh", () => {
  it("refuse un dépôt qui n'est pas « propriétaire/nom »", async () => {
    await expect(listPulls({ repo: "a;rm -rf" })).rejects.toThrow(/dépôt GitHub refusé/);
    await expect(listIssues({ repo: "seulement-un-nom" })).rejects.toThrow(/dépôt GitHub refusé/);
  });

  it("refuse un état ou une limite hors bornes", async () => {
    await expect(listPulls({ state: "supprimé" })).rejects.toThrow(/état refusé/);
    await expect(listPulls({ limit: 0 })).rejects.toThrow(/limite/);
    await expect(listPulls({ limit: 1000 })).rejects.toThrow(/limite/);
  });

  it("refuse un numéro de PR invalide", async () => {
    await expect(viewPull(0)).rejects.toThrow(/numéro refusé/);
    await expect(viewPull(1.5)).rejects.toThrow(/numéro refusé/);
  });

  it("refuse une PR sans titre, une branche suspecte, ou une description trop longue", async () => {
    await expect(createPull({ title: "  ", body: "" })).rejects.toThrow(/titre vide/);
    await expect(createPull({ title: "ok", body: "", base: "-x" })).rejects.toThrow(/nom de branche refusé/);
    await expect(createPull({ title: "ok", body: "x".repeat(70_000) })).rejects.toThrow(/trop longue/);
  });
});
