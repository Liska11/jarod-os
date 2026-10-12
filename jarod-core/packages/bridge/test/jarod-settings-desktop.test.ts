/**
 * SPECS-P5-TRAY.md § 5 (TH1 à TH3) — la clé `desktop` du canal `set-jarod-settings` : deux booléens seulement, `trayHintShown` jamais modifiable depuis l'écran, l'entrée de
 * démarrage de la session derrière une boîte native ET une version empaquetée, la valeur affichée relue du SYSTÈME. VRAI kernel, VRAIS handlers, port de démarrage DOUBLÉ
 * (ni les tests ni l'agent n'écrivent jamais l'entrée de démarrage de la machine).
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

function items(packaged: boolean, initial = false) {
  const log: string[] = [];
  let on = initial;
  return {
    log,
    flip: (v: boolean) => void (on = v),
    port: {
      packaged,
      get: () => on,
      set: (v: boolean) => {
        log.push(`set:${v}`);
        on = v;
      },
    },
  };
}
type Desktop = { desktop: { closeToTray: boolean; launchAtLogin: boolean; launchAtLoginAvailable: boolean } };

describe("réglage `desktop` (zone de notification)", () => {
  it("TH1 lecture par défaut ; deux booléens SEULEMENT ; trayHintShown et toute autre clé refusés ; les autres champs ne sont pas perdus", async () => {
    const { call, app } = await setupKernel();
    expect(((await call("get-jarod-settings")) as Desktop).desktop).toEqual({ closeToTray: true, launchAtLogin: false, launchAtLoginAvailable: false });
    const off = (await call("set-jarod-settings", { desktop: { closeToTray: false } })) as Desktop;
    expect(off.desktop.closeToTray).toBe(false);
    expect(app.agent.settings.get("desktop")).toEqual({ closeToTray: false, launchAtLogin: false, trayHintShown: false });
    // le conseil déjà donné (écrit par le main) survit à une écriture de l'écran
    app.agent.settings.set("desktop", { ...app.agent.settings.get("desktop"), trayHintShown: true });
    await call("set-jarod-settings", { desktop: { closeToTray: true } });
    expect(app.agent.settings.get("desktop")).toEqual({ closeToTray: true, launchAtLogin: false, trayHintShown: true });
    await rejects(() => call("set-jarod-settings", { desktop: { trayHintShown: false } }), /clé\(s\) inconnue\(s\) : trayHintShown/);
    await rejects(() => call("set-jarod-settings", { desktop: { closeToTray: "oui" } }), /booléen attendu/);
    await rejects(() => call("set-jarod-settings", { desktop: { launchAtLogin: 1 } }), /booléen attendu/);
    await rejects(() => call("set-jarod-settings", { desktop: { autre: true } }), /clé\(s\) inconnue\(s\)/);
    await rejects(() => call("set-jarod-settings", { desktop: "x" }), /objet attendu/);
    expect(app.agent.settings.get("desktop").trayHintShown, "un patch refusé n'écrit rien").toBe(true);
  });

  it("TH2 allumer launchAtLogin : boîte native (« Annuler » par défaut) puis le port ; refusée, rien n'est écrit ; l'éteindre ne demande rien ; sans boîte : refus", async () => {
    const d = items(true);
    const { call, app, confirms } = await setupKernel(undefined, [false, true], { loginItems: d.port });
    await rejects(() => call("set-jarod-settings", { desktop: { launchAtLogin: true } }), /refusé par l'utilisateur/);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.detail).toMatch(/démarrage de votre session/i);
    expect(d.log, "refusée : le système n'est pas touché").toEqual([]);
    expect(app.agent.settings.get("desktop").launchAtLogin).toBe(false);
    const on = (await call("set-jarod-settings", { desktop: { launchAtLogin: true } })) as Desktop;
    expect(d.log).toEqual(["set:true"]);
    expect(on.desktop).toMatchObject({ launchAtLogin: true, launchAtLoginAvailable: true });
    expect(app.agent.settings.get("desktop").launchAtLogin).toBe(true);
    await call("set-jarod-settings", { desktop: { launchAtLogin: false } });
    expect(confirms, "l'éteindre ne demande rien").toHaveLength(2);
    expect(d.log).toEqual(["set:true", "set:false"]);
    // déjà dans l'état demandé : ni boîte ni écriture système
    await call("set-jarod-settings", { desktop: { launchAtLogin: false } });
    expect(confirms).toHaveLength(2);
    expect(d.log).toEqual(["set:true", "set:false"]);
    const nobox = await setupKernel(undefined, [], { loginItems: items(true).port, noConfirm: true });
    await rejects(() => nobox.call("set-jarod-settings", { desktop: { launchAtLogin: true } }), /confirmation native indisponible/);
  });

  it("TH2 bis : hors version empaquetée (ou sans port), allumer est REFUSÉ avec la raison, sans boîte et sans toucher le système ; un échec du système n'écrit rien", async () => {
    const dev = items(false);
    const a = await setupKernel(undefined, [true], { loginItems: dev.port });
    await rejects(() => a.call("set-jarod-settings", { desktop: { launchAtLogin: true } }), /version empaquetée/);
    expect(a.confirms, "aucune boîte pour une action impossible").toHaveLength(0);
    expect(dev.log).toEqual([]);
    expect(a.app.agent.settings.get("desktop").launchAtLogin).toBe(false);
    const b = await setupKernel(undefined, [true]);
    await rejects(() => b.call("set-jarod-settings", { desktop: { launchAtLogin: true } }), /indisponible/);
    const broken = items(true);
    broken.port.set = () => {
      throw new Error("registre refusé");
    };
    const c = await setupKernel(undefined, [true], { loginItems: broken.port });
    await rejects(() => c.call("set-jarod-settings", { desktop: { launchAtLogin: true } }), /registre refusé/);
    expect(c.app.agent.settings.get("desktop").launchAtLogin, "le système a refusé : rien n'est écrit").toBe(false);
  });

  it("TH3 la valeur lue pour l'écran est celle du SYSTÈME (le port), pas du seul réglage ; hors version empaquetée : faux et indisponible", async () => {
    const d = items(true, true);
    const { call, app } = await setupKernel(undefined, [], { loginItems: d.port });
    expect(app.agent.settings.get("desktop").launchAtLogin).toBe(false);
    expect(((await call("get-jarod-settings")) as Desktop).desktop).toMatchObject({ launchAtLogin: true, launchAtLoginAvailable: true });
    d.flip(false);
    expect(((await call("get-jarod-settings")) as Desktop).desktop.launchAtLogin).toBe(false);
    const dev = await setupKernel(undefined, [], { loginItems: items(false, true).port });
    expect(((await dev.call("get-jarod-settings")) as Desktop).desktop).toMatchObject({ launchAtLogin: false, launchAtLoginAvailable: false });
  });
});
