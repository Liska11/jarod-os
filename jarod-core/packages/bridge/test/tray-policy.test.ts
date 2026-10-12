/**
 * SPECS-P5-TRAY.md § 5 — la LOGIQUE de la zone de notification, sur des ports doublés (aucun Electron) : fermer la fenêtre, le conseil d'une seule fois, le démarrage avec la
 * session (jamais hors version empaquetée), le démarrage caché, le menu, l'icône. Barres figées dans la spec AVANT le code.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { handleWindowClose, launchAtLoginView, setLaunchAtLogin, startsHidden, trayIconPath, trayMenuItems } from "../src/main/tray-policy.js";

function rig(o: { closeToTray?: boolean; quitting?: boolean; hintShown?: boolean; platform?: NodeJS.Platform } = {}) {
  const calls: string[] = [];
  const state = { closeToTray: o.closeToTray ?? true, quitting: o.quitting ?? false, hintShown: o.hintShown ?? false };
  const win = { hide: () => void calls.push("hide"), isDestroyed: () => false };
  const deps = {
    platform: o.platform ?? ("win32" as NodeJS.Platform),
    closeToTray: () => state.closeToTray,
    quitting: () => state.quitting,
    hintShown: () => state.hintShown,
    markHintShown: () => {
      calls.push("mark");
      state.hintShown = true;
    },
    showHint: () => void calls.push("hint"),
  };
  const close = () => {
    let prevented = false;
    const result = handleWindowClose({ preventDefault: () => void (prevented = true) }, win, deps);
    return { result, prevented };
  };
  return { calls, state, close, win, deps };
}

describe("fermer la fenêtre", () => {
  it("TY1 closeToTray vrai, aucune sortie en cours : la fermeture est empêchée, la fenêtre est cachée (jamais détruite)", () => {
    const r = rig();
    expect(r.close()).toEqual({ result: "hidden", prevented: true });
    expect(r.calls).toContain("hide");
  });

  it("TY2 closeToTray faux : la fermeture suit son cours (rien n'est caché, aucun conseil)", () => {
    const r = rig({ closeToTray: false });
    expect(r.close()).toEqual({ result: "closing", prevented: false });
    expect(r.calls).toEqual([]);
  });

  it("TY3 une sortie en cours (« Quit », app.quit, redémarrage, mise à jour, fin de session) n'est JAMAIS empêchée, même closeToTray vrai ; hors Windows le comportement actuel est gardé", () => {
    const quitting = rig({ quitting: true });
    expect(quitting.close()).toEqual({ result: "closing", prevented: false });
    expect(quitting.calls).toEqual([]);
    for (const platform of ["darwin", "linux"] as const) {
      const other = rig({ platform });
      expect(other.close(), platform).toEqual({ result: "closing", prevented: false });
    }
  });

  it("TY4 le réglage est relu à CHAQUE fermeture : vrai puis faux entre deux fermetures, la seconde quitte", () => {
    const r = rig();
    expect(r.close().prevented).toBe(true);
    r.state.closeToTray = false;
    expect(r.close().prevented).toBe(false);
    r.state.closeToTray = true;
    expect(r.close().prevented).toBe(true);
  });

  it("TY5 le conseil : la PREMIÈRE fermeture cachée donne UN conseil et écrit trayHintShown ; les suivantes, aucun ; closeToTray faux : aucun conseil, le champ reste faux", () => {
    const r = rig();
    r.close();
    r.close();
    r.close();
    expect(r.calls.filter((c) => c === "hint")).toHaveLength(1);
    expect(r.calls.filter((c) => c === "mark")).toHaveLength(1);
    expect(r.state.hintShown).toBe(true);
    const off = rig({ closeToTray: false });
    off.close();
    expect(off.calls).toEqual([]);
    expect(off.state.hintShown).toBe(false);
    const already = rig({ hintShown: true });
    already.close();
    expect(already.calls).toEqual(["hide"]);
  });
});

describe("démarrer avec la session", () => {
  const port = (packaged: boolean, initial = false) => {
    const log: string[] = [];
    let on = initial;
    return {
      log,
      port: {
        packaged,
        get: () => {
          log.push("get");
          return on;
        },
        set: (v: boolean) => {
          log.push(`set:${v}`);
          on = v;
        },
      },
    };
  };

  it("TY6 l'entrée de démarrage n'est écrite QUE dans une version empaquetée : sinon JAMAIS appelée, refus avec la raison ; sans port, refus", () => {
    const p = port(true);
    setLaunchAtLogin(p.port, true);
    setLaunchAtLogin(p.port, false);
    expect(p.log).toEqual(["set:true", "set:false"]);
    const dev = port(false);
    expect(() => setLaunchAtLogin(dev.port, true)).toThrow(/version empaquetée/);
    expect(dev.log, "jamais appelée hors version empaquetée").toEqual([]);
    expect(() => setLaunchAtLogin(undefined, true)).toThrow(/indisponible/);
  });

  it("TH3 (logique) la valeur affichée vient du SYSTÈME (le port), pas du réglage ; hors version empaquetée : faux et indisponible, sans lire le système", () => {
    const p = port(true, true);
    expect(launchAtLoginView(p.port)).toEqual({ value: true, available: true });
    const dev = port(false, true);
    expect(launchAtLoginView(dev.port)).toEqual({ value: false, available: false });
    expect(dev.log).toEqual([]);
    expect(launchAtLoginView(undefined)).toEqual({ value: false, available: false });
  });

  it("TY7 le démarrage avec --hidden ne montre pas la fenêtre ; sans, il la montre ; un autre argument ne compte pas", () => {
    expect(startsHidden(["electron.exe", "--hidden"])).toBe(true);
    expect(startsHidden(["electron.exe"])).toBe(false);
    expect(startsHidden(["electron.exe", "--hidden-x", "hidden"])).toBe(false);
  });
});

describe("le menu et l'icône", () => {
  it("TY8 le menu n'a que « Show Jarod-One » et « Quit », câblés sur montrer et quitter", () => {
    const show = vi.fn();
    const quit = vi.fn();
    const items = trayMenuItems(show, quit);
    expect(items.map((i) => i.label)).toEqual(["Show Jarod-One", "Quit"]);
    items[0]!.click();
    expect([show.mock.calls.length, quit.mock.calls.length]).toEqual([1, 0]);
    items[1]!.click();
    expect([show.mock.calls.length, quit.mock.calls.length]).toEqual([1, 1]);
  });

});

describe("première fermeture : « Rester dans la barre des tâches ? » (décision du 2026-10-05)", () => {
  function ask(answer: "stay" | "quit" | "error", o: { hintShown?: boolean } = {}) {
    const r = rig({ hintShown: o.hintShown ?? false });
    const pending: { resolve: (v: "stay" | "quit") => void; reject: (e: Error) => void }[] = [];
    const asked = { n: 0 };
    const deps = {
      ...r.deps,
      askFirstClose: () => {
        asked.n++;
        return new Promise<"stay" | "quit">((resolve, reject) => pending.push({ resolve, reject }));
      },
      chooseQuit: () => {
        r.state.closeToTray = false;
        r.calls.push("quit");
      },
    };
    const close = () => {
      let prevented = false;
      const result = handleWindowClose({ preventDefault: () => void (prevented = true) }, r.win, deps);
      return { result, prevented };
    };
    const reply = async () => {
      if (answer === "error") pending.at(-1)!.reject(new Error("boîte indisponible"));
      else pending.at(-1)!.resolve(answer);
      await new Promise((ok) => setTimeout(ok, 0));
    };
    return { r, close, reply, asked };
  }

  it("la première croix pose la question (fermeture empêchée, rien n'est caché avant la réponse) ; « Rester » cache, retient le choix, sans ballon", async () => {
    const t = ask("stay");
    expect(t.close()).toEqual({ result: "asking", prevented: true });
    expect(t.r.calls).toEqual([]);
    await t.reply();
    expect(t.r.calls).toEqual(["hide", "mark"]);
    expect(t.r.state.closeToTray).toBe(true);
    expect(t.r.calls).not.toContain("hint");
  });

  it("« Quitter » : le choix est retenu (closeToTray faux, question close) et l'application quitte ; rien n'est caché", async () => {
    const t = ask("quit");
    t.close();
    await t.reply();
    expect(t.r.calls).toEqual(["mark", "quit"]);
    expect(t.r.state.closeToTray).toBe(false);
  });

  it("une seconde croix pendant la boîte ne la repose pas", () => {
    const t = ask("stay");
    t.close();
    expect(t.close()).toEqual({ result: "asking", prevented: true });
    expect(t.asked.n).toBe(1);
  });

  it("boîte en erreur : la fenêtre est cachée (jamais perdue) et la question reviendra (rien de retenu)", async () => {
    const t = ask("error");
    t.close();
    await t.reply();
    expect(t.r.calls).toEqual(["hide"]);
    expect(t.r.state.hintShown).toBe(false);
    expect(t.close().result).toBe("asking");
  });

  it("question déjà répondue (hintShown) : plus jamais posée, comportement habituel ; une sortie en cours n'est jamais retenue", () => {
    const answered = ask("stay", { hintShown: true });
    expect(answered.close()).toEqual({ result: "hidden", prevented: true });
    expect(answered.asked.n).toBe(0);
    const t = ask("stay");
    t.r.state.quitting = true;
    expect(t.close()).toEqual({ result: "closing", prevented: false });
    expect(t.asked.n).toBe(0);
  });
});
