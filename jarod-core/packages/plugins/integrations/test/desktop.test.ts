// D1 raccordé (2026-10-21) — contrat, moteur FACTICE : combinaisons système refusées, coordonnées bornées à la fenêtre, arrêt d'urgence, un seul
// contrôleur par bureau (bail commun aux processus), fenêtre changée entre la demande et l'action, annulation qui arrête le moteur.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopController, DesktopLease, desktopTools, systemComboReason, UiaAutomation, type UiaBackend, type WindowRef } from "../src/index.js";
import { ownProcesses } from "../src/impl/desktop.js";

const dirs: string[] = [];
const leaseFile = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-lease-"));
  dirs.push(d);
  return join(d, "lease.lock");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeBackend(windows: WindowRef[]) {
  const sent: string[] = [];
  let closed = 0;
  const b = {
    engine: "flaui" as const,
    listWindows: async () => windows.map((w) => ({ ...w })),
    findElement: async () => [{ id: "e1", name: "Valider", controlType: "Button", isPassword: false }],
    readText: async () => "texte",
    click: async () => void sent.push("click"),
    typeText: async () => void sent.push("type_text"),
    focusWindow: async () => void sent.push("focus"),
    pressKey: async (_w: string, k: string) => void sent.push(`key:${k}`),
    pressKeys: async (_w: string, c: string) => void sent.push(`combo:${c}`),
    typeKeys: async (_w: string, t: string) => void sent.push(`keys:${t}`),
    mouseClick: async (_w: string, x: number, y: number, b: string) => {
      sent.push(`mouse:${b}:${x},${y}`);
      return { restored: true };
    },
    mouseScroll: async (_w: string, x: number, y: number, a: number) => void sent.push(`scroll:${a}:${x},${y}`),
    close: () => void closed++,
    onEmergency: undefined as undefined | (() => void),
    running: true,
  };
  return { b, sent, closed: () => closed };
}

const NOTEPAD: WindowRef = { id: "100", title: "notes.txt - Bloc-notes", process: "notepad.exe", rect: { left: 0, top: 0, width: 800, height: 600 } };
const KEEPASS: WindowRef = { id: "200", title: "Coffre", process: "KeePass.exe" };

describe("D1 — garde-fous du pilote (moteur factice)", () => {
  it("combinaisons qui agissent hors de la fenêtre : refusées ; les autres passent", async () => {
    expect(systemComboReason("win+r")).toMatch(/Windows/);
    expect(systemComboReason("ctrl+alt+end")).toMatch(/arrêt d'urgence/);
    expect(systemComboReason("alt+tab")).toMatch(/changent de fenêtre/);
    expect(systemComboReason("ctrl+shift+escape")).toMatch(/Démarrer/);
    expect(systemComboReason("ctrl+s")).toBeNull();
    const { b, sent } = fakeBackend([NOTEPAD]);
    const uia = new UiaAutomation({ backend: b as unknown as UiaBackend, policy: {}, approve: async () => true });
    await uia.pressKeys("100", "Ctrl+S");
    await expect(uia.pressKeys("100", "win+r")).rejects.toThrow(/refusée/);
    await expect(uia.pressKeys("100", "ctrl+alt+delete")).rejects.toThrow(/refusée/);
    expect(sent).toEqual(["combo:ctrl+s"]);
  });

  it("coordonnées : relatives à la fenêtre, refusées hors de son rectangle ; défilement borné", async () => {
    const { b, sent } = fakeBackend([NOTEPAD]);
    const uia = new UiaAutomation({ backend: b as unknown as UiaBackend, policy: {}, approve: async () => true });
    await uia.mouseClick("100", 10, 20, "double");
    await expect(uia.mouseClick("100", 800, 10)).rejects.toThrow(/hors de la fenêtre/);
    await expect(uia.mouseClick("100", -1, 10)).rejects.toThrow(/entiers positifs/);
    await expect(uia.mouseScroll("100", 5, 5, 50)).rejects.toThrow(/-20 et 20/);
    expect(sent).toEqual(["mouse:double:10,20"]);
  });

  it("liste noire gardée sans liste blanche : un gestionnaire de mots de passe n'est ni listé ni piloté", async () => {
    const { b } = fakeBackend([NOTEPAD, KEEPASS]);
    const uia = new UiaAutomation({ backend: b as unknown as UiaBackend, policy: {}, approve: async () => true });
    expect((await uia.listWindows()).map((w) => w.id)).toEqual(["100"]);
    await expect(uia.typeKeys("200", "x")).rejects.toThrow(/non permise/);
  });

  it("arrêt d'urgence : plus rien ne passe, lecture comprise, jusqu'à la reprise", async () => {
    const { b, sent } = fakeBackend([NOTEPAD]);
    const uia = new UiaAutomation({ backend: b as unknown as UiaBackend, policy: {}, approve: async () => true });
    uia.emergencyStop();
    await expect(uia.listWindows()).rejects.toThrow(/arrêt d'urgence/);
    await expect(uia.typeKeys("100", "x")).rejects.toThrow(/arrêt d'urgence/);
    uia.resume();
    await uia.typeKeys("100", "x");
    expect(sent).toEqual(["keys:x"]);
  });
});

describe("D1 — un seul contrôleur par bureau", () => {
  it("une autre conversation ou un autre processus est refusé ; inactivité ou processus mort : le bail se libère", () => {
    const file = leaseFile();
    let now = 1_000_000;
    const mine = new DesktopLease(file, 60_000, () => now);
    mine.acquire("s-1");
    mine.acquire("s-1"); // renouvellement
    expect(() => mine.acquire("s-2")).toThrow(/une autre conversation de Jarod, conversation s-1/);
    const other = new DesktopLease(file, 60_000, () => now, process.ppid);
    expect(() => other.acquire("s-9")).toThrow(new RegExp(`processus ${process.pid}`));
    now += 61_000;
    other.acquire("s-9");
    expect(other.holder()?.session).toBe("s-9");
    // Un bail laissé par un processus mort ne bloque personne.
    writeFileSync(file, JSON.stringify({ pid: 999_999_99, session: "fantome", at: now }));
    mine.acquire("s-1");
    expect(mine.holder()?.pid).toBe(process.pid);
    mine.release();
    expect(mine.holder()).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("D1 — les deux outils de l'agent (moteur factice)", () => {
  const setup = (windows: WindowRef[] = [NOTEPAD]) => {
    const f = fakeBackend(windows);
    const c = new DesktopController({ worker: () => null, backend: () => f.b as never, lease: new DesktopLease(leaseFile()), idleMs: 60_000 });
    const [list, control] = desktopTools(c);
    const ctx = (signal?: AbortSignal, approve?: () => Promise<boolean>) => ({ sessionId: "s-1", workspace: null, ...(signal ? { signal } : {}), ...(approve ? { approve } : {}) });
    return { f, c, list: list!, control: control!, ctx };
  };

  it("cible = processus:titre (après la liste), opération par action, clavier et souris réservés", async () => {
    const { list, control, ctx } = setup();
    expect(control.targetOf!({ window: "100" })).toBeUndefined(); // jamais vue : cible inconnue (une règle qui ouvre ne joue pas)
    expect(JSON.parse(await list.run({}, ctx()))[0]).toMatchObject({ id: "100", target: "notepad.exe:notes.txt - Bloc-notes" });
    expect(control.targetOf!({ window: "100" })).toBe("notepad.exe:notes.txt - Bloc-notes");
    expect(control.operationOf!({ action: "mouse_click" })).toBe("mouse.click");
    expect(control.operationOf!({ action: "type_text" })).toBe("ui.type_text");
    expect(Object.keys(control.restrictedOperations!)).toEqual(["keyboard.press_keys", "keyboard.type_keys", "mouse.click", "mouse.scroll"]);
    expect(await control.precheck!({ action: "mouse_click", window: "100", x: 5, y: 6 }, ctx())).toBe("Clic left en (5, 6) dans « notes.txt - Bloc-notes » (notepad.exe)");
  });

  it("les fenêtres de Jarod-OS lui-même (réglages, confirmations) ne sont ni listées ni pilotables", async () => {
    expect(ownProcesses({ JAROD_SHELL_EXE: "Jarod-OS.exe" }, "C:\\Program Files\\Jarod-OS\\Jarod-OS.exe")).toEqual(["jarod-os"]);
    expect(ownProcesses({}, "D:\\x\\node_modules\\electron\\dist\\electron.exe")).toEqual(["electron"]);
    const self = ownProcesses()[0]!;
    const OWN: WindowRef = { id: "300", title: "Réglages", process: `${self}.exe` };
    const { list, control, ctx } = setup([NOTEPAD, OWN]);
    expect(JSON.parse(await list.run({}, ctx())).map((w: { id: string }) => w.id)).toEqual(["100"]);
    await expect(control.precheck!({ action: "click", window: "300", element: "e1" }, ctx())).rejects.toThrow(/non permise/);
  });

  it("la fenêtre a changé entre la demande et l'action : refusé", async () => {
    const wins = [{ ...NOTEPAD }];
    const { list, control, ctx } = setup(wins);
    await list.run({}, ctx());
    wins[0]!.title = "Autre document - Bloc-notes";
    await expect(control.precheck!({ action: "type_keys", window: "100", text: "x" }, ctx())).rejects.toThrow(/a changé/);
  });

  it("annulation de la tâche : le moteur est arrêté en pleine opération et le bail rendu", async () => {
    const { f, c, list, control, ctx } = setup();
    await list.run({}, ctx());
    const ac = new AbortController();
    f.b.typeKeys = async () => {
      ac.abort();
      await new Promise((r) => setTimeout(r, 20));
    };
    await control.run({ action: "type_keys", window: "100", text: "long" }, ctx(ac.signal));
    expect(f.closed()).toBeGreaterThan(0);
    expect(c.lease.holder()).toBeNull();
  });

  it("Ctrl+Alt+Fin (signalé par le moteur) : tout s'arrête ; reprendre demande l'utilisateur, même sous une règle autonome", async () => {
    const { f, c, list, control, ctx } = setup();
    await list.run({}, ctx());
    f.b.onEmergency!();
    expect(c.stopped).not.toBeNull();
    expect(await list.run({}, ctx())).toMatch(/Arrêt d'urgence en cours/);
    expect(await control.precheck!({ action: "type_keys", window: "100", text: "x" }, ctx())).toMatch(/^REPRENDRE/);
    expect(await control.run({ action: "type_keys", window: "100", text: "x" }, ctx(undefined, async () => false))).toMatch(/reprise n'a pas été accordée/);
    expect(await control.run({ action: "type_keys", window: "100", text: "x" }, ctx())).toMatch(/reprise n'a pas été accordée/); // sans porte : refus
    expect(f.sent).toEqual([]);
    expect(await control.run({ action: "type_keys", window: "100", text: "x" }, ctx(undefined, async () => true))).toBe("Texte tapé.");
    expect(f.sent).toEqual(["keys:x"]);
  });
});
