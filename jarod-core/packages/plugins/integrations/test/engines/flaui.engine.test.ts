// D1 contre FlaUI (UIA3, sidecar .NET) : même fenêtre WinForms fabriquée, mêmes sept opérations gouvernées que pour pywinauto.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childLineProcess, SidecarUiaBackend, UiaAutomation, type WindowRef } from "../../src/index.js";
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
    const edits = await uia.findElement({ window: win.id, controlType: "Edit" });
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const plain = edits.find((e) => !e.isPassword)!;
    await uia.typeText(win.id, plain.id, "salut flaui");
    const button = (await uia.findElement({ window: win.id, name: "Valider" }))[0]!;
    await uia.click(win.id, button.id);
    await new Promise((r) => setTimeout(r, 400));
    const label = (await uia.findElement({ window: win.id, automationId: "resultat" }))[0]!;
    expect(await uia.readText(win.id, label.id)).toContain("OK:salut flaui");
  }, 60_000);

  it("le champ protégé est détecté et jamais rempli ; une touche hors liste est refusée", async () => {
    const pwd = (await uia.findElement({ window: win.id, controlType: "Edit" })).find((e) => e.isPassword);
    expect(pwd).toBeDefined();
    await expect(uia.typeText(win.id, pwd!.id, "x")).rejects.toThrow(/mot de passe/);
    await expect(uia.pressKey(win.id, "alt+f4")).rejects.toThrow(/non permise/);
    expect(audit.some((a) => a.op === "click" && a.ok)).toBe(true);
  }, 30_000);
});
