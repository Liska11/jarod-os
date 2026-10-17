// E2 — le cycle de vie dans l'application : éteint par défaut, rebranchement à chaud, révocation immédiate, arrêt propre.
import { describe, expect, it } from "vitest";
import { type BrowserBackend, type GuardedSession, type GuardedSessionOptions, startConnectedBrowserLifecycle, type TabRef } from "../src/index.js";

const PATHS = { chromeBin: "C:/x/chrome.exe", python: "C:/x/python.exe", bridge: "C:/x/bh_ops.py" };

function app(initial: unknown, over: { engine?: () => typeof PATHS | null } = {}) {
  const setting = { v: initial };
  const listeners = new Set<() => void>();
  const attached: unknown[] = [];
  const events: string[] = [];
  const starts: GuardedSessionOptions[] = [];
  const revoked: string[] = [];
  const tabs: TabRef[] = [];
  const backend: BrowserBackend = {
    engine: "browser-harness",
    listTabs: async () => tabs.map((t) => ({ ...t })),
    readPage: async () => ({ text: "x", passwordFields: 0 }),
    navigate: async () => undefined,
    openTab: async (u) => (tabs.push({ id: "t1", url: u, title: "x" }), "t1"),
    closeTab: async () => undefined,
    click: async () => undefined,
    typeText: async () => undefined,
    pressKey: async () => undefined,
    isPasswordField: async () => false,
  };
  const tools = {
    attachConnectedBrowser: (p: unknown) => (attached.push(p), events.push("attach"), () => (attached.splice(attached.indexOf(p), 1), events.push("detach"))),
    approveConnectedBrowser: async () => true,
  };
  const settings = {
    get: () => setting.v,
    onChange: (_k: "connectedBrowser", cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb)),
  };
  const change = async (v: unknown) => {
    setting.v = v;
    for (const l of [...listeners]) l();
    await lc.sync();
  };
  const lc = startConnectedBrowserLifecycle({
    tools,
    settings,
    engine: over.engine ?? (() => PATHS),
    hostOverrides: {
      start: async (o) => {
        starts.push(o);
        return { browser: { cdpUrl: "http://127.0.0.1:1", profileDir: "x", close: async () => undefined }, guard: { healthy: true, reason: "", stats: { allowed: 0, blocked: 0 } }, backend, revoke: async (why?: string) => void revoked.push(why ?? "?"), close: async () => void revoked.push("close") } as unknown as GuardedSession;
      },
    },
  });
  return { lc, change, attached, events, starts, revoked, listeners };
}

describe("startConnectedBrowserLifecycle — éteint par défaut", () => {
  it("réglage absent, éteint, sans domaine, ou moteur absent : aucun outil, aucun lancement", async () => {
    for (const v of [undefined, {}, { enabled: false, allowDomains: ["exemple.org"] }, { enabled: true }, { enabled: true, allowDomains: [] }, { enabled: true, allowDomains: ["*", "com"] }]) {
      const a = app(v);
      await a.lc.sync();
      expect(a.attached, JSON.stringify(v)).toHaveLength(0);
      expect(a.starts).toHaveLength(0);
      expect(a.lc.status().state).toMatch(/disabled/);
      await a.lc.stop();
    }
    const noEngine = app({ enabled: true, allowDomains: ["exemple.org"] }, { engine: () => null });
    await noEngine.lc.sync();
    expect(noEngine.attached).toHaveLength(0);
    expect(noEngine.lc.status()).toMatchObject({ state: "no-engine" });
    await noEngine.lc.stop();
  });

  it("activer sans domaine : rien ; ajouter un domaine : l'outil apparaît à chaud, sans navigateur ; l'éteindre : il disparaît", async () => {
    const a = app({ enabled: false, allowDomains: [] });
    await a.change({ enabled: true, allowDomains: [] });
    expect(a.attached).toHaveLength(0);
    await a.change({ enabled: true, allowDomains: ["exemple.org"] });
    expect(a.attached).toHaveLength(1);
    expect(a.starts).toHaveLength(0);
    await a.change({ enabled: false, allowDomains: ["exemple.org"] });
    expect(a.attached).toHaveLength(0);
    expect(a.events).toEqual(["attach", "detach"]);
    await a.lc.stop();
  });

  it("désactivation ou retrait d'un domaine avec une session ouverte : la session est révoquée AUSSITÔT, sans attendre une opération", async () => {
    const a = app({ enabled: true, allowDomains: ["exemple.org", "autre.net"] });
    await a.lc.sync();
    const host = (a.attached[0] ?? null) as { openTab(u: string): Promise<string> } | null;
    expect(host).not.toBeNull();
    await host!.openTab("https://exemple.org/");
    expect(a.starts).toHaveLength(1);
    await a.change({ enabled: true, allowDomains: ["exemple.org"] }); // un domaine retiré
    expect(a.revoked).toEqual(["jeu de domaines changé"]);
    expect(a.attached).toHaveLength(1); // l'outil reste (il reste un domaine), la session, non
    await host!.openTab("https://exemple.org/");
    expect(a.starts).toHaveLength(2); // nouvelle session, nouvelle garde, jeu neuf
    expect(a.starts[1]!.policy.allowDomains).toEqual(["exemple.org"]);
    await a.change({ enabled: false, allowDomains: ["exemple.org"] });
    expect(a.revoked.length).toBe(2);
    expect(a.attached).toHaveLength(0);
    await a.lc.stop();
  });

  it("l'arrêt de l'application révoque la session, débranche l'outil et se désabonne des réglages", async () => {
    const a = app({ enabled: true, allowDomains: ["exemple.org"] });
    await a.lc.sync();
    await (a.attached[0] as { openTab(u: string): Promise<string> }).openTab("https://exemple.org/");
    await a.lc.stop();
    expect(a.attached).toHaveLength(0);
    expect(a.revoked).toHaveLength(1);
    expect(a.listeners.size).toBe(0);
    await a.lc.sync(); // plus rien ne se rebranche après l'arrêt
    expect(a.attached).toHaveLength(0);
  });
});
