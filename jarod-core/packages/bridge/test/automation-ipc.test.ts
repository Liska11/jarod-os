/**
 * AV2-007 — les six canaux `automation-*` : un VRAI kernel derrière les VRAIS handlers. Une entrée IPC est validée
 * (jamais castée), un cron illisible est refusé à l'écriture, le résultat de `automation-run` dit ce qui s'est passé.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

const VALIDE = { name: "rapport", trigger: { kind: "schedule", cron: "0 8 * * *" }, actions: [{ type: "notify", title: "T", body: "b" }] };

describe("canaux automation-*", () => {
  it("aller-retour : create, list, get, update, delete", async () => {
    const { call } = await setupKernel();
    const rule = (await call("automation-create", VALIDE)) as { id: string; enabled: boolean };
    expect(rule.enabled).toBe(true);
    expect(((await call("automation-list")) as { rules: unknown[] }).rules).toHaveLength(1);
    expect(await call("automation-get", rule.id)).toMatchObject({ name: "rapport" });
    expect(await call("automation-update", rule.id, { name: "autre", enabled: false })).toMatchObject({ name: "autre", enabled: false });
    expect(await call("automation-delete", rule.id)).toBe(true);
    expect(await call("automation-get", rule.id)).toBeNull();
  });

  it("entrée mal formée : refusée avec le chemin fautif (nom vide, déclencheur inconnu, aucune action, mode inconnu)", async () => {
    const { call, kernel } = await setupKernel();
    await rejects(() => call("automation-create", { ...VALIDE, name: "" }), /name/);
    await rejects(() => call("automation-create", { ...VALIDE, trigger: { kind: "telepathie" } }), /trigger/);
    await rejects(() => call("automation-create", { ...VALIDE, actions: [] }), /actions/);
    await rejects(() => call("automation-create", { ...VALIDE, actions: [{ type: "agent", prompt: "x", mode: "dieu" }] }), /mode/);
    await rejects(() => call("automation-create", null), /entrée invalide/);
    expect(kernel.automation!.list()).toEqual([]);
  });

  it("mise à jour mal formée : refusée, la règle reste intacte", async () => {
    const { call } = await setupKernel();
    const rule = (await call("automation-create", VALIDE)) as { id: string };
    await rejects(() => call("automation-update", rule.id, { enabled: "oui" }), /enabled/);
    await rejects(() => call("automation-update", rule.id, { actions: [{ type: "agent" }] }), /actions/);
    expect(await call("automation-get", rule.id)).toMatchObject({ name: "rapport", enabled: true });
  });

  it("un cron illisible est refusé à l'écriture, à la création comme à la mise à jour", async () => {
    const { call, kernel } = await setupKernel();
    await rejects(() => call("automation-create", { ...VALIDE, trigger: { kind: "schedule", cron: "pas un cron" } }), /cron invalide/);
    expect(kernel.automation!.list()).toEqual([]);
    const rule = (await call("automation-create", VALIDE)) as { id: string };
    await rejects(() => call("automation-update", rule.id, { trigger: { kind: "schedule", cron: "99 99 * * *" } }), /cron invalide/);
    expect(kernel.automation!.get(rule.id)!.trigger).toEqual({ kind: "schedule", cron: "0 8 * * *" });
  });

  it("automation-run : règle introuvable ou désactivée ⇒ ok:false avec la raison ; règle valide ⇒ ok:true", async () => {
    const { call } = await setupKernel();
    expect(await call("automation-run", "inconnue")).toMatchObject({ ok: false, error: expect.stringContaining("introuvable") });
    const rule = (await call("automation-create", { ...VALIDE, enabled: false })) as { id: string };
    expect(await call("automation-run", rule.id)).toMatchObject({ ok: false, error: expect.stringContaining("désactivée") });
    await call("automation-update", rule.id, { enabled: true });
    expect(await call("automation-run", rule.id)).toMatchObject({ ok: true });
    await rejects(() => call("automation-run", 42), /id invalide/);
  });
});
