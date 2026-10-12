/**
 * SPECS-P5-UI-PARITE.md §3.2 — plugins utilisateur : activation et confiance depuis l'écran, derrière des boîtes natives. VRAI kernel, vrai
 * processus de plugin (le plugin d'exemple « des », lancé isolé).
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

type View = { id: string; name: string; enabled: boolean; state: string; tools: string[]; trusted: string[]; permissions: string[]; digest: string };
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

async function withPlugin(confirmAnswers: boolean[] = []) {
  const k = await setupKernel(undefined, confirmAnswers);
  await k.app.pluginHost!.seed();
  await k.app.pluginHost!.reload();
  return k;
}

describe("plugins utilisateur", () => {
  it("liste : le plugin d'exemple, actif, outils non classés, empreinte courte, aucun chemin", async () => {
    const { call, app } = await withPlugin();
    const list = (await call("plugins-list")) as View[];
    const des = list.find((p) => p.id === "des")!;
    expect(des).toMatchObject({ name: "Lanceur de dés", enabled: true, state: "active", trusted: [] });
    expect(des.tools.length).toBeGreaterThan(0);
    expect(des.permissions).toEqual(expect.arrayContaining(["tools"]));
    expect(des.digest).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(list)).not.toMatch(/index\.js|plugin\.json|[A-Z]:\\/);
    await app.pluginHost!.unloadAll();
  });

  it("désactiver ne demande rien ; ACTIVER demande une boîte native (nom, surfaces, empreinte) ; refusée, le plugin reste coupé", async () => {
    const { call, app, confirms } = await withPlugin([false, true]);
    const off = (await call("plugin-set-enabled", "des", false)) as View[];
    expect(off.find((p) => p.id === "des")).toMatchObject({ enabled: false, state: "disabled" });
    expect(confirms).toHaveLength(0);
    await rejects(() => call("plugin-set-enabled", "des", true), /refusé par l'utilisateur/);
    expect(app.agent.settings.get("disabledPlugins")).toContain("des");
    expect(confirms[0]!.message).toMatch(/Activer le plugin « Lanceur de dés »/);
    expect(confirms[0]!.detail).toMatch(/Surfaces demandées : .*tools/);
    expect(confirms[0]!.detail).toMatch(/Empreinte du contenu : [0-9a-f]{12}/);
    const on = (await call("plugin-set-enabled", "des", true)) as View[];
    expect(on.find((p) => p.id === "des")).toMatchObject({ enabled: true, state: "active" });
    await app.pluginHost!.unloadAll();
  });

  it("classer « sans accord » : boîte native qui nomme les outils et l'empreinte ; refusée = rien ; retirer le classement ne demande rien", async () => {
    const { call, app, confirms } = await withPlugin([false, true]);
    const tool = ((await call("plugins-list")) as View[]).find((p) => p.id === "des")!.tools[0]!;
    await rejects(() => call("plugin-set-trust", "des", [], true), /refusé par l'utilisateur/);
    expect(app.agent.settings.get("pluginTrust")).toEqual({});
    expect(confirms[0]!.detail).toContain(tool);
    expect(confirms[0]!.detail).toMatch(/SANS vous demander/);
    const trusted = (await call("plugin-set-trust", "des", [], true)) as View[];
    expect(trusted.find((p) => p.id === "des")!.trusted).toContain(tool);
    expect(app.agent.tools.get(tool)!.dangerous).toBe(false);
    const back = (await call("plugin-set-trust", "des", [], false)) as View[];
    expect(back.find((p) => p.id === "des")!.trusted).toEqual([]);
    expect(app.agent.tools.get(tool)!.dangerous).toBe(true);
    expect(confirms).toHaveLength(2);
    await app.pluginHost!.unloadAll();
  });

  it("validation : identifiant inconnu ou non texte, types invalides, plugin inactif ; jamais de chemin", async () => {
    const { call, app } = await withPlugin([true]);
    await rejects(() => call("plugin-set-enabled", "inconnu", true), /plugin inconnu/);
    await rejects(() => call("plugin-set-enabled", 7, true), /identifiant attendu/);
    await rejects(() => call("plugin-set-enabled", "des", "oui"), /attendu/);
    await rejects(() => call("plugin-set-enabled", "..\\..\\evil", true), /plugin inconnu/);
    await rejects(() => call("plugin-set-trust", "des", "tous", true), /attendu/);
    await rejects(() => call("plugin-set-trust", "des", ["inconnu"], false), /Outil inconnu/);
    await call("plugin-set-enabled", "des", false);
    await rejects(() => call("plugin-set-trust", "des", [], false), /inactif/);
    await app.pluginHost!.unloadAll();
  });
});
