/**
 * Navigateur de l'agent (SPECS-P5-UI-PARITE.md §6) : l'implémentation Electron du `BrowserPort` de plugin-tools — UNE fenêtre, isolée du
 * profil de l'utilisateur, que les outils `browser_*` pilotent.
 *
 * Isolation (ce que la page ne peut PAS faire) :
 * - session EN MÉMOIRE par défaut (`partition` sans `persist:`) : aucun cookie, aucune connexion, aucun stockage de l'utilisateur ; oubliée à
 *   `close()`. Option `persistent` (réglage `browserPersistent`) : session propre à l'agent GARDÉE sur disque — jamais celle de l'application, ni celle
 *   d'un autre navigateur — pour qu'une connexion faite une fois (par l'utilisateur, `browser_handoff`) serve aux fois suivantes ; `forget()` l'efface ;
 * - pas de Node, pas de preload, bac à sable, isolation de contexte ; les scripts de l'application tournent dans un MONDE ISOLÉ (la page ne
 *   peut ni les lire ni les falsifier) ;
 * - permissions (caméra, micro, localisation, notifications…) toutes refusées ; téléchargements annulés ; `window.open` n'ouvre pas de fenêtre :
 *   l'adresse est chargée dans la même page, après les mêmes contrôles ;
 * - seules les adresses http(s) vont sur le réseau, et JAMAIS vers la machine ou le réseau local (boucle locale, réseaux privés, liens locaux,
 *   noms internes) : contrôle de CHAQUE requête (redirections et sous-ressources comprises), y compris par résolution DNS (un nom public qui
 *   pointe sur une adresse privée est refusé). Reste une fenêtre de course entre notre résolution et celle de Chromium : limite connue ;
 * - aucune saisie dans un champ mot de passe ; texte et éléments bornés (`browser-tools.ts`).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BROWSER_KEYS, type BrowserElement, type BrowserPort, type BrowserSnapshot } from "./types.ts";

const ISOLATED_WORLD = 1004;
const LOAD_TIMEOUT_MS = 30_000;
/** Attente du DÉBUT d'une navigation après une action qui peut en lancer une (clic, Entrée, envoi, retour) ; les autres actions attendent `QUIET_MS`. */
const SETTLE_MS = 1500;
const QUIET_MS = 300;
const SCROLL_MS = 800;
const SETTLE_POLL_MS = 50;
const SETTLE_AFTER_MS = 250;
const SETTLE_MAX_MS = 10_000;
const DNS_CACHE_MS = 60_000;
const WAIT_POLL_MS = 250;
const MEMORY_PARTITION = "jarod-agent-browser";
const PERSIST_PARTITION = "persist:jarod-agent-browser";
/** Touches de l'agent → valeurs des événements clavier (`key`, `code`, `keyCode`) et caractère produit. */
const KEY_EVENTS: Record<string, { key: string; code: string; vk: number; char?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, char: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Space: { key: " ", code: "Space", vk: 32, char: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
};

/**
 * Une touche, appliquée DANS LE MONDE ISOLÉ (aucun accès au clavier du système, aucun protocole de débogage : le clavier natif n'atteint pas une
 * fenêtre cachée, et l'attacher au moteur était instable). Les événements `keydown` / `keypress` / `keyup` sont envoyés à l'élément actif — la
 * page peut les écouter et annuler le `keydown` — puis, si elle ne l'a pas annulé, l'action PAR DÉFAUT de la touche est appliquée à la main :
 * Entrée valide le formulaire ou active le bouton/lien, Espace active une case ou un bouton (ou s'insère), Tab passe au suivant, Retour arrière /
 * Suppr effacent, les flèches déplacent le curseur ou la liste ou font défiler la page. Les événements ne sont pas « de confiance » (`isTrusted`
 * faux) : une page qui l'exige les ignorera, et l'agent peut alors passer la main à l'utilisateur (`browser_handoff`).
 */
const KEY_JS = (k: { key: string; code: string; vk: number; char?: string }, name: string): string => `(() => {
  const name = ${JSON.stringify(name)};
  const init = { key: ${JSON.stringify(k.key)}, code: ${JSON.stringify(k.code)}, keyCode: ${k.vk}, which: ${k.vk}, bubbles: true, cancelable: true };
  const active = document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement ? document.activeElement : null;
  const t = active || document.body;
  const tag = t.tagName;
  const type = (t.type || '').toString().toLowerCase();
  const pressable = tag === 'BUTTON' || tag === 'A' || (tag === 'INPUT' && ['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(type));
  const textual = tag === 'TEXTAREA' || t.isContentEditable || (tag === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'range', 'color', 'hidden'].includes(type));
  const setValue = (v) => {
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (set) set.call(t, v); else t.value = v;
    t.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const insert = (text) => {
    if (t.isContentEditable) { t.textContent = (t.textContent || '') + text; t.dispatchEvent(new Event('input', { bubbles: true })); return; }
    const a = t.selectionStart ?? t.value.length, b = t.selectionEnd ?? a;
    setValue(t.value.slice(0, a) + text + t.value.slice(b));
    try { t.setSelectionRange(a + text.length, a + text.length); } catch (_) {}
  };
  const erase = (before) => {
    if (t.isContentEditable) { t.textContent = (t.textContent || '').slice(0, -1); t.dispatchEvent(new Event('input', { bubbles: true })); return; }
    let a = t.selectionStart ?? t.value.length, b = t.selectionEnd ?? a;
    if (a === b) { if (before) a = Math.max(0, a - 1); else b = Math.min(t.value.length, b + 1); }
    setValue(t.value.slice(0, a) + t.value.slice(b));
    try { t.setSelectionRange(a, a); } catch (_) {}
  };
  const caret = (to) => { try { t.setSelectionRange(to, to); } catch (_) {} };
  const focusables = () => [...document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[tabindex]')].filter((e) => !e.disabled && e.tabIndex >= 0 && e.getBoundingClientRect().width > 0);
  const page = Math.round(window.innerHeight * 0.85);
  let prevented = !t.dispatchEvent(new KeyboardEvent('keydown', init));
  if (!prevented && ${JSON.stringify(Boolean(k.char))}) prevented = !t.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: ${k.char ? k.char.charCodeAt(0) : 0} }));
  if (!prevented) {
    switch (name) {
      case 'Enter':
        if (pressable) t.click();
        else if (tag === 'INPUT' && t.form) { if (t.form.requestSubmit) t.form.requestSubmit(); else t.form.submit(); }
        else if (textual) insert('\\n');
        break;
      case 'Space':
        if (pressable) t.click();
        else if (textual) insert(' ');
        else window.scrollBy(0, page);
        break;
      case 'Tab': {
        const list = focusables();
        const next = list[(list.indexOf(t) + 1) % Math.max(list.length, 1)];
        if (next) next.focus();
        break;
      }
      case 'Backspace': if (textual) erase(true); break;
      case 'Delete': if (textual) erase(false); break;
      case 'ArrowLeft': if (textual && !t.isContentEditable) caret(Math.max(0, (t.selectionStart ?? 0) - 1)); else if (!textual) window.scrollBy(-60, 0); break;
      case 'ArrowRight': if (textual && !t.isContentEditable) caret((t.selectionEnd ?? 0) + 1); else if (!textual) window.scrollBy(60, 0); break;
      case 'ArrowDown':
        if (tag === 'SELECT') { t.selectedIndex = Math.min(t.options.length - 1, t.selectedIndex + 1); t.dispatchEvent(new Event('change', { bubbles: true })); }
        else if (!textual) window.scrollBy(0, 60);
        break;
      case 'ArrowUp':
        if (tag === 'SELECT') { t.selectedIndex = Math.max(0, t.selectedIndex - 1); t.dispatchEvent(new Event('change', { bubbles: true })); }
        else if (!textual) window.scrollBy(0, -60);
        break;
      case 'PageDown': if (!textual) window.scrollBy(0, page); break;
      case 'PageUp': if (!textual) window.scrollBy(0, -page); break;
      case 'Home': if (textual && !t.isContentEditable) caret(0); else if (!textual) window.scrollTo(0, 0); break;
      case 'End': if (textual && !t.isContentEditable) caret(t.value.length); else if (!textual) window.scrollTo(0, document.documentElement.scrollHeight); break;
      default: break;
    }
  }
  t.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, prevented };
})()`;

/** Adresse (déjà normalisée par `URL`) qui désigne cette machine, un réseau local ou un nom interne. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  const v = isIP(host);
  if (v === 4) return isPrivateV4(host);
  if (v === 6) return isPrivateV6(host);
  return false;
}

function isPrivateV4(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, réservé, diffusion
  );
}

function isPrivateV6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    if (mapped[2] === undefined) return isPrivateV4(mapped[1]!);
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("ff"); // fc00::/7, fe80::/10, multicast
}

/** L'adresse demandée par l'agent : http(s) seulement, sans identifiants, sans cible locale. Lève avec la raison. */
export function checkBrowserUrl(raw: string, allowLoopback = false): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`Adresse invalide : ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Adresse refusée (${u.protocol} non autorisé) : seules les adresses http(s) s'ouvrent.`);
  if (u.username || u.password) throw new Error("Adresse refusée : elle contient des identifiants.");
  if (!allowLoopback && isPrivateHost(u.hostname)) throw new Error(`Adresse refusée : « ${u.hostname} » est local ou interne (le navigateur de l'agent ne visite que l'Internet public).`);
  return u;
}

/** Les morceaux d'Electron dont on a besoin (injectés : ce module ne l'importe pas). */
export interface ElectronBits {
  BrowserWindow: new (o: Record<string, unknown>) => ElectronWindow;
  session: { fromPartition(name: string): ElectronSession };
}
interface ElectronSession {
  setPermissionRequestHandler(h: (...a: unknown[]) => void): void;
  setPermissionCheckHandler(h: () => boolean): void;
  on(event: "will-download", h: (e: { preventDefault(): void }) => void): void;
  webRequest: { onBeforeRequest(h: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void): void };
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}
interface ElectronWindow {
  webContents: ElectronWebContents;
  show(): void;
  focus(): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: "closed", h: () => void): void;
}
interface ElectronWebContents {
  loadURL(url: string): Promise<void>;
  stop(): void;
  isLoading(): boolean;
  getURL(): string;
  getTitle(): string;
  executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]): Promise<unknown>;
  setWindowOpenHandler(h: (d: { url: string }) => { action: "deny" }): void;
  once(event: "did-stop-loading", h: () => void): void;
  removeListener(event: "did-stop-loading", h: () => void): void;
  setUserAgent(ua: string): void;
  getUserAgent(): string;
  focus(): void;
  navigationHistory: { getActiveIndex(): number; goToIndex(index: number): void };
}

const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true],[contenteditable=""]';
  const els = [...document.querySelectorAll(sel)].filter(vis).slice(0, 200);
  window.__jarodEls = els;
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  return {
    url: location.href,
    title: document.title || '',
    text: (document.body ? document.body.innerText : '').slice(0, 60000),
    elements: els.map((el, i) => ({ index: i, tag: el.tagName.toLowerCase(), type: (el.type || '').toString(), label: label(el), href: el.href ? String(el.href) : '' })),
  };
})()`;

const ACT_JS = (index: number, typing: { text: string; submit: boolean } | null): string => `(() => {
  const el = (window.__jarodEls || [])[${index}];
  if (!el || !el.isConnected) return { error: 'élément introuvable : relisez la page (browser_read) pour obtenir les numéros à jour' };
  el.scrollIntoView({ block: 'center' });
  ${
    typing
      ? `if ((el.type || '').toLowerCase() === 'password') return { error: 'saisie refusée : champ de mot de passe' };
  const text = ${JSON.stringify(typing.text)};
  if (el.tagName === 'SELECT') { const o = [...el.options].find((o) => o.value === text || o.label === text || o.text === text); if (!o) return { error: 'option introuvable dans la liste' }; el.value = o.value; }
  else if (el.isContentEditable) { el.focus(); el.textContent = text; }
  else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    el.focus();
    const set = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    if (set) set.call(el, text); else el.value = text;
  } else return { error: "ce n'est pas un champ de saisie" };
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ${typing.submit ? `if (el.form && el.form.requestSubmit) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));` : ""}
  return { ok: true };`
      : `el.click();
  return { ok: true };`
  }
})()`;

const asString = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

function toSnapshot(raw: unknown): BrowserSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const elements: BrowserElement[] = Array.isArray(r.elements)
    ? r.elements.slice(0, 200).map((e, i) => {
        const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        return { index: typeof o.index === "number" ? o.index : i, tag: asString(o.tag, 20), type: asString(o.type, 20), label: asString(o.label, 120), href: asString(o.href, 500) };
      })
    : [];
  return { url: asString(r.url, 2000), title: asString(r.title, 300), text: asString(r.text, 60_000), elements };
}

export class AgentBrowser implements BrowserPort {
  private win: ElectronWindow | null = null;
  private ses: ElectronSession | null = null;
  /** La fenêtre en cours a-t-elle été créée sur la session persistante ? */
  private usedPersistent = false;
  private readonly configured = new WeakSet<object>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly dnsCache = new Map<string, { at: number; ok: boolean }>();

  constructor(
    private readonly d: {
      electron: ElectronBits;
      /** `browserVisible` : la fenêtre se montre (sans prendre le focus) ou reste cachée. */
      visible(): boolean;
      /** `browserPersistent` : session gardée sur disque (voir l'en-tête). Lue à la création de la fenêtre. */
      persistent?(): boolean;
      /** Tests seulement : échelle des attentes après une action (1 = réel). */
      settleScale?: number;
      /** Tests seulement : autorise la boucle locale (serveur de test). Jamais en usage normal. */
      allowLoopback?: boolean;
      lookup?: (host: string) => Promise<string[]>;
    },
  ) {}

  /** Une opération à la fois : deux outils lancés ensemble ne se marchent pas dessus. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async hostAllowed(host: string): Promise<boolean> {
    if (this.d.allowLoopback) return true;
    if (isPrivateHost(host)) return false;
    if (isIP(host.replace(/^\[|\]$/g, ""))) return true;
    const hit = this.dnsCache.get(host);
    if (hit && Date.now() - hit.at < DNS_CACHE_MS) return hit.ok;
    let ok: boolean;
    try {
      const addrs = this.d.lookup ? await this.d.lookup(host) : (await dnsLookup(host, { all: true })).map((a) => a.address);
      ok = addrs.length > 0 && addrs.every((a) => !isPrivateHost(a));
    } catch {
      // Un nom que Node ne peut pas résoudre doit être refusé : Chromium, lui, sait interroger mDNS, LLMNR,
      // NetBIOS et le fichier hosts, donc « la résolution échoue ici » ne veut pas dire « rien n'est joint ».
      ok = false;
    }
    this.dnsCache.set(host, { at: Date.now(), ok });
    return ok;
  }

  /** Chaque requête de la page passe ici : seul le web public sort, plus `data:` / `blob:` / `about:blank` internes. */
  private async requestAllowed(raw: string): Promise<boolean> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
    return this.hostAllowed(u.hostname);
  }

  /** Pose les gardes d'une session UNE fois (une session est réutilisée d'une fenêtre à l'autre). */
  private harden(ses: ElectronSession): void {
    if (this.configured.has(ses)) return;
    this.configured.add(ses);
    ses.setPermissionRequestHandler((...a: unknown[]) => {
      const cb = a[2] as ((ok: boolean) => void) | undefined;
      cb?.(false);
    });
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (e) => e.preventDefault());
    ses.webRequest.onBeforeRequest((details, cb) => {
      void this.requestAllowed(details.url).then((ok) => cb({ cancel: !ok }));
    });
  }

  private ensure(): ElectronWindow {
    const persistent = this.d.persistent?.() === true;
    if (this.win && !this.win.isDestroyed()) {
      if (persistent === this.usedPersistent) return this.win;
      this.win.destroy(); // le réglage a changé : la fenêtre repart sur la bonne session
      this.win = null;
    }
    // Sans « persist: » : en mémoire ; avec : gardée sur disque, mais PROPRE à l'agent (jamais la session de l'application).
    const ses = this.d.electron.session.fromPartition(persistent ? PERSIST_PARTITION : MEMORY_PARTITION);
    this.ses = ses;
    this.usedPersistent = persistent;
    this.harden(ses);
    const win = new this.d.electron.BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      title: "Jarod — navigateur de l'agent",
      autoHideMenuBar: true,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, backgroundThrottling: false },
    });
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/\S+/i, ""));
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Pas de nouvelle fenêtre : la page est chargée ici, si l'adresse est permise (contrôles de `onBeforeRequest` compris).
      try {
        const u = checkBrowserUrl(url, this.d.allowLoopback);
        void win.webContents.loadURL(u.href).catch(() => {});
      } catch {
        /* adresse refusée : ignorée */
      }
      return { action: "deny" };
    });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    this.win = win;
    return win;
  }

  private show(win: ElectronWindow): void {
    if (this.d.visible()) win.showInactive();
    else win.hide();
  }

  /**
   * Après une action : laisse à la page le temps de COMMENCER une navigation (envoi d'un formulaire, clic sur un lien — une page cachée est
   * ralentie par Chromium), puis attend qu'elle finisse. Sans navigation dans `SETTLE_MS`, la page est considérée posée.
   */
  private async settle(wc: ElectronWebContents, signal?: AbortSignal, startWindow: number = SETTLE_MS): Promise<void> {
    const scale = this.d.settleScale ?? 1;
    const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * scale));
    const start = Date.now();
    while (!wc.isLoading() && Date.now() - start < startWindow * scale && !signal?.aborted) await pause(SETTLE_POLL_MS);
    if (!wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wc.removeListener("did-stop-loading", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, SETTLE_MAX_MS);
      wc.once("did-stop-loading", done);
      signal?.addEventListener("abort", done, { once: true });
    });
    await pause(SETTLE_AFTER_MS); // les scripts de la page qui s'exécutent au chargement
  }

  private async snapshot(wc: ElectronWebContents): Promise<BrowserSnapshot> {
    const s = toSnapshot(await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: SNAPSHOT_JS }]));
    // L'adresse affichée est celle que Chromium tient, pas celle que la page dit (`location` peut avoir été réécrit par un script).
    return { ...s, url: wc.getURL() || s.url, title: s.title || wc.getTitle() };
  }

  open(raw: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      const u = checkBrowserUrl(raw, this.d.allowLoopback);
      if (!(await this.hostAllowed(u.hostname))) throw new Error(`Adresse refusée : « ${u.hostname} » pointe vers une adresse locale ou interne.`);
      const win = this.ensure();
      this.show(win);
      const wc = win.webContents;
      const onAbort = () => wc.stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          wc.loadURL(u.href),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              wc.stop();
              reject(new Error(`Chargement trop long (${LOAD_TIMEOUT_MS / 1000} s).`));
            }, LOAD_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        // ERR_ABORTED : une redirection ou une navigation interne a remplacé la demande ; la page courante est celle qui compte.
        if (!/ERR_ABORTED/.test(msg)) throw new Error(signal?.aborted ? "Interrompu." : `Chargement impossible : ${msg.replace(/^Error invoking remote method '[^']+':\s*/, "")}`);
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      return this.snapshot(wc);
    });
  }

  private page(): ElectronWebContents {
    if (!this.win || this.win.isDestroyed()) throw new Error("Aucune page ouverte : utilisez d'abord browser_open.");
    return this.win.webContents;
  }

  read(signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      return this.snapshot(this.page());
    });
  }

  private act(index: number, typing: { text: string; submit: boolean } | null, signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      const wc = this.page();
      const r = (await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: ACT_JS(index, typing) }])) as { error?: string } | undefined;
      if (r?.error) throw new Error(r.error);
      // Saisie sans envoi : rien ne navigue, attente courte. Clic ou envoi : la page peut partir ailleurs.
      await this.settle(wc, signal, typing && !typing.submit ? QUIET_MS : SETTLE_MS);
      return this.snapshot(wc);
    });
  }

  click(index: number, signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.act(index, null, signal);
  }

  press(key: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      if (!(BROWSER_KEYS as readonly string[]).includes(key)) throw new Error(`Touche refusée : ${key.slice(0, 40)}`);
      const wc = this.page();
      await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: KEY_JS(KEY_EVENTS[key]!, key) }]);
      // Entrée et Espace valident, activent, cliquent : la page peut partir ailleurs. Les autres touches ne naviguent pas.
      await this.settle(wc, signal, key === "Enter" || key === "Space" ? SETTLE_MS : QUIET_MS);
      return this.snapshot(wc);
    });
  }

  scroll(direction: "down" | "up" | "top" | "bottom", signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      const code = {
        down: "window.scrollBy(0, Math.round(window.innerHeight * 0.85))",
        up: "window.scrollBy(0, -Math.round(window.innerHeight * 0.85))",
        top: "window.scrollTo(0, 0)",
        bottom: "window.scrollTo(0, document.documentElement.scrollHeight)",
      }[direction];
      if (!code) throw new Error("Direction refusée : down, up, top ou bottom.");
      const wc = this.page();
      // Une fenêtre cachée ne rend pas d'image, donc le navigateur n'émet pas `scroll` : on l'émet, pour les pages qui chargent en défilant.
      await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: `${code}; window.dispatchEvent(new Event('scroll')); document.dispatchEvent(new Event('scroll'))` }]);
      await this.settle(wc, signal, SCROLL_MS);
      return this.snapshot(wc);
    });
  }

  back(signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      const wc = this.page();
      // Entrée PRÉCÉDENTE, par son rang : `canGoBack()` saute les pages qui n'ont reçu aucune action de l'utilisateur (protection de Chromium contre
      // les pièges d'historique) — or toute page ouverte par l'agent est dans ce cas, et « retour » ne trouverait jamais rien.
      const here = wc.navigationHistory.getActiveIndex();
      if (here <= 0) throw new Error("Pas de page précédente.");
      wc.navigationHistory.goToIndex(here - 1);
      await this.settle(wc, signal);
      return this.snapshot(wc);
    });
  }

  wait(seconds: number, text?: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error("Interrompu.");
      const wc = this.page();
      const until = Date.now() + Math.min(Math.max(seconds, 1), 15) * 1000;
      const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      if (text) {
        const probe = `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`;
        while (Date.now() < until && !signal?.aborted) {
          if ((await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: probe }])) === true) break;
          await pause(WAIT_POLL_MS);
        }
      } else {
        while (Date.now() < until && !signal?.aborted) await pause(Math.min(WAIT_POLL_MS * 4, until - Date.now()));
      }
      if (signal?.aborted) throw new Error("Interrompu.");
      return this.snapshot(wc);
    });
  }

  /** Passage de relais : la fenêtre se montre, au premier plan, même si `browserVisible` est faux. */
  reveal(): Promise<void> {
    return this.serial(async () => {
      const win = this.ensure();
      win.show();
      win.focus();
    });
  }

  /** Efface TOUT ce que le navigateur de l'agent a gardé (session mémoire et session persistante) et ferme sa fenêtre. */
  forget(): Promise<void> {
    return this.serial(async () => {
      const win = this.win;
      this.win = null;
      if (win && !win.isDestroyed()) win.destroy();
      for (const name of [MEMORY_PARTITION, PERSIST_PARTITION]) {
        const ses = this.d.electron.session.fromPartition(name);
        await ses.clearStorageData().catch(() => {});
        await ses.clearCache().catch(() => {});
      }
    });
  }

  type(index: number, text: string, submit: boolean, signal?: AbortSignal): Promise<BrowserSnapshot> {
    return this.act(index, { text, submit }, signal);
  }

  close(): Promise<void> {
    return this.serial(async () => {
      const win = this.win;
      this.win = null;
      if (win && !win.isDestroyed()) win.destroy();
      // Session en mémoire : cookies, cache et stockage oubliés avec la fenêtre. Session persistante : gardés (`forget()` les efface).
      if (!this.usedPersistent) {
        await this.ses?.clearStorageData().catch(() => {});
        await this.ses?.clearCache().catch(() => {});
      }
    });
  }
}
