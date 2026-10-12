/**
 * SPECS-P5-UI-PARITE.md §3.3 — réglages `mobile` (port seul) et `android` (délai seul) : les appareils appairés, leurs jetons et le chemin d'adb ne
 * traversent jamais ce canal ; bornes validées ; rien d'invalide n'est écrit.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

describe("pont téléphone et Android : réglages", () => {
  it("le port du pont et le délai adb s'écrivent ; les appareils appairés et le chemin d'adb sont PRÉSERVÉS", async () => {
    const { call, app } = await setupKernel();
    const device = { deviceId: "d1", name: "Pixel", tokenHash: "hash-secret", pairedAt: 1, lastSeen: 2 };
    app.agent.settings.set("mobile", { ...app.agent.settings.get("mobile"), devices: [device] });
    app.agent.settings.set("android", { adbPath: "C:\\tools\\adb.exe", timeoutMs: 15000 });
    const out = (await call("set-jarod-settings", { mobile: { port: 12000 }, android: { timeoutMs: 30000 } })) as { mobile: unknown; android: unknown };
    expect(out.mobile).toEqual({ port: 12000 });
    expect(out.android).toEqual({ timeoutMs: 30000 });
    expect(JSON.stringify(out)).not.toMatch(/hash-secret|adb\.exe/);
    expect(app.agent.settings.get("mobile")).toMatchObject({ port: 12000, devices: [device] });
    expect(app.agent.settings.get("android")).toEqual({ adbPath: "C:\\tools\\adb.exe", timeoutMs: 30000 });
  });

  it("refus sans écriture : ports hors bornes ou non entiers, délai hors bornes, champs interdits (appareils, jetons, chemin d'adb)", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.getAll();
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ mobile: { port: 1023 } }, /entre 1024 et 65535/],
      [{ mobile: { port: 65536 } }, /entre 1024 et 65535/],
      [{ mobile: { port: 8080.5 } }, /entier/],
      [{ mobile: { port: "8080" } }, /entier/],
      [{ mobile: { devices: [] } }, /inconnue/],
      [{ mobile: { enabled: true } }, /inconnue/],
      [{ android: { timeoutMs: 999 } }, /entre 1000 et 120000/],
      [{ android: { timeoutMs: 120001 } }, /entre 1000 et 120000/],
      [{ android: { adbPath: "C:\\evil\\adb.exe" } }, /inconnue/],
    ];
    for (const [patch, why] of bad) await rejects(() => call("set-jarod-settings", { agentMode: "plan", ...patch }), why);
    expect(app.agent.settings.getAll()).toEqual(before);
  });
});
