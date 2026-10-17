// E2 — la préparation du branchement à l'hôte : éteint par défaut, rien ne démarre avant le premier accord, le réglage est relu à chaque opération.
import { describe, expect, it } from "vitest";
import {
  AdapterRefused,
  type BrowserApprovalRequest,
  type BrowserBackend,
  ConnectedBrowserHost,
  type ConnectedBrowserHostDeps,
  discoverEnginePaths,
  type GuardedSession,
  type GuardedSessionOptions,
  prepareConnectedBrowser,
  type TabRef,
} from "../src/index.js";

const PATHS = { chromeBin: "C:/x/chrome.exe", python: "C:/x/python.exe", bridge: "C:/x/bh_ops.py" };

function world(settings: { v: unknown }, over: Partial<ConnectedBrowserHostDeps> = {}) {
  const starts: GuardedSessionOptions[] = [];
  const closed: string[] = [];
  const asked: BrowserApprovalRequest[] = [];
  const tabs: TabRef[] = [];
  const backend: BrowserBackend = {
    engine: "browser-harness",
    listTabs: async () => tabs.map((t) => ({ ...t })),
    readPage: async () => ({ text: "contenu", passwordFields: 0 }),
    navigate: async () => undefined,
    openTab: async (u) => (tabs.push({ id: `t${tabs.length + 1}`, url: u, title: "x" }), `t${tabs.length}`),
    closeTab: async () => undefined,
    click: async () => undefined,
    typeText: async () => undefined,
    pressKey: async () => undefined,
    isPasswordField: async () => false,
  };
  const deps: ConnectedBrowserHostDeps = {
    settings: () => settings.v,
    engine: () => PATHS,
    approve: async (r) => (asked.push(r), true),
    start: async (o) => {
      starts.push(o);
      return { browser: { cdpUrl: "http://127.0.0.1:1", profileDir: "x", close: async () => undefined }, guard: { healthy: true, stats: { allowed: 0, blocked: 2 } }, backend, revoke: async () => void closed.push("closed"), close: async () => void closed.push("closed") } as unknown as GuardedSession;
    },
    ...over,
  };
  const attached: unknown[] = [];
  const tools = { attachConnectedBrowser: (p: unknown) => (attached.push(p), () => void attached.pop()) };
  return { deps, starts, closed, asked, tabs, attached, tools };
}

describe("prepareConnectedBrowser — éteint par défaut", () => {
  it("réglage absent, vide, éteint, illisible : RIEN n'est branché et rien ne démarre", () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      [],
      "oui",
      3,
      { enabled: false, allowDomains: ["exemple.org"] },
      { enabled: true },
      { enabled: true, allowDomains: [] },
      { enabled: "true", allowDomains: ["exemple.org"] },
      { enabled: true, allowDomains: ["*", "com", "localhost", "127.0.0.1"] },
    ];
    for (const v of cases) {
      const w = world({ v });
      const p = prepareConnectedBrowser(w.tools, w.deps);
      expect(p.attached, JSON.stringify(v)).toBe(false);
      expect(p.reason).toBeTruthy();
      expect(w.attached).toHaveLength(0);
      expect(w.starts).toHaveLength(0);
    }
  });

  it("activé avec un domaine mais moteur absent : rien n'est branché", () => {
    const w = world({ v: { enabled: true, allowDomains: ["exemple.org"] } }, { engine: () => null });
    expect(prepareConnectedBrowser(w.tools, w.deps)).toMatchObject({ attached: false, reason: expect.stringMatching(/moteur/) });
    expect(w.attached).toHaveLength(0);
  });

  it("activé, domaine, moteur présent : l'outil est branché — mais AUCUN navigateur ne démarre", () => {
    const w = world({ v: { enabled: true, allowDomains: ["exemple.org"] } });
    const p = prepareConnectedBrowser(w.tools, w.deps);
    expect(p.attached).toBe(true);
    expect(w.attached).toHaveLength(1);
    expect(w.starts).toHaveLength(0);
    expect(p.host?.status()).toMatchObject({ state: "idle" });
  });
});

describe("ConnectedBrowserHost — rien ne démarre avant l'accord, le réglage est relu", () => {
  it("lister les onglets avant toute session ne lance rien et rend une liste vide", async () => {
    const w = world({ v: { enabled: true, allowDomains: ["exemple.org"] } });
    const h = new ConnectedBrowserHost(w.deps);
    expect(await h.listTabs()).toEqual([]);
    expect(w.starts).toHaveLength(0);
  });

  it("une action refusée ne lance rien ; approuvée, elle lance UNE session avec la MÊME liste de domaines que le contrôleur", async () => {
    const settings = { v: { enabled: true, allowDomains: ["exemple.org"], denyDomains: ["pub.exemple.org"] } };
    const w = world(settings, { approve: async (r) => (w.asked.push(r), false) });
    const h = new ConnectedBrowserHost(w.deps);
    await expect(h.openTab("https://exemple.org/")).rejects.toThrow(/non accordée/);
    expect(w.starts).toHaveLength(0);
    const ok = world(settings);
    const h2 = new ConnectedBrowserHost(ok.deps);
    await h2.openTab("https://exemple.org/a");
    await h2.openTab("https://exemple.org/b");
    expect(ok.starts).toHaveLength(1);
    expect(ok.starts[0]!.policy).toMatchObject({ allowDomains: ["exemple.org"], denyDomains: ["pub.exemple.org"] });
    expect(ok.asked.map((a) => a.op)).toEqual(["open_tab", "open_tab"]);
    expect(h2.status()).toMatchObject({ state: "running", blocked: 2 });
  });

  it("hors liste : refusé avant toute demande d'accord, aucune session", async () => {
    const w = world({ v: { enabled: true, allowDomains: ["exemple.org"] } });
    const h = new ConnectedBrowserHost(w.deps);
    await expect(h.openTab("https://autre.net/")).rejects.toThrow(AdapterRefused);
    expect(w.asked).toHaveLength(0);
    expect(w.starts).toHaveLength(0);
  });

  it("éteint ou vidé ENTRE deux opérations : la session est fermée et l'opération refusée, sans rien demander", async () => {
    const settings = { v: { enabled: true, allowDomains: ["exemple.org"] } as unknown };
    const w = world(settings);
    const h = new ConnectedBrowserHost(w.deps);
    await h.openTab("https://exemple.org/");
    settings.v = { enabled: false, allowDomains: ["exemple.org"] };
    const asked = w.asked.length;
    await expect(h.openTab("https://exemple.org/")).rejects.toThrow(/désactivé/);
    expect(w.closed).toEqual(["closed"]);
    expect(w.asked.length).toBe(asked);
    expect(h.status().state).toBe("disabled");
    settings.v = { enabled: true, allowDomains: [] };
    await expect(h.listTabs()).rejects.toThrow(/désactivé/);
  });

  it("un autre jeu de domaines : l'ancienne session est fermée, une neuve démarre avec la nouvelle garde (jamais deux listes différentes)", async () => {
    const settings = { v: { enabled: true, allowDomains: ["exemple.org"] } as unknown };
    const w = world(settings);
    const h = new ConnectedBrowserHost(w.deps);
    await h.openTab("https://exemple.org/");
    settings.v = { enabled: true, allowDomains: ["exemple.org", "autre.net"] };
    await h.openTab("https://autre.net/");
    expect(w.starts.map((s) => s.policy.allowDomains)).toEqual([["exemple.org"], ["exemple.org", "autre.net"]]);
    expect(w.closed).toEqual(["closed"]);
  });

  it("démarrage impossible (garde non démontrée) : l'opération échoue et l'état le dit", async () => {
    const w = world({ v: { enabled: true, allowDomains: ["exemple.org"] } }, {
      start: async () => {
        throw new Error("garde réseau : l'interception obligatoire n'est pas démontrée");
      },
    });
    const h = new ConnectedBrowserHost(w.deps);
    await expect(h.openTab("https://exemple.org/")).rejects.toThrow(/interception obligatoire/);
    expect(h.status()).toMatchObject({ state: "failed", reason: expect.stringMatching(/interception/) });
  });

  it("deux ouvertures simultanées ne lancent qu'UNE session", async () => {
    const w = world({ v: { enabled: true, allowDomains: ["exemple.org"] } });
    const h = new ConnectedBrowserHost(w.deps);
    await Promise.all([h.openTab("https://exemple.org/1"), h.openTab("https://exemple.org/2")]);
    expect(w.starts).toHaveLength(1);
  });
});

describe("discoverEnginePaths — ne regarde que le moteur épinglé et le Chromium de Playwright", () => {
  const win = { root: "C:/r", platform: "win32" as const, env: { LOCALAPPDATA: "C:/Users/u/AppData/Local" } };
  const norm = (p: string) => p.split("\\").join("/");
  it("trouve le Chromium le plus récent ; rien si le venv, le pont ou le navigateur manquent", () => {
    const have = new Set([
      "C:/r/engines/browser-harness/Scripts/python.exe",
      "C:/r/jarod-core/sidecars/browser-bridge/bh_ops.py",
      "C:/Users/u/AppData/Local/ms-playwright",
      "C:/Users/u/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
    ]);
    const exists = (p: string) => have.has(norm(p));
    const list = () => ["chromium-1100", "chromium-1243", "chromium_headless_shell-1243", "ffmpeg-1011"];
    expect(norm(discoverEnginePaths({ ...win, exists, list })?.chromeBin ?? "")).toBe("C:/Users/u/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");
    for (const missing of [...have].filter((p) => !p.endsWith("ms-playwright"))) {
      expect(discoverEnginePaths({ ...win, exists: (p) => exists(p) && norm(p) !== missing, list })).toBeNull();
    }
  });
  it("ne consulte jamais un dossier de profil ni un Chrome installé pour l'usage quotidien", () => {
    const seen: string[] = [];
    discoverEnginePaths({ ...win, exists: (p) => (seen.push(p), false), list: () => [] });
    expect(seen.join("\n")).not.toMatch(/User Data|Google|Application|google-chrome/i);
  });
});
