import { describe, expect, it } from "vitest";
import { AdapterRefused, AdapterUnavailable, type ElementInfo, type LineProcess, SidecarUiaBackend, UiaAutomation, type UiaBackend, type WindowRef } from "../src/index.js";

const wins: WindowRef[] = [
  { id: "1", title: "Bloc-notes", process: "notepad.exe" },
  { id: "2", title: "Coffre", process: "KeePass.exe" },
  { id: "3", title: "Contrôle de compte d'utilisateur", process: "consent.exe" },
  { id: "4", title: "Autre", process: "calc.exe" },
];
const els: ElementInfo[] = [
  { id: "e1", name: "Texte", controlType: "Edit", isPassword: false },
  { id: "e2", name: "Mot", controlType: "Edit", isPassword: true },
];

function fake() {
  const log: string[] = [];
  const b: UiaBackend = {
    engine: "pywinauto",
    listWindows: async () => wins,
    findElement: async () => els,
    readText: async (_w, e) => (log.push(`read ${e}`), "contenu"),
    click: async (_w, e) => void log.push(`click ${e}`),
    typeText: async (_w, e, t) => void log.push(`type ${e} ${t}`),
    focusWindow: async (w) => void log.push(`focus ${w}`),
    pressKey: async (_w, k) => void log.push(`key ${k}`),
  };
  return { b, log };
}

function uia(over: Partial<ConstructorParameters<typeof UiaAutomation>[0]> = {}) {
  const f = fake();
  const audit: unknown[] = [];
  const a = new UiaAutomation({ backend: f.b, policy: { allowProcesses: ["notepad", "keepass", "consent"] }, approve: async () => true, audit: (e) => audit.push(e), ...over });
  return { a, audit, ...f };
}

describe("D1/D2 — gouvernance de l'automatisation UI", () => {
  it("sans moteur : indisponible", async () => {
    await expect(new UiaAutomation({ policy: { allowProcesses: ["notepad"] } }).listWindows()).rejects.toThrow(AdapterUnavailable);
  });

  it("ne montre que les fenêtres permises : gestionnaires de mots de passe et invites d'élévation sont exclus même s'ils sont en liste blanche", async () => {
    const { a } = uia();
    expect((await a.listWindows()).map((w) => w.process)).toEqual(["notepad.exe"]);
  });

  it("refuse toute opération sur une fenêtre non permise ou inconnue, sans toucher au moteur", async () => {
    const { a, log } = uia();
    for (const w of ["2", "3", "4", "zz"]) {
      await expect(a.click(w, "e1")).rejects.toThrow(AdapterRefused);
      await expect(a.findElement({ window: w, name: "x" })).rejects.toThrow(AdapterRefused);
    }
    expect(log).toEqual([]);
  });

  it("les actions exigent l'accord à chaque appel ; les lectures non, mais sont auditées", async () => {
    const asked: string[] = [];
    const { a, log, audit } = uia({ approve: async (op) => (asked.push(op), op !== "click") });
    expect(await a.readText("1", "e1")).toBe("contenu");
    await a.typeText("1", "e1", "bonjour");
    await expect(a.click("1", "e1")).rejects.toThrow(/non accordée/);
    expect(asked).toEqual(["type_text", "click"]);
    expect(log).toEqual(["read e1", "type e1 bonjour"]);
    expect(audit).toHaveLength(3);
    const none = uia({ approve: undefined });
    await expect(none.a.click("1", "e1")).rejects.toThrow(/non accordée/);
  });

  it("un champ de mot de passe n'est ni lu, ni rempli, et son nom est masqué", async () => {
    const { a, log } = uia();
    await expect(a.readText("1", "e2")).rejects.toThrow(/mot de passe/);
    await expect(a.typeText("1", "e2", "x")).rejects.toThrow(/mot de passe/);
    expect((await a.findElement({ window: "1", name: "M" })).find((e) => e.id === "e2")!.name).toBe("[champ protégé]");
    expect(log).toEqual([]);
  });

  it("borne le texte, refuse les caractères de contrôle, les touches hors liste, une requête sans critère, et limite le débit", async () => {
    const { a } = uia();
    await expect(a.typeText("1", "e1", "x".repeat(2001))).rejects.toThrow(/trop long/);
    await expect(a.typeText("1", "e1", "a\u0007b")).rejects.toThrow(/contrôle/);
    await expect(a.pressKey("1", "alt+f4")).rejects.toThrow(/non permise/);
    await expect(a.pressKey("1", "Enter")).resolves.toBeUndefined();
    await expect(a.findElement({ window: "1" })).rejects.toThrow(/critère/);
    let t = 0;
    const lim = uia({ policy: { allowProcesses: ["notepad"], perMinute: 2 }, now: () => t });
    await lim.a.listWindows();
    await lim.a.listWindows();
    await expect(lim.a.listWindows()).rejects.toThrow(/trop d'opérations/);
    t = 61_000;
    await expect(lim.a.listWindows()).resolves.toBeDefined();
  });
});

describe("sidecar en lignes JSON", () => {
  function proc(handler: (req: { id: number; op: string }, reply: (o: unknown) => void) => void) {
    let onLine: (l: string) => void = () => {};
    let onExit: () => void = () => {};
    const p: LineProcess = {
      write: (line) => handler(JSON.parse(line), (o) => onLine(JSON.stringify(o))),
      onLine: (cb) => (onLine = cb),
      onExit: (cb) => (onExit = cb),
      kill: () => onExit(),
    };
    return p;
  }

  it("associe les réponses aux requêtes, ignore le bruit, et propage les erreurs", async () => {
    const b = new SidecarUiaBackend("pywinauto", () =>
      proc((req, reply) => {
        reply({ id: 999, ok: true, result: "autre" });
        if (req.op === "list_windows") reply({ id: req.id, ok: true, result: wins });
        else reply({ id: req.id, ok: false, error: "boum" });
      }),
    );
    expect(await b.listWindows()).toEqual(wins);
    await expect(b.click("1", "e1")).rejects.toThrow("boum");
  });

  it("délai dépassé et sidecar mort : échec, jamais un succès supposé", async () => {
    const slow = new SidecarUiaBackend("flaui", () => proc(() => {}), 20);
    await expect(slow.listWindows()).rejects.toThrow(/délai/);
    let kill: () => void = () => {};
    const dying = new SidecarUiaBackend("flaui", () => {
      const p = proc(() => {});
      kill = p.kill;
      return p;
    }, 5000);
    const pending = dying.listWindows();
    kill();
    await expect(pending).rejects.toThrow(AdapterUnavailable);
  });
});
