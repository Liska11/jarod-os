// Applications du Store (Calculatrice, Bloc-notes de Windows 11…) : leur fenêtre est un cadre d'ApplicationFrameHost et leur processus n'a pas de
// fenêtre principale. Avant le 31/10, « ouvrir la Calculatrice » réussissait puis la vérification disait « n'apparaît pas parmi les applications
// ouvertes », et la fermer répondait « n'est pas ouverte » : le modèle croyait avoir échoué.
import { describe, expect, it } from "vitest";
import { parseRunningApps } from "../src/system/parse.js";
import { powershellExe, realPsRunner } from "../src/system/ps.js";
import { CLOSE_WINDOW } from "../src/system/scripts-act.js";
import { RUNNING_APPS, UWP_TYPE } from "../src/system/scripts.js";

describe("applications du Store", () => {
  it("la lecture des applications ouvertes ET la fermeture passent par le cadre ApplicationFrameWindow", () => {
    expect(UWP_TYPE).toContain("ApplicationFrameWindow");
    expect(UWP_TYPE).toContain("Windows.UI.Core.CoreWindow");
    expect(RUNNING_APPS).toContain("[JarodOs.Uwp]::Frames()");
    expect(CLOSE_WINDOW).toContain("[JarodOs.Uwp]::Close(");
    expect(UWP_TYPE).toContain("0x10"); // WM_CLOSE : fermeture polie, l'application peut proposer d'enregistrer
  });

  it("une application du Store lue par son cadre est une application ouverte comme une autre", () => {
    const apps = parseRunningApps([{ pid: 4242, process: "CalculatorApp", description: "Calculatrice", path: "", title: "Calculatrice" }]);
    expect(apps).toEqual([{ name: "Calculatrice", path: "", bundle_id: null, running: true, pid: 4242 }]);
  });

  it.skipIf(process.platform !== "win32")("sur cette machine : le script de lecture tourne (PowerShell 5.1) et rend une liste JSON", async () => {
    const out = await realPsRunner(powershellExe()).json(RUNNING_APPS, undefined, { timeoutMs: 60_000 });
    expect(Array.isArray(out)).toBe(true);
    for (const row of out as { pid: number }[]) expect(typeof row.pid).toBe("number");
  }, 90_000);
});
