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
 * Le moteur (browser-harness) implémente `BrowserBackend` : il exécute exactement ces opérations.
 */
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export const BROWSER_OPS = ["list_tabs", "read_page", "navigate", "click", "type_text", "press_key"] as const;
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
}

export interface BrowserDeps {
  backend?: BrowserBackend;
  policy: BrowserPolicy;
  /** Accord de l'utilisateur pour CHAQUE opération ; refuse par défaut si absent. */
  approve?: (op: BrowserOp, summary: string) => Promise<boolean>;
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

  private async tab(id: string): Promise<{ tab: TabRef; host: string }> {
    const tab = (await this.backend().listTabs()).find((t) => t.id === id);
    if (!tab) throw new AdapterRefused(A, "onglet absent");
    const host = hostOf(tab.url);
    if (!this.allowedHost(host)) throw new AdapterRefused(A, "onglet hors de la politique de domaines");
    return { tab, host };
  }

  private async run<T>(op: BrowserOp, host: () => string | undefined, summary: string, fn: () => Promise<T>): Promise<T> {
    let h: string | undefined;
    try {
      this.rate();
      const ok = (await this.deps.approve?.(op, summary)) === true;
      if (!ok) throw new AdapterRefused(A, "opération non accordée");
      const out = await fn();
      h = host();
      this.deps.audit?.({ op, ...(h ? { host: h } : {}), ok: true });
      return out;
    } catch (e) {
      h = host();
      this.deps.audit?.({ op, ...(h ? { host: h } : {}), ok: false, reason: (e as Error).message.slice(0, 120) });
      throw e;
    }
  }

  /** Seuls les onglets de domaines permis sont listés ; l'adresse est rendue sans sa requête ni son fragment. */
  listTabs(): Promise<TabRef[]> {
    return this.run("list_tabs", () => undefined, "lister les onglets permis", async () =>
      (await this.backend().listTabs())
        .filter((t) => {
          try {
            return this.allowedHost(hostOf(t.url));
          } catch {
            return false;
          }
        })
        .map((t) => {
          const u = new URL(t.url);
          return { id: t.id, url: `${u.origin}${u.pathname}`, title: t.title };
        }),
    );
  }

  readPage(tab: string): Promise<string> {
    let host: string | undefined;
    return this.run("read_page", () => host, `lire la page de l'onglet ${tab}`, async () => {
      host = (await this.tab(tab)).host;
      const page = await this.backend().readPage(tab);
      return page.text.slice(0, 20_000);
    });
  }

  navigate(tab: string, url: string): Promise<void> {
    let host: string | undefined;
    return this.run("navigate", () => host, `ouvrir ${(() => { try { return hostOf(url); } catch { return "adresse invalide"; } })()} dans l'onglet ${tab}`, async () => {
      const target = hostOf(url);
      host = target;
      if (!this.allowedHost(target)) throw new AdapterRefused(A, "domaine de destination hors de la politique");
      await this.tab(tab);
      await this.backend().navigate(tab, url);
    });
  }

  click(tab: string, selector: string): Promise<void> {
    let host: string | undefined;
    return this.run("click", () => host, `cliquer sur ${selector}`, async () => {
      host = (await this.tab(tab)).host;
      if (await this.backend().isPasswordField(tab, selector)) throw new AdapterRefused(A, "un champ de mot de passe n'est jamais touché");
      await this.backend().click(tab, selector);
    });
  }

  typeText(tab: string, selector: string, text: string): Promise<void> {
    let host: string | undefined;
    const max = this.deps.policy.maxTextLength ?? 2000;
    return this.run("type_text", () => host, `saisir ${text.length} caractère(s) dans ${selector}`, async () => {
      if (text.length > max) throw new AdapterRefused(A, `texte trop long (${text.length} > ${max})`);
      if (CONTROL.test(text)) throw new AdapterRefused(A, "caractères de contrôle refusés");
      host = (await this.tab(tab)).host;
      if (await this.backend().isPasswordField(tab, selector)) throw new AdapterRefused(A, "un champ de mot de passe n'est jamais rempli");
      await this.backend().typeText(tab, selector, text);
    });
  }

  pressKey(tab: string, key: string): Promise<void> {
    let host: string | undefined;
    const keys = this.deps.policy.keys ?? DEFAULT_KEYS;
    return this.run("press_key", () => host, `appuyer sur ${key}`, async () => {
      if (!keys.includes(key.toLowerCase())) throw new AdapterRefused(A, `touche « ${key} » non permise`);
      host = (await this.tab(tab)).host;
      await this.backend().pressKey(tab, key.toLowerCase());
    });
  }
}
