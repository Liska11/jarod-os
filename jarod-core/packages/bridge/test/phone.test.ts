/**
 * SPECS-P5-UI-PARITE.md §3.3 — téléphone (pont local) et Android (adb) depuis l'écran. Le pont écoute sur le réseau local : l'allumer passe par une
 * boîte native ; adb est un programme lancé par l'agent : son chemin vient de la boîte « Ouvrir », jamais d'une saisie. VRAI kernel, VRAIE passerelle.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

type Status = { mobile: { running: boolean; port: number; url: string; devices: { deviceId: string }[] }; android: { adb: string | null; configured: string; state: "ready" | "unconfigured" | "missing"; devices: unknown[] } };

async function phone(confirmAnswers: boolean[] = [], picks: (string | null)[] = []) {
  const k = await setupKernel(undefined, confirmAnswers, { pickFile: async () => picks.shift() ?? null });
  k.app.agent.settings.set("mobile", { ...k.app.agent.settings.get("mobile"), port: 0 }); // port libre choisi par le système : pas de collision
  return k;
}

describe("pont téléphone", () => {
  it("état éteint par défaut ; ALLUMER demande une boîte native qui dit « tout le réseau local » ; refusée, rien n'écoute", async () => {
    const { call, app, confirms } = await phone([false, true]);
    const s0 = (await call("phone-status")) as Status;
    expect(s0.mobile).toMatchObject({ running: false, devices: [] });
    await rejects(() => call("phone-bridge-set", true), /refusé par l'utilisateur/);
    expect(confirms[0]!.detail).toMatch(/TOUT le réseau local/);
    expect(confirms[0]!.detail).toMatch(/ne peut pas approuver les outils sensibles/);
    expect(app.gateways.mobile.status().running).toBe(false);
    const on = (await call("phone-bridge-set", true)) as Status;
    expect(on.mobile.running).toBe(true);
    expect(on.mobile.port).toBeGreaterThan(0);
    // Déjà allumé : pas de seconde boîte.
    await call("phone-bridge-set", true);
    expect(confirms).toHaveLength(2);
    const off = (await call("phone-bridge-set", false)) as Status; // éteindre ne demande rien
    expect(off.mobile.running).toBe(false);
    expect(confirms).toHaveLength(2);
    await app.gateways.mobile.close();
  });

  it("appairage : un code seulement pont allumé ; chaque appel donne un code NEUF ; invalide : refus", async () => {
    const { call, app } = await phone([true]);
    await rejects(() => call("phone-pairing"), /éteint/);
    await call("phone-bridge-set", true);
    const a = (await call("phone-pairing")) as { url: string; secret: string; expiresAt: number };
    const b = (await call("phone-pairing")) as { secret: string };
    expect(a.secret).toMatch(/\S{6,}/);
    expect(a.secret).not.toBe(b.secret);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    await rejects(() => call("phone-bridge-set", "oui"), /booléen attendu/);
    await app.gateways.mobile.close();
  });

  it("révoquer : téléphone inconnu refusé ; identifiant invalide refusé", async () => {
    const { call, app } = await phone([true]);
    await call("phone-bridge-set", true);
    await rejects(() => call("phone-revoke", "inconnu"), /téléphone inconnu/);
    await rejects(() => call("phone-revoke", 5), /identifiant attendu/);
    await app.gateways.mobile.close();
  });
});

describe("Android (adb)", () => {
  it("le programme adb se choisit dans la boîte native ; un chemin tapé est refusé ; l'adb en usage relit le réglage tout de suite", async () => {
    const fake = join(tempDir(), "adb.exe");
    writeFileSync(fake, "pas un vrai adb");
    const { call, app } = await phone([], [fake, null]);
    await rejects(() => call("android-set-adb", fake), /non choisi dans la boîte/);
    await rejects(() => call("android-set-adb", "C:\\evil\\adb.exe"), /non choisi dans la boîte/);
    expect(app.agent.settings.get("android").adbPath).toBe("");
    expect(await call("android-pick-adb")).toBe(fake);
    const set = (await call("android-set-adb", fake)) as Status;
    expect(set.android.adb).toBe(fake);
    expect(set.android.configured).toBe(fake);
    expect(app.agent.settings.get("android").adbPath).toBe(fake);
    // Boîte annulée : null, rien de retenu.
    expect(await call("android-pick-adb")).toBeNull();
    await rejects(() => call("android-set-adb", 42), /chemin attendu/);
    // Revenir à l'adb du PATH : réglage vidé.
    const back = (await call("android-set-adb", null)) as Status;
    expect(back.android.configured).toBe("");
    expect(app.agent.settings.get("android").adbPath).toBe("");
  });

  it("sans boîte native : refus", async () => {
    const k = await setupKernel();
    await rejects(() => k.call("android-pick-adb"), /indisponible/);
  });
});

// SPECS-P5-UI-PARITE.md § 21 : aucun lancement d'adb sans adb résolu. VRAI lancement : un faux adb compilé par le test AJOUTE une ligne à un fichier témoin à chaque lancement.
const CSC = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
const FIXTURE = fileURLToPath(new URL("./e2e/fixtures/fake-adb.cs", import.meta.url));
const canCompile = process.platform === "win32" && existsSync(CSC);

describe.skipIf(!canCompile)("Android (adb) — aucun lancement sans adb résolu (§ 21, faux adb compilé)", () => {
  const env0 = { PATH: process.env.PATH, LOG: process.env.FAKE_ADB_LOG };
  afterEach(() => {
    process.env.PATH = env0.PATH;
    if (env0.LOG === undefined) delete process.env.FAKE_ADB_LOG;
    else process.env.FAKE_ADB_LOG = env0.LOG;
  });
  const rig = async () => {
    const dir = tempDir();
    const exe = join(dir, "adb.exe");
    const c = spawnSync(CSC, ["/nologo", "/target:exe", `/out:${exe}`, FIXTURE], { encoding: "utf8" });
    expect(c.status, `compilation du faux adb : ${c.stdout}${c.stderr}`).toBe(0);
    const log = join(dir, "adb-launches.log");
    process.env.FAKE_ADB_LOG = log;
    process.env.PATH = "C:/Windows/System32"; // aucun adb sur le PATH de ce test
    const k = await phone([], [exe]);
    k.app.gateways.android.reset();
    const launches = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : []);
    return { ...k, exe, launches };
  };

  it("AD5 rien de configuré, aucun adb sur le PATH : trois affichages rendent « unconfigured » et AUCUN lancement", async () => {
    const { call, launches } = await rig();
    for (let i = 0; i < 3; i++) {
      const s = (await call("phone-status")) as Status;
      expect(s.android).toMatchObject({ state: "unconfigured", adb: null, configured: "", devices: [] });
    }
    expect(launches()).toEqual([]);
  });

  it("AD6 le faux adb choisi dans la boîte native : chaque affichage le lance UNE fois, avec « devices -l » (comportement gardé)", async () => {
    const { call, exe, launches } = await rig();
    expect(await call("android-pick-adb")).toBe(exe);
    const set = (await call("android-set-adb", exe)) as Status;
    expect(set.android).toMatchObject({ state: "ready", adb: exe });
    const after = launches().length;
    expect(after).toBe(1); // le choix lui-même relit l'état une fois
    await call("phone-status");
    await call("phone-status");
    expect(launches()).toHaveLength(after + 2);
    for (const l of launches()) expect(l).toBe(["devices", "-l"].join(String.fromCharCode(31)));
  });

  it("AD7 le faux adb supprimé : « missing », plus aucune ligne ajoutée ; AD8 retour à l'adb du PATH (sans adb) : « unconfigured », plus aucun lancement", async () => {
    const { call, exe, launches } = await rig();
    await call("android-pick-adb");
    await call("android-set-adb", exe);
    const n = launches().length;
    rmSync(exe);
    for (let i = 0; i < 2; i++) {
      const s = (await call("phone-status")) as Status;
      expect(s.android).toMatchObject({ state: "missing", adb: exe, devices: [] });
    }
    expect(launches()).toHaveLength(n);
    const back = (await call("android-set-adb", null)) as Status;
    expect(back.android).toMatchObject({ state: "unconfigured", adb: null, configured: "" });
    await call("phone-status");
    expect(launches()).toHaveLength(n);
  });
});
