// D2 contre pywinauto (moteur réel, backend UIA) : une fenêtre WinForms FABRIQUÉE est pilotée par les sept opérations gouvernées.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childLineProcess, SidecarUiaBackend, UiaAutomation, type WindowRef } from "../../src/index.js";
import { FIXTURES, HAS_PY, PY, SIDECARS } from "./helpers.js";

describe.skipIf(!HAS_PY)("D2 pywinauto (moteur réel)", () => {
  let target: ChildProcess;
  let backend: SidecarUiaBackend;
  let uia: UiaAutomation;
  const audit: { op: string; ok: boolean }[] = [];
  let win: WindowRef;

  beforeAll(async () => {
    target = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(FIXTURES, "uia_target.ps1"), "-Title", "JarodUiaTarget-pywinauto"], { stdio: "ignore" });
    backend = new SidecarUiaBackend("pywinauto", () => childLineProcess(PY, [join(SIDECARS, "uia-pywinauto", "uia_worker.py")]), 30_000);
    uia = new UiaAutomation({ backend, policy: { allowProcesses: ["powershell"], perMinute: 200 }, approve: async () => true, audit: (e) => audit.push(e) });
    for (let i = 0; i < 40 && !win; i++) {
      win = (await uia.listWindows()).find((w) => w.title === "JarodUiaTarget-pywinauto")!;
      if (!win) await new Promise((r) => setTimeout(r, 500));
    }
  }, 60_000);

  afterAll(() => {
    backend?.close();
    target?.kill();
  });

  it("voit la fenêtre fabriquée parmi les fenêtres permises, et seulement celles-là", async () => {
    expect(win).toBeDefined();
    const all = await uia.listWindows();
    expect(all.every((w) => ["powershell.exe"].includes(w.process.toLowerCase()))).toBe(true);
  });

  it("saisit, clique et lit : le résultat affiché prouve que les actions ont eu lieu", async () => {
    const edits = await uia.findElement({ window: win.id, controlType: "Edit" });
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const plain = edits.find((e) => !e.isPassword)!;
    expect(plain).toBeDefined();
    await uia.typeText(win.id, plain.id, "bonjour");
    const button = (await uia.findElement({ window: win.id, name: "Valider" }))[0]!;
    await uia.click(win.id, button.id);
    await new Promise((r) => setTimeout(r, 400));
    const texts = await uia.findElement({ window: win.id, automationId: "resultat" });
    expect(texts.length).toBeGreaterThan(0);
    expect(await uia.readText(win.id, texts[0]!.id)).toContain("OK:bonjour");
  }, 60_000);

  it("détecte le champ protégé : il n'est jamais rempli", async () => {
    const edits = await uia.findElement({ window: win.id, controlType: "Edit" });
    const pwd = edits.find((e) => e.isPassword);
    expect(pwd, "un champ protégé doit être détecté par UIA").toBeDefined();
    await expect(uia.typeText(win.id, pwd!.id, "x")).rejects.toThrow(/mot de passe/);
  }, 30_000);

  it("une touche hors liste est refusée avant d'atteindre le moteur ; le journal a une entrée par opération", async () => {
    await expect(uia.pressKey(win.id, "alt+f4")).rejects.toThrow(/non permise/);
    expect(audit.some((a) => a.op === "type_text" && a.ok)).toBe(true);
    expect(audit.some((a) => a.op === "press_key" && !a.ok)).toBe(true);
  });
});
