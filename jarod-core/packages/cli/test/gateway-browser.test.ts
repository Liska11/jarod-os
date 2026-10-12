// Le navigateur de l'agent côté noyau : le `BrowserPort` qui demande chaque opération à la fenêtre (geste « browser »). Fausse fenêtre ici ; le vrai pilotage de la page est
// testé côté Electron (apps/desktop/electron/agent-browser).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { createRemoteBrowser, toSnapshot } from "../src/gateway/browser.js";

const snapshot = { url: "https://example.org/", title: "Example", text: "hello", elements: [{ index: 0, tag: "a", type: "", label: "More", href: "https://example.org/more" }] };

function rig(answer: (params: Record<string, unknown>) => unknown) {
  const asked: Record<string, unknown>[] = [];
  let visible = true;
  let persistent = false;
  const browser = createRemoteBrowser({
    link: {
      ask: async (kind, params = {}) => {
        expect(kind).toBe("browser");
        asked.push(params);
        return answer(params);
      },
    },
    visible: () => visible,
    persistent: () => persistent,
  });
  return { browser, asked, set: (v: boolean, p: boolean) => ((visible = v), (persistent = p)) };
}

describe("createRemoteBrowser", () => {
  it("demande chaque opération à la fenêtre avec ses arguments et les réglages du moment, et rend l'instantané", async () => {
    const { browser, asked, set } = rig(() => ({ ok: true, snapshot }));
    expect(await browser.open("https://example.org")).toEqual(snapshot);
    set(false, true);
    await browser.click(2);
    await browser.type(1, "bonjour", true);
    await browser.press("Enter");
    await browser.scroll("down");
    await browser.back();
    await browser.wait(3, "Terminé");
    await browser.wait(1);
    await browser.read();
    expect(asked.map((a) => [a.op, a.args])).toEqual([["open", ["https://example.org"]], ["click", [2]], ["type", [1, "bonjour", true]], ["press", ["Enter"]], ["scroll", ["down"]], ["back", []], ["wait", [3, "Terminé"]], ["wait", [1]], ["read", []]]);
    expect([asked[0]!.visible, asked[0]!.persistent, asked[1]!.visible, asked[1]!.persistent]).toEqual([true, false, false, true]);
  });

  it("reveal, close et forget n'ont pas d'instantané : ils réussissent ou lèvent", async () => {
    const { browser } = rig(() => ({ ok: true }));
    await expect(browser.reveal()).resolves.toBeUndefined();
    await expect(browser.close()).resolves.toBeUndefined();
    await expect(browser.forget()).resolves.toBeUndefined();
  });

  it("un refus de la fenêtre (adresse locale, délai…) devient une erreur avec sa phrase", async () => {
    const { browser } = rig(() => ({ ok: false, error: "adresse refusée : réseau local ou interne" }));
    await expect(browser.open("http://192.168.0.1")).rejects.toThrow("adresse refusée : réseau local ou interne");
  });

  it("sans fenêtre (réponse nulle) ou avec une réponse qui n'est pas un objet : navigateur indisponible, pas un faux succès", async () => {
    for (const reply of [null, undefined, "ok", 42]) {
      const { browser } = rig(() => reply);
      await expect(browser.read(), String(reply)).rejects.toThrow(/navigateur indisponible/);
    }
  });

  it("une réponse sans `ok: true` est un refus, même avec un instantané", async () => {
    const { browser } = rig(() => ({ ok: "oui", snapshot }));
    await expect(browser.read()).rejects.toThrow(/refusé l'opération/);
  });

  it("un signal d'annulation interrompt l'attente ; déjà annulé, rien n'est demandé", async () => {
    const { browser, asked } = rig(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = browser.wait(30, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("annulé");
    await expect(browser.read(controller.signal)).rejects.toThrow("annulé");
    expect(asked).toHaveLength(1);
  });
});

describe("toSnapshot", () => {
  it("borne ce que la fenêtre dit : champs texte coupés, 200 éléments au plus, valeurs de mauvais type remplacées", () => {
    const big = toSnapshot({ url: "u".repeat(3000), title: "t".repeat(500), text: "x".repeat(70_000), elements: Array.from({ length: 300 }, (_, i) => ({ index: i, tag: "a".repeat(40), label: "l".repeat(300), href: "h".repeat(900) })) });
    expect([big.url.length, big.title.length, big.text.length, big.elements.length]).toEqual([2000, 300, 60_000, 200]);
    expect([big.elements[0]!.tag.length, big.elements[0]!.label.length, big.elements[0]!.href.length]).toEqual([20, 120, 500]);
    expect(toSnapshot({ url: 5, title: null, text: {}, elements: "x" })).toEqual({ url: "", title: "", text: "", elements: [] });
    expect(toSnapshot(null)).toEqual({ url: "", title: "", text: "", elements: [] });
    expect(toSnapshot({ elements: [null, { index: "x" }] }).elements.map((e) => e.index)).toEqual([0, 1]);
  });
});

describe("branché sur le vrai noyau", () => {
  it("les outils browser_* n'existent qu'avec l'hôte : ils apparaissent à l'attache et disparaissent au détachement", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarod-gw-browser-"));
    try {
      const pm = new ProfileManager(root);
      pm.create("travail");
      pm.setActive("travail");
      const { core } = await openCore({ env: { JAROD_HOME: root } });
      try {
        const tools = (core.app as unknown as { tools: { attachBrowser(p: unknown): () => void } }).tools;
        const names = () => core.tools.all().map((t) => t.name).filter((n) => n.startsWith("browser_"));
        expect(names()).toEqual([]);
        const { browser } = rig(() => ({ ok: true }));
        const detach = tools.attachBrowser(browser);
        expect(names()).toEqual(expect.arrayContaining(["browser_open", "browser_read", "browser_click", "browser_type", "browser_close"]));
        detach();
        expect(names()).toEqual([]);
      } finally {
        await core.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
