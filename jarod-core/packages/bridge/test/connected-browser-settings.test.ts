/**
 * E2 — le navigateur connecté dans les réglages : ÉTEINT et sans domaine par défaut ; activer, ajouter un domaine ou retirer une interdiction
 * AFFAIBLIT (boîte native qui nomme les domaines) ; fermer ou retirer un domaine durcit (aucune boîte) ; rien d'invalide n'est écrit.
 * VRAI kernel, VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

type Eff = { enabled: boolean; allowDomains: string[]; denyDomains: string[] };
const eff = async (call: (c: string, ...a: unknown[]) => unknown) => ((await call("get-jarod-settings")) as { connectedBrowser: Eff }).connectedBrowser;
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

describe("navigateur connecté (E2) : réglage", () => {
  it("PAR DÉFAUT : éteint et aucun domaine", async () => {
    const { call } = await setupKernel();
    expect(await eff(call)).toEqual({ enabled: false, allowDomains: [], denyDomains: [] });
  });

  it("une installation sans le réglage est lue comme éteinte et vide (réglage absent du profil)", async () => {
    const { call, app } = await setupKernel();
    app.agent.settings.set("connectedBrowser", {});
    expect(await eff(call)).toEqual({ enabled: false, allowDomains: [], denyDomains: [] });
  });

  it("ACTIVER ou AJOUTER un domaine demande une boîte native qui le NOMME ; refusée, rien n'est écrit ; acceptée, c'est écrit", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true, true]);
    await rejects(() => call("set-jarod-settings", { connectedBrowser: { enabled: true, allowDomains: ["exemple.org"] } }), /refusé par l'utilisateur/);
    expect(await eff(call)).toEqual({ enabled: false, allowDomains: [], denyDomains: [] });
    expect(confirms[0]!.message).toMatch(/navigateur connecté/i);
    expect(confirms[0]!.detail).toContain("exemple.org");
    expect(confirms[0]!.detail).toMatch(/chaque action.*accord/i);
    await call("set-jarod-settings", { connectedBrowser: { enabled: true, allowDomains: ["exemple.org"] } });
    expect(app.agent.settings.get("connectedBrowser")).toMatchObject({ enabled: true, allowDomains: ["exemple.org"] });
    await call("set-jarod-settings", { connectedBrowser: { allowDomains: ["exemple.org", "docs.autre.net"] } });
    expect(confirms[2]!.detail).toContain("docs.autre.net");
  });

  it("DURCIR ne demande rien : éteindre, retirer un domaine, ajouter une interdiction", async () => {
    const { call, app, confirms } = await setupKernel();
    app.agent.settings.set("connectedBrowser", { enabled: true, allowDomains: ["exemple.org", "autre.net"], denyDomains: [] });
    await call("set-jarod-settings", { connectedBrowser: { allowDomains: ["exemple.org"], denyDomains: ["pub.exemple.org"] } });
    await call("set-jarod-settings", { connectedBrowser: { enabled: false } });
    expect(confirms).toHaveLength(0);
    expect(await eff(call)).toEqual({ enabled: false, allowDomains: ["exemple.org"], denyDomains: ["pub.exemple.org"] });
  });

  it("retirer une interdiction affaiblit : boîte qui la nomme", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [true]);
    app.agent.settings.set("connectedBrowser", { enabled: false, allowDomains: [], denyDomains: ["pub.exemple.org"] });
    await call("set-jarod-settings", { connectedBrowser: { denyDomains: [] } });
    expect(confirms[0]!.detail).toContain("pub.exemple.org");
  });

  it("les listes sont nettoyées : espaces, casse, doublons", async () => {
    const { call } = await setupKernel(undefined, [true]);
    await call("set-jarod-settings", { connectedBrowser: { enabled: true, allowDomains: [" Exemple.ORG ", "exemple.org"] } });
    expect((await eff(call)).allowDomains).toEqual(["exemple.org"]);
  });

  it("validation : jokers, étiquette seule, IP, port, chemin, schéma, types, clés inconnues — refus sans écriture partielle", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.getAll();
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ allowDomains: ["*"] }, /domaine complet/],
      [{ allowDomains: ["*.exemple.org"] }, /domaine complet/],
      [{ allowDomains: ["com"] }, /domaine complet/],
      [{ allowDomains: ["localhost"] }, /domaine complet/],
      [{ allowDomains: ["192.168.1.10"] }, /adresse IP/],
      [{ allowDomains: ["127.0.0.1"] }, /adresse IP/],
      [{ allowDomains: ["exemple.org:8080"] }, /domaine complet/],
      [{ allowDomains: ["exemple.org/chemin"] }, /domaine complet/],
      [{ allowDomains: ["https://exemple.org"] }, /domaine complet/],
      [{ denyDomains: ["*"] }, /domaine complet/],
      [{ allowDomains: "exemple.org" }, /liste attendue/],
      [{ allowDomains: Array.from({ length: 101 }, (_, i) => `d${i}.exemple.org`) }, /100 entrées/],
      [{ enabled: "oui" }, /booléen/],
      [{ profil: "C:/Users" }, /inconnue/],
      [{ chrome: "x" }, /inconnue/],
    ];
    for (const [patch, why] of bad) await rejects(() => call("set-jarod-settings", { agentMode: "plan", connectedBrowser: patch }), why);
    expect(app.agent.settings.getAll()).toEqual(before);
  });

  it("le réglage ne peut PAS désigner de profil, de chemin de navigateur ni de moteur : aucune clé pour cela", async () => {
    const { call } = await setupKernel();
    for (const k of ["profile", "profilePath", "userDataDir", "chromePath", "cdpUrl", "python", "bridge", "approve", "autoApprove"]) {
      await rejects(() => call("set-jarod-settings", { connectedBrowser: { [k]: "x" } }), /inconnue/);
    }
  });
});
