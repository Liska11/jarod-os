/**
 * E2 — la PRÉPARATION du branchement à l'hôte. Rien ici ne tourne tout seul et rien n'appelle ce module dans le démarrage de l'application :
 * un hôte qui voudrait offrir `connected_browser` appelle `prepareConnectedBrowser`, qui ne branche RIEN tant que le réglage de l'utilisateur
 * n'est pas activé avec au moins un domaine (le défaut est éteint et vide) et que le moteur n'est pas installé.
 *
 * Même branché, rien ne démarre avant le premier accord : le navigateur jetable n'est lancé que par la première action APPROUVÉE (`LazyBackend`),
 * et chaque opération relit le réglage — éteint ou vidé entre-temps, la session est fermée et l'opération refusée ; un autre jeu de domaines
 * ferme la session et en démarre une nouvelle avec la nouvelle garde réseau (jamais un jeu de domaines différent côté contrôleur et côté garde).
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterRefused } from "./common.js";
import {
  type BrowserAuditEntry,
  type BrowserApprovalRequest,
  type BrowserBackend,
  type BrowserConfig,
  ConnectedBrowser,
  parseBrowserConfig,
  policyFromConfig,
  type TabRef,
} from "./browser.js";
import { type GuardedSession, type GuardedSessionOptions, startGuardedSession } from "./browser-engine.js";

const A = "E2";

export interface EnginePaths {
  chromeBin: string;
  python: string;
  bridge: string;
}

/**
 * Où sont le moteur et le navigateur d'essai. Cherche SEULEMENT le Chromium de Playwright (le dossier `ms-playwright`) et le venv épinglé ;
 * ne regarde jamais un dossier de profil ni un Chrome installé pour l'usage quotidien. `null` = moteur absent.
 */
export function discoverEnginePaths(o: { root: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; exists?: (p: string) => boolean; list?: (p: string) => string[] }): EnginePaths | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const list = o.list ?? ((p: string) => readdirSync(p));
  const win = platform === "win32";
  const python = join(o.root, "engines", "browser-harness", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  const bridge = join(o.root, "jarod-core", "sidecars", "browser-bridge", "bh_ops.py");
  const pw = win ? join(env.LOCALAPPDATA ?? "", "ms-playwright") : join(o.home ?? homedir(), ".cache", "ms-playwright");
  if (!exists(python) || !exists(bridge) || !exists(pw)) return null;
  let dirs: string[];
  try {
    dirs = list(pw)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const chromeBin = win ? join(pw, d, "chrome-win64", "chrome.exe") : join(pw, d, "chrome-linux", "chrome");
    if (exists(chromeBin)) return { chromeBin, python, bridge };
  }
  return null;
}

export type HostState = "disabled" | "no-engine" | "idle" | "running" | "failed";
export interface HostStatus {
  state: HostState;
  reason: string;
  /** Requêtes refusées par la garde réseau depuis le démarrage de la session (comptes seulement, jamais d'adresse). */
  blocked: number;
}

export interface ConnectedBrowserHostDeps {
  /** Le réglage de l'UTILISATEUR (relu à chaque opération). Absent, illisible ou éteint = désactivé. */
  settings: () => unknown;
  engine: () => EnginePaths | null;
  approve: (request: BrowserApprovalRequest, caller?: unknown) => Promise<boolean>;
  audit?: (entry: BrowserAuditEntry) => void;
  approvalTimeoutMs?: number;
  perMinute?: number;
  /** Pour les essais : remplace le démarrage réel de la session. */
  start?: (o: GuardedSessionOptions) => Promise<GuardedSession>;
}

/** Un identifiant du jeu de domaines : s'il change, la session (et sa garde réseau) est refaite. */
function signature(cfg: BrowserConfig): string {
  return JSON.stringify([[...cfg.allowDomains].sort(), [...cfg.denyDomains].sort()]);
}

/** Le moteur, démarré seulement par une action qui en a besoin — donc, vu l'ordre de `ConnectedBrowser`, seulement APRÈS l'accord. */
class LazyBackend implements BrowserBackend {
  readonly engine = "browser-harness" as const;
  constructor(private readonly session: () => Promise<GuardedSession>, private readonly live: () => GuardedSession | null) {}

  /** Sans session, il n'existe aucun onglet : pas de lancement pour répondre « aucun » (la liste sert AVANT l'accord). */
  async listTabs(): Promise<TabRef[]> {
    const s = this.live();
    return s ? s.backend.listTabs() : [];
  }
  private async need(): Promise<BrowserBackend> {
    return (await this.session()).backend;
  }
  async openTab(url: string) {
    return (await this.need()).openTab(url);
  }
  async readPage(tab: string) {
    return (await this.need()).readPage(tab);
  }
  async navigate(tab: string, url: string) {
    return (await this.need()).navigate(tab, url);
  }
  async closeTab(tab: string) {
    return (await this.need()).closeTab(tab);
  }
  async click(tab: string, selector: string) {
    return (await this.need()).click(tab, selector);
  }
  async typeText(tab: string, selector: string, text: string) {
    return (await this.need()).typeText(tab, selector, text);
  }
  async pressKey(tab: string, key: string) {
    return (await this.need()).pressKey(tab, key);
  }
  async isPasswordField(tab: string, selector: string) {
    return (await this.need()).isPasswordField(tab, selector);
  }
}

export class ConnectedBrowserHost {
  private session: GuardedSession | null = null;
  private starting: Promise<GuardedSession> | null = null;
  private gate: { sig: string; browser: ConnectedBrowser; cfg: BrowserConfig } | null = null;
  private failure = "";

  constructor(private readonly d: ConnectedBrowserHostDeps) {}

  status(): HostStatus {
    const cfg = parseBrowserConfig(this.d.settings());
    const blocked = this.session?.guard.stats.blocked ?? 0;
    if (!cfg.enabled || cfg.allowDomains.length === 0) return { state: "disabled", reason: cfg.enabled ? "aucun domaine permis" : "désactivé dans les réglages", blocked };
    if (!this.d.engine()) return { state: "no-engine", reason: "moteur ou navigateur d'essai non installé", blocked };
    if (this.session && !this.session.guard.healthy) return { state: "failed", reason: `garde perdue : ${this.session.guard.reason}`, blocked };
    if (this.failure) return { state: "failed", reason: this.failure, blocked };
    return { state: this.session ? "running" : "idle", reason: "", blocked };
  }

  /** Relit le réglage ; rend le contrôleur pour CE jeu de domaines, ou refuse (et ferme tout) si l'opération n'est plus permise. */
  private async current(): Promise<ConnectedBrowser> {
    const cfg = parseBrowserConfig(this.d.settings());
    if (!cfg.enabled || cfg.allowDomains.length === 0) {
      await this.shutdown("réglage éteint ou vidé");
      throw new AdapterRefused(A, "navigateur connecté désactivé dans les réglages");
    }
    const sig = signature(cfg);
    if (this.session && !this.session.guard.healthy) await this.shutdown("garde perdue");
    if (this.gate && this.gate.sig !== sig) await this.shutdown("jeu de domaines changé");
    if (!this.gate) {
      const policy = policyFromConfig(cfg);
      const backend = new LazyBackend(() => this.ensureSession(cfg), () => this.session);
      this.gate = {
        sig,
        cfg,
        browser: new ConnectedBrowser({ backend, policy: { ...policy, ...(this.d.perMinute ? { perMinute: this.d.perMinute } : {}) }, approve: this.d.approve, audit: this.d.audit, approvalTimeoutMs: this.d.approvalTimeoutMs }),
      };
    }
    return this.gate.browser;
  }

  private ensureSession(cfg: BrowserConfig): Promise<GuardedSession> {
    if (this.session) return Promise.resolve(this.session);
    if (this.starting) return this.starting;
    const paths = this.d.engine();
    if (!paths) return Promise.reject(new AdapterRefused(A, "moteur ou navigateur d'essai non installé"));
    const start = this.d.start ?? startGuardedSession;
    this.starting = start({ ...paths, policy: policyFromConfig(cfg) }).then(
      (s) => {
        this.session = s;
        this.starting = null;
        this.failure = "";
        return s;
      },
      (e: unknown) => {
        this.starting = null;
        this.failure = (e as Error).message;
        throw e;
      },
    );
    return this.starting;
  }

  /** Révoque la session (garde fermée à toute requête, opérations en cours interrompues, navigateur et profil détruits). */
  private async shutdown(why: string): Promise<void> {
    const s = this.session;
    const pending = this.starting;
    this.session = null;
    this.starting = null;
    this.gate = null;
    if (pending) await pending.then((p) => p.revoke(why), () => undefined);
    if (s) await s.revoke(why).catch(() => undefined);
  }

  /**
   * À appeler dès que le RÉGLAGE change (le cycle de vie de l'application le fait) : une session qui n'est plus permise est révoquée TOUT DE SUITE,
   * sans attendre la prochaine opération — éteint ou vidé, un domaine retiré (le jeu change), ou une garde devenue non saine.
   */
  async reconcile(): Promise<void> {
    const cfg = parseBrowserConfig(this.d.settings());
    if (!cfg.enabled || cfg.allowDomains.length === 0) return this.shutdown("réglage éteint ou vidé");
    if (this.session && !this.session.guard.healthy) return this.shutdown("garde perdue");
    if (this.gate && this.gate.sig !== signature(cfg)) return this.shutdown("jeu de domaines changé");
  }

  async close(): Promise<void> {
    await this.shutdown("fermée");
  }

  async listTabs(caller?: unknown) {
    return (await this.current()).listTabs(caller);
  }
  async readPage(tab: string, caller?: unknown) {
    return (await this.current()).readPage(tab, caller);
  }
  async navigate(tab: string, url: string, caller?: unknown) {
    return (await this.current()).navigate(tab, url, caller);
  }
  async openTab(url: string, caller?: unknown) {
    return (await this.current()).openTab(url, caller);
  }
  async click(tab: string, selector: string, caller?: unknown) {
    return (await this.current()).click(tab, selector, caller);
  }
  async typeText(tab: string, selector: string, text: string, caller?: unknown) {
    return (await this.current()).typeText(tab, selector, text, caller);
  }
  async pressKey(tab: string, key: string, caller?: unknown) {
    return (await this.current()).pressKey(tab, key, caller);
  }
}

export interface Preparation {
  attached: boolean;
  /** Pourquoi rien n'est branché (vide si branché). */
  reason: string;
  host?: ConnectedBrowserHost;
  detach(): Promise<void>;
}

/**
 * Le seul point d'entrée d'un hôte. Ne branche l'outil que si le réglage de l'utilisateur est activé avec au moins un domaine ET que le moteur
 * est installé ; sinon ne fait rien (l'outil `connected_browser` n'existe pas). `tools` : `ToolsService` (structurel, pour ne pas dépendre du paquet).
 */
export function prepareConnectedBrowser(tools: { attachConnectedBrowser(port: ConnectedBrowserHost): () => void }, deps: ConnectedBrowserHostDeps): Preparation {
  const none = (reason: string): Preparation => ({ attached: false, reason, detach: async () => undefined });
  const cfg = parseBrowserConfig(deps.settings());
  if (!cfg.enabled) return none("désactivé dans les réglages");
  if (cfg.allowDomains.length === 0) return none("aucun domaine permis");
  if (!deps.engine()) return none("moteur ou navigateur d'essai non installé");
  const host = new ConnectedBrowserHost(deps);
  const off = tools.attachConnectedBrowser(host);
  return {
    attached: true,
    reason: "",
    host,
    detach: async () => {
      off();
      await host.close();
    },
  };
}
