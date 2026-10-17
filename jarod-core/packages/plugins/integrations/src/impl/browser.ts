/**
 * E2 (browser-use/browser-harness) — pilotage du navigateur CONNECTÉ de l'utilisateur (sessions ouvertes, comptes connectés).
 *
 * Posture décidée par l'humain (2026-10-17) : permis, avec un accord explicite PAR ACTION et un journal. Ici, « action » inclut les
 * lectures : lire une page connectée expose des données de compte, donc CHAQUE opération demande l'accord. Sans accord branché,
 * tout est refusé. Politique appliquée AVANT le moteur :
 *  - liste blanche de domaines obligatoire (vide = rien n'est permis) ; liste noire par défaut (banque, messagerie, coffres de
 *    mots de passe, comptes et paiement) qui l'emporte toujours ;
 *  - seules les URL http(s) sans identifiants dans l'adresse ; aucune opération sur les cookies, le stockage ou le profil n'existe ;
 *  - un champ de mot de passe n'est jamais lu ni rempli ; texte saisi borné, sans caractères de contrôle ; touches limitées ;
 *  - débit limité ; le journal garde l'opération, l'hôte et le résultat — jamais l'adresse complète, le contenu ni le texte saisi.
 * L'accord : la demande montre la cible (hôte, chemin sans requête) et les paramètres utiles ; elle n'est posée qu'APRÈS la politique (ce qui est
 * interdit n'est pas soumis à l'utilisateur) ; absence de canal, refus, erreur ou délai dépassé = aucune opération ; l'accord ne vaut que pour
 * l'action exacte présentée (empreinte recalculée après l'accord : un onglet, une adresse, un sélecteur ou un texte différent = refus, nouvel accord).
 * Après l'action, un onglet qui a atterri (redirection) ou une fenêtre qui s'est ouverte hors politique est FERMÉ, et le cas est journalisé.
 * Une page est une donnée non fiable : rien de ce qu'elle dit ne touche la politique, qui ne lit que la configuration.
 * Le moteur (browser-harness) implémente `BrowserBackend` : il exécute exactement ces opérations.
 */
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export const BROWSER_OPS = ["list_tabs", "read_page", "navigate", "open_tab", "click", "type_text", "press_key"] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];

export interface TabRef {
  id: string;
  url: string;
  title: string;
}

export interface BrowserBackend {
  engine: "browser-harness";
  listTabs(): Promise<TabRef[]>;
  readPage(tab: string): Promise<{ text: string; passwordFields: number }>;
  navigate(tab: string, url: string): Promise<void>;
  /** Ouvre un onglet sur l'adresse et rend son identifiant. */
  openTab(url: string): Promise<string>;
  /** Ferme un onglet : sert seulement à neutraliser ce qui a atterri ou s'est ouvert hors politique. */
  closeTab(tab: string): Promise<void>;
  click(tab: string, selector: string): Promise<void>;
  typeText(tab: string, selector: string, text: string): Promise<void>;
  pressKey(tab: string, key: string): Promise<void>;
  /** Pour savoir, AVANT d'agir, si le champ visé est un mot de passe. */
  isPasswordField(tab: string, selector: string): Promise<boolean>;
}

export interface BrowserPolicy {
  /** Domaines permis (hôte exact ou sous-domaine). Vide = rien n'est permis. */
  allowDomains: string[];
  denyDomains?: string[];
  maxTextLength?: number;
  perMinute?: number;
  keys?: string[];
}

/** Réglage de l'utilisateur : désactivé et liste blanche vide tant qu'il n'a pas choisi de domaines. */
export interface BrowserConfig {
  enabled: boolean;
  allowDomains: string[];
  denyDomains: string[];
}

export const DEFAULT_BROWSER_CONFIG: Readonly<BrowserConfig> = Object.freeze({ enabled: false, allowDomains: [], denyDomains: [] });

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lit le réglage ; tout ce qui n'est pas exactement attendu vaut « désactivé, aucun domaine ». Une entrée trop large (« com », « * ») est écartée. */
export function parseBrowserConfig(raw: unknown): BrowserConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { enabled: false, allowDomains: [], denyDomains: [] };
  const r = raw as Record<string, unknown>;
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const e of v) {
      if (typeof e !== "string") continue;
      const d = e.trim().toLowerCase();
      if (DOMAIN.test(d) && !out.includes(d)) out.push(d);
    }
    return out;
  };
  return { enabled: r.enabled === true, allowDomains: list(r.allowDomains), denyDomains: list(r.denyDomains) };
}

export function policyFromConfig(cfg: BrowserConfig): BrowserPolicy {
  return { allowDomains: cfg.enabled ? [...cfg.allowDomains] : [], denyDomains: [...cfg.denyDomains] };
}

export const DEFAULT_DENY_DOMAINS = [
  "accounts.google.com", "mail.google.com", "outlook.live.com", "outlook.office.com", "login.microsoftonline.com", "account.microsoft.com",
  "paypal.com", "stripe.com", "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com",
  "appleid.apple.com", "icloud.com", "console.aws.amazon.com", "portal.azure.com",
];
const DENY_HOST_WORDS = /bank|banque|bnpparibas|creditagricole|societegenerale|boursorama|payment|paiement|checkout|wallet/i;
const DEFAULT_KEYS = ["enter", "tab", "escape", "up", "down", "pageup", "pagedown", "home", "end"];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface BrowserAuditEntry {
  op: BrowserOp;
  /** Hôte seulement. */
  host?: string;
  ok: boolean;
  reason?: string;
  /** Onglets fermés parce qu'ils avaient atterri ou s'étaient ouverts hors politique. */
  closedTabs?: number;
}

/** Ce que l'utilisateur voit AVANT d'accorder : la cible exacte et les paramètres utiles, jamais la requête de l'adresse. */
export interface BrowserApprovalRequest {
  op: BrowserOp;
  host?: string;
  /** Origine + chemin, sans requête ni fragment. */
  url?: string;
  params: Record<string, string | number>;
  /** Une phrase qui dit ce qui va se passer. */
  summary: string;
}

export interface BrowserDeps {
  backend?: BrowserBackend;
  policy: BrowserPolicy;
  /** Accord de l'utilisateur pour CHAQUE opération ; refuse par défaut si absent, en erreur ou trop lent. */
  approve?: (request: BrowserApprovalRequest, caller?: unknown) => Promise<boolean>;
  // `caller` : ce que l'appelant passe à chaque opération (la session, la porte d'accord du cœur) et qu'il retrouve ici.
  /** Délai de l'accord (défaut 120 s) : au-delà, l'opération est refusée. */
  approvalTimeoutMs?: number;
  audit?: (entry: BrowserAuditEntry) => void;
  now?: () => number;
}

const A = "E2";

/** L'hôte d'une adresse permise, ou une erreur. Refuse tout ce qui n'est pas http(s) simple. */
export function hostOf(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AdapterRefused(A, "adresse illisible");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new AdapterRefused(A, `schéma « ${u.protocol} » non permis`);
  if (u.username || u.password) throw new AdapterRefused(A, "identifiants dans l'adresse refusés");
  return u.hostname.toLowerCase();
}

function plain(raw: string): string {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}`;
}

/** Ce que l'accord engage : tout ce qui définit l'action, requête comprise (elle n'est pas montrée, mais elle compte). */
interface Prepared {
  request: BrowserApprovalRequest;
  fingerprint: string;
  host?: string;
  /** Les identifiants d'onglets connus avant l'action (pour reconnaître une fenêtre nouvelle). */
  before: Set<string>;
  tab?: string;
}

export class ConnectedBrowser {
  private readonly calls: number[] = [];
  constructor(private readonly deps: BrowserDeps) {}

  private backend(): BrowserBackend {
    if (!this.deps.backend) throw new AdapterUnavailable(A, "aucun moteur de navigateur branché");
    return this.deps.backend;
  }

  private rate(): void {
    const now = (this.deps.now ?? Date.now)();
    while (this.calls.length && now - this.calls[0]! > 60_000) this.calls.shift();
    if (this.calls.length >= (this.deps.policy.perMinute ?? 30)) throw new AdapterRefused(A, "trop d'opérations à la minute");
    this.calls.push(now);
  }

  /** Permis = dans la liste blanche ET hors de toutes les listes noires (la liste noire l'emporte). */
  allowedHost(host: string): boolean {
    const h = host.toLowerCase();
    const matches = (d: string) => {
      const dom = d.toLowerCase().split("/")[0]!;
      return h === dom || h.endsWith(`.${dom}`);
    };
    if ([...DEFAULT_DENY_DOMAINS, ...(this.deps.policy.denyDomains ?? [])].some(matches)) return false;
    if (DENY_HOST_WORDS.test(h)) return false;
    return this.deps.policy.allowDomains.some(matches);
  }

  private permitted(url: string): boolean {
    try {
      return this.allowedHost(hostOf(url));
    } catch {
      return false;
    }
  }

  private async tabInfo(id: string): Promise<{ tab: TabRef; host: string; before: Set<string> }> {
    const all = await this.backend().listTabs();
    const tab = all.find((t) => t.id === id);
    if (!tab) throw new AdapterRefused(A, "onglet absent");
    const host = hostOf(tab.url);
    if (!this.allowedHost(host)) throw new AdapterRefused(A, "onglet hors de la politique de domaines");
    return { tab, host, before: new Set(all.map((t) => t.id)) };
  }

  /** L'accord, avec ses trois issues sûres : refus, erreur du canal, délai dépassé. */
  private async ask(request: BrowserApprovalRequest, caller: unknown): Promise<void> {
    const approve = this.deps.approve;
    if (!approve) throw new AdapterRefused(A, "opération non accordée");
    const limit = this.deps.approvalTimeoutMs ?? 120_000;
    const now = this.deps.now ?? Date.now;
    const asked = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((r) => (timer = setTimeout(() => r("expired"), limit)));
    let answer: boolean | "expired";
    try {
      answer = await Promise.race([approve(request, caller).then((v) => v === true), expired]);
    } catch {
      answer = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (answer === "expired" || now() - asked > limit) throw new AdapterRefused(A, "accord expiré : opération non faite");
    if (answer !== true) throw new AdapterRefused(A, "opération non accordée");
  }

  /** Après l'action : ferme l'onglet visé s'il a atterri hors politique, et toute fenêtre nouvelle hors politique. */
  private async settle(p: Prepared, acted?: string): Promise<number> {
    const be = this.backend();
    const now = await be.listTabs();
    let closed = 0;
    let actedBad = false;
    for (const t of now) {
      const isActed = t.id === acted;
      const isNew = !p.before.has(t.id);
      if (!isActed && !isNew) continue;
      if (this.permitted(t.url) || (isNew && t.url === "about:blank")) continue;
      await be.closeTab(t.id).catch(() => undefined);
      closed++;
      if (isActed) actedBad = true;
    }
    if (actedBad) throw Object.assign(new AdapterRefused(A, "l'onglet a atterri hors de la politique de domaines (fermé)"), { closed });
    return closed;
  }

  private async run<T>(
    op: BrowserOp,
    prepare: () => Promise<Prepared>,
    exec: (p: Prepared) => Promise<{ value: T; acted?: string }>,
    caller?: unknown,
  ): Promise<T> {
    let host: string | undefined;
    let closed = 0;
    try {
      this.rate();
      const first = await prepare();
      host = first.host;
      await this.ask(first.request, caller);
      // L'accord vaut pour CETTE action : on recalcule ce qui la définit, et la moindre différence la refuse.
      const second = await prepare();
      if (second.fingerprint !== first.fingerprint) throw new AdapterRefused(A, "l'action a changé depuis l'accord : rien n'est fait, nouvel accord nécessaire");
      const { value, acted } = await exec(second);
      if (op !== "list_tabs" && op !== "read_page") closed = await this.settle(second, acted);
      this.deps.audit?.({ op, ...(host ? { host } : {}), ok: true, ...(closed ? { closedTabs: closed } : {}) });
      return value;
    } catch (e) {
      const c = (e as { closed?: number }).closed ?? closed;
      this.deps.audit?.({ op, ...(host ? { host } : {}), ok: false, reason: (e as Error).message.slice(0, 120), ...(c ? { closedTabs: c } : {}) });
      throw e;
    }
  }

  private async onTab(op: BrowserOp, tab: string, params: Record<string, string | number>, verb: string, fp: Record<string, unknown>): Promise<Prepared> {
    const { tab: t, host, before } = await this.tabInfo(tab);
    const shown = plain(t.url);
    return {
      request: { op, host, url: shown, params, summary: `${verb} sur ${host} (${shown})` },
      fingerprint: JSON.stringify({ op, tab, url: t.url, ...fp }),
      host,
      before,
      tab,
    };
  }

  /** Seuls les onglets de domaines permis sont listés ; l'adresse est rendue sans sa requête ni son fragment. */
  listTabs(caller?: unknown): Promise<TabRef[]> {
    return this.run(
      "list_tabs",
      async () => ({ request: { op: "list_tabs", params: {}, summary: "lister les onglets des domaines permis" }, fingerprint: "list_tabs", before: new Set() }),
      async () => ({
        value: (await this.backend().listTabs())
          .filter((t) => this.permitted(t.url))
          .map((t) => ({ id: t.id, url: plain(t.url), title: t.title })),
      }),
      caller,
    );
  }

  readPage(tab: string, caller?: unknown): Promise<string> {
    return this.run(
      "read_page",
      () => this.onTab("read_page", tab, {}, "lire la page", {}),
      async () => {
        const page = await this.backend().readPage(tab);
        // Si l'onglet a bougé pendant la lecture, ce qui a été lu n'est plus de la page accordée : on le jette.
        await this.tabInfo(tab);
        return { value: page.text.slice(0, 20_000) };
      },
      caller,
    );
  }

  navigate(tab: string, url: string, caller?: unknown): Promise<void> {
    return this.run(
      "navigate",
      async () => {
        const target = hostOf(url);
        if (!this.allowedHost(target)) throw new AdapterRefused(A, "domaine de destination hors de la politique");
        const p = await this.onTab("navigate", tab, { to: plain(url) }, `ouvrir ${plain(url)}`, { to: url });
        return { ...p, request: { ...p.request, host: target, summary: `ouvrir ${plain(url)} dans l'onglet de ${p.host}` }, host: target };
      },
      async () => {
        await this.backend().navigate(tab, url);
        return { value: undefined, acted: tab };
      },
      caller,
    );
  }

  openTab(url: string, caller?: unknown): Promise<string> {
    return this.run(
      "open_tab",
      async () => {
        const target = hostOf(url);
        if (!this.allowedHost(target)) throw new AdapterRefused(A, "domaine de destination hors de la politique");
        const before = new Set((await this.backend().listTabs()).map((t) => t.id));
        return {
          request: { op: "open_tab", host: target, url: plain(url), params: { to: plain(url) }, summary: `ouvrir ${plain(url)} dans un nouvel onglet` },
          fingerprint: JSON.stringify({ op: "open_tab", url }),
          host: target,
          before,
        };
      },
      async () => {
        const id = await this.backend().openTab(url);
        return { value: id, acted: id };
      },
      caller,
    );
  }

  click(tab: string, selector: string, caller?: unknown): Promise<void> {
    return this.run(
      "click",
      () => this.onTab("click", tab, { selector }, "cliquer", { selector }),
      async (p) => {
        if (await this.backend().isPasswordField(tab, selector)) throw new AdapterRefused(A, "un champ de mot de passe n'est jamais touché");
        await this.backend().click(tab, selector);
        return { value: undefined, acted: p.tab };
      },
      caller,
    );
  }

  typeText(tab: string, selector: string, text: string, caller?: unknown): Promise<void> {
    const max = this.deps.policy.maxTextLength ?? 2000;
    return this.run(
      "type_text",
      async () => {
        if (text.length > max) throw new AdapterRefused(A, `texte trop long (${text.length} > ${max})`);
        if (CONTROL.test(text)) throw new AdapterRefused(A, "caractères de contrôle refusés");
        const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        return this.onTab("type_text", tab, { selector, text: shown, length: text.length }, `saisir ${text.length} caractère(s)`, { selector, text });
      },
      async (p) => {
        if (await this.backend().isPasswordField(tab, selector)) throw new AdapterRefused(A, "un champ de mot de passe n'est jamais rempli");
        await this.backend().typeText(tab, selector, text);
        return { value: undefined, acted: p.tab };
      },
      caller,
    );
  }

  pressKey(tab: string, key: string, caller?: unknown): Promise<void> {
    const keys = this.deps.policy.keys ?? DEFAULT_KEYS;
    return this.run(
      "press_key",
      async () => {
        if (!keys.includes(key.toLowerCase())) throw new AdapterRefused(A, `touche « ${key} » non permise`);
        return this.onTab("press_key", tab, { key: key.toLowerCase() }, `appuyer sur ${key.toLowerCase()}`, { key: key.toLowerCase() });
      },
      async (p) => {
        await this.backend().pressKey(tab, key.toLowerCase());
        return { value: undefined, acted: p.tab };
      },
      caller,
    );
  }
}
