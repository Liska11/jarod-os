// D1 contre FlaUI (UIA3, sidecar .NET) : même fenêtre WinForms fabriquée, mêmes sept opérations gouvernées que pour pywinauto.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childLineProcess, DesktopController, DesktopLease, desktopTools, SidecarUiaBackend, UiaAutomation, type WindowRef } from "../../src/index.js";
import { FIXTURES, ROOT } from "./helpers.js";

const DLL = join(ROOT, "engines", "flaui", "uia-flaui-worker.dll");

describe.skipIf(!existsSync(DLL))("D1 FlaUI (moteur réel)", () => {
  let target: ChildProcess;
  let backend: SidecarUiaBackend;
  let uia: UiaAutomation;
  const audit: { op: string; ok: boolean }[] = [];
  let win: WindowRef;

  beforeAll(async () => {
    target = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(FIXTURES, "uia_target.ps1"), "-Title", "JarodUiaTarget-flaui"], { stdio: "ignore" });
    backend = new SidecarUiaBackend("flaui", () => childLineProcess("dotnet", [DLL], { DOTNET_ROOT: process.env.DOTNET_ROOT ?? "C:\\Program Files\\dotnet", ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files", APPDATA: process.env.APPDATA ?? "" }), 30_000);
    uia = new UiaAutomation({ backend, policy: { allowProcesses: ["powershell"], perMinute: 200 }, approve: async () => true, audit: (e) => audit.push(e) });
    for (let i = 0; i < 40 && !win; i++) {
      win = (await uia.listWindows()).find((w) => w.title === "JarodUiaTarget-flaui")!;
      if (!win) await new Promise((r) => setTimeout(r, 500));
    }
  }, 90_000);

  afterAll(() => {
    backend?.close();
    target?.kill();
  });

  it("ne voit que les fenêtres permises", async () => {
    expect(win).toBeDefined();
    expect((await uia.listWindows()).every((w) => w.process.toLowerCase() === "powershell.exe")).toBe(true);
  });

  it("saisit, clique et lit : l'étiquette affichée prouve que les actions ont eu lieu", async () => {
    const edits = await uia.findElement({ window: win!.id, controlType: "Edit" });
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const plain = edits.find((e) => !e.isPassword)!;
    await uia.typeText(win.id, plain.id, "salut flaui");
    const button = (await uia.findElement({ window: win!.id, name: "Valider" }))[0]!;
    await uia.click(win.id, button.id);
    await new Promise((r) => setTimeout(r, 400));
    const label = (await uia.findElement({ window: win!.id, automationId: "resultat" }))[0]!;
    expect(await uia.readText(win.id, label.id)).toContain("OK:salut flaui");
  }, 60_000);

  it("le champ protégé est détecté et jamais rempli ; une touche hors liste est refusée", async () => {
    const pwd = (await uia.findElement({ window: win!.id, controlType: "Edit" })).find((e) => e.isPassword);
    expect(pwd).toBeDefined();
    await expect(uia.typeText(win.id, pwd!.id, "x")).rejects.toThrow(/mot de passe/);
    await expect(uia.pressKey(win.id, "alt+f4")).rejects.toThrow(/non permise/);
    expect(audit.some((a) => a.op === "click" && a.ok)).toBe(true);
  }, 30_000);
});

// 2026-10-21 — clavier, souris par coordonnées et arrêt d'urgence, contre le moteur réel, sur une fenêtre FABRIQUÉE (jamais une fenêtre de
// l'utilisateur). L'outil de l'agent passe par `DesktopController` : premier plan constaté avant les touches, curseur remis en place.
describe.skipIf(!existsSync(DLL) || process.platform !== "win32")("D1 FlaUI — clavier, souris, arrêt d'urgence (moteur réel)", () => {
  const EXE = join(ROOT, "engines", "flaui", "uia-flaui-worker.exe");
  const TITLE = "JarodUiaTarget-clavier";
  let target: ChildProcess;
  let c: DesktopController;
  let control: ReturnType<typeof desktopTools>[1];
  type Listed = { id: string; title: string; rect: { width: number; height: number } };
  let win: Listed | undefined;
  const ctx = { sessionId: "banc-d1", workspace: null };

  beforeAll(async () => {
    target = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(FIXTURES, "uia_target.ps1"), "-Title", TITLE], { stdio: "ignore" });
    c = new DesktopController({ worker: () => EXE, lease: new DesktopLease(join(tmpdir(), `jarod-lease-banc-${process.pid}.lock`)) });
    const [list, ctl] = desktopTools(c);
    control = ctl!;
    for (let i = 0; i < 40 && !win; i++) {
      win = (JSON.parse(await list!.run({}, ctx)) as Listed[]).find((w) => w.title === TITLE);
      if (!win) await new Promise((r) => setTimeout(r, 500));
    }
  }, 90_000);

  afterAll(() => {
    c?.dispose();
    target?.kill();
  });

  it("touche, combinaison et frappe brute dans le champ, puis clic par coordonnées sur le bouton : l'étiquette le prouve ; le curseur revient", async () => {
    expect(win).toBeDefined();
    const elems = JSON.parse(await control.run({ action: "find_element", window: win!.id, controlType: "Edit" }, ctx)) as { id: string; isPassword: boolean }[];
    const field = elems.find((e) => !e.isPassword)!;
    await control.run({ action: "click", window: win!.id, element: field.id }, ctx); // le curseur de saisie dans le champ
    await control.run({ action: "type_text", window: win!.id, element: field.id, text: "ancien" }, ctx);
    // Sélectionner l'ancien texte au clavier (une zone de texte WinForms d'une ligne ne gère pas Ctrl+A : Fin puis Maj+Début).
    await control.run({ action: "press_key", window: win!.id, key: "end" }, ctx);
    await control.run({ action: "press_keys", window: win!.id, combo: "shift+home" }, ctx);
    expect(await control.run({ action: "type_keys", window: win!.id, text: "clavier brut" }, ctx)).toBe("Texte tapé.");
    const button = (JSON.parse(await control.run({ action: "find_element", window: win!.id, name: "Valider" }, ctx)) as { rect: { x: number; y: number; width: number; height: number } }[])[0]!;
    // Le curseur remis en place est CONSTATÉ par le moteur juste après le geste (une comparaison d'ici serait faussée si l'utilisateur bouge sa souris).
    const clicked = await control.run({ action: "mouse_click", window: win!.id, x: button.rect.x + Math.floor(button.rect.width / 2), y: button.rect.y + Math.floor(button.rect.height / 2) }, ctx);
    expect(clicked).toMatch(/^Clic fait \(curseur (remis en place|déplacé pendant le geste)/);
    await new Promise((r) => setTimeout(r, 400));
    const label = (JSON.parse(await control.run({ action: "find_element", window: win!.id, automationId: "resultat" }, ctx)) as { id: string }[])[0]!;
    expect(await control.run({ action: "read_text", window: win!.id, element: label.id }, ctx)).toBe("OK:clavier brut");
    await expect(control.run({ action: "mouse_click", window: win!.id, x: win!.rect.width + 5, y: 5 }, ctx)).rejects.toThrow(/hors de la fenêtre/);
    await expect(control.run({ action: "press_keys", window: win!.id, combo: "win+r" }, ctx)).rejects.toThrow(/refusée/);
  }, 90_000);

  it("Ctrl+Alt+Fin tenu au clavier : le moteur s'arrête, plus rien ne passe ; la reprise exige l'accord", async () => {
    await control.run({ action: "focus_window", window: win!.id }, ctx);
    await new Promise<void>((resolve) => spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(FIXTURES, "hold_emergency.ps1")], { stdio: "ignore" }).on("exit", () => resolve()));
    for (let i = 0; i < 20 && c.stopped === null; i++) await new Promise((r) => setTimeout(r, 100));
    expect(c.stopped).not.toBeNull();
    expect(await control.run({ action: "type_keys", window: win!.id, text: "x" }, { ...ctx, approve: async () => false })).toMatch(/reprise n'a pas été accordée/);
    expect(await control.run({ action: "focus_window", window: win!.id }, { ...ctx, approve: async () => true })).toBe("Fenêtre au premier plan.");
  }, 60_000);
});

