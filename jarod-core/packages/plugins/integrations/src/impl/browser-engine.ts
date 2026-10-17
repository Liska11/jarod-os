/**
 * E2 — le moteur RÉEL : browser-harness (épinglé, `engines.lock/browser-harness-requirements.txt`) derrière `sidecars/browser-bridge/bh_ops.py`,
 * parlant à un Chrome JETABLE que Jarod lance lui-même (profil neuf, jamais celui de l'utilisateur, effacé à la fermeture).
 *
 * Ce module ne remplace pas la politique : `HarnessBackend` implémente `BrowserBackend`, donc `ConnectedBrowser` (accord par opération,
 * liste blanche, journal) reste l'unique porte. Le pont n'accepte que les opérations de `BrowserBackend` ; il n'y a ni code d'agent, ni CDP brut.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";
import { type BrowserBackend, type BrowserPolicy, type TabRef, urlPermitted } from "./browser.js";
import { NetworkGuard } from "./browser-guard.js";

const A = "E2";
const PROFILE_PREFIX = "jarod-e2-";

export interface DisposableBrowser {
  /** http://127.0.0.1:<port> — point d'entrée DevTools du navigateur jetable. */
  cdpUrl: string;
  /** Dossier jetable (sous le dossier temporaire) : profil du navigateur et état du pont. */
  profileDir: string;
  close(): Promise<void>;
}

/** Un profil est « jetable » seulement s'il est un dossier jarod-e2-* DIRECTEMENT sous le dossier temporaire. */
export function isDisposableProfile(dir: string): boolean {
  const real = resolve(dir);
  const root = resolve(tmpdir());
  return real.startsWith(root + sep) && real.slice(root.length + 1).startsWith(PROFILE_PREFIX) && !real.slice(root.length + 1).includes(sep);
}

export interface LaunchOptions {
  chromeBin: string;
  headless?: boolean;
  timeoutMs?: number;
  /**
   * FILET RÉSEAU (en plus de la garde CDP) : tout le trafic du navigateur passe par un proxy MORT, sauf les hôtes de cette liste.
   * Il couvre ce que `Fetch` ne voit pas (WebSocket, préconnexions, adresses IP littérales). Absent = pas de filet (essais de la garde seule).
   */
  allowDomains?: string[];
}

/** Règles de contournement du proxy mort : les domaines permis (et leurs sous-domaines), le bouclage implicite retiré. */
export function proxyBackstopArgs(allowDomains: string[]): string[] {
  const bypass = ["<-loopback>", ...allowDomains.flatMap((d) => [d, `*.${d}`])];
  return ["--proxy-server=http://jarod-blocked.invalid:9", `--proxy-bypass-list=${bypass.join(";")}`];
}

/** Lance un Chrome neuf sur un profil jetable. Jamais d'argument qui désigne un autre profil. */
export async function launchDisposableBrowser(opts: LaunchOptions): Promise<DisposableBrowser> {
  if (!existsSync(opts.chromeBin)) throw new AdapterUnavailable(A, `navigateur introuvable : ${opts.chromeBin}`);
  const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  if (!isDisposableProfile(profileDir)) throw new AdapterRefused(A, "profil non jetable");
  const userData = join(profileDir, "chrome");
  const args = [
    `--user-data-dir=${userData}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    ...(opts.headless === false ? [] : ["--headless=new"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--password-store=basic",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ...(opts.allowDomains ? proxyBackstopArgs(opts.allowDomains) : []),
    "about:blank",
  ];
  const child: ChildProcess = spawn(opts.chromeBin, args, { stdio: "ignore", windowsHide: true });
  const kill = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((r) => {
        const t = setTimeout(r, 4000);
        child.once("exit", () => (clearTimeout(t), r()));
      });
    }
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };
  const portFile = join(userData, "DevToolsActivePort");
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0]?.trim();
      if (port && /^\d{2,5}$/.test(port)) return { cdpUrl: `http://127.0.0.1:${port}`, profileDir, close: kill };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await kill();
  throw new AdapterUnavailable(A, "le navigateur jetable n'a pas démarré");
}

export interface HarnessOptions {
  /** python du venv engines/browser-harness. */
  python: string;
  /** sidecars/browser-bridge/bh_ops.py */
  bridge: string;
  browser: Pick<DisposableBrowser, "cdpUrl" | "profileDir">;
  /** OBLIGATOIRE : sans garde réseau démontrée, le moteur ne s'instancie pas. */
  guard: NetworkGuard;
  name?: string;
  timeoutMs?: number;
  /** Pour les essais : adresse où la télémétrie irait si elle n'était pas coupée. */
  telemetryHost?: string;
}

/** L'environnement du pont : minimal. Aucune variable de l'utilisateur (coffre, clés, jetons) n'y passe. */
export function bridgeEnv(o: Omit<HarnessOptions, "guard">): NodeJS.ProcessEnv {
  const keep = ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.JAROD_BROWSER_CDP = o.browser.cdpUrl;
  env.JAROD_BROWSER_PROFILE = o.browser.profileDir;
  env.JAROD_BROWSER_NAME = o.name ?? "jarod-e2";
  env.PYTHONUTF8 = "1";
  if (o.telemetryHost) env.BH_POSTHOG_HOST = o.telemetryHost;
  return env;
}

export class HarnessBackend implements BrowserBackend {
  readonly engine = "browser-harness" as const;
  constructor(private readonly o: HarnessOptions) {
    if (!isDisposableProfile(o.browser.profileDir)) throw new AdapterRefused(A, "le moteur n'accepte qu'un profil jetable");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(o.browser.cdpUrl)) throw new AdapterRefused(A, "le moteur n'accepte qu'un navigateur de bouclage");
    if (!o.guard || !o.guard.healthy) throw new AdapterRefused(A, "le moteur exige une garde réseau saine (interception obligatoire)");
  }

  private call<T>(req: Record<string, unknown>): Promise<T> {
    return new Promise((resolveCall, reject) => {
      // Garde perdue = plus aucune opération (sauf l'arrêt, qui ne touche pas au réseau).
      if (!this.o.guard.healthy && req.op !== "shutdown") return reject(new AdapterUnavailable(A, `garde réseau perdue : ${this.o.guard.reason || "inconnue"}`));
      const p = spawn(this.o.python, ["-I", this.o.bridge], { env: bridgeEnv(this.o), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => (p.kill(), reject(new AdapterUnavailable(A, "le moteur ne répond pas"))), this.o.timeoutMs ?? 40_000);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => (clearTimeout(timer), reject(new AdapterUnavailable(A, `moteur impossible à lancer : ${e.message}`))));
      p.on("close", () => {
        clearTimeout(timer);
        const line = out.trim().split(/\r?\n/).pop() ?? "";
        try {
          const r = JSON.parse(line) as { ok: boolean; result?: T; error?: string };
          if (r.ok) resolveCall(r.result as T);
          else reject(new AdapterRefused(A, `moteur : ${r.error ?? "refus"}`));
        } catch {
          reject(new AdapterUnavailable(A, `réponse illisible du moteur${err ? ` (${err.trim().split(/\r?\n/).pop()?.slice(0, 120)})` : ""}`));
        }
      });
      p.stdin.end(JSON.stringify(req));
    });
  }

  listTabs(): Promise<TabRef[]> {
    return this.call<TabRef[]>({ op: "list_tabs" });
  }
  readPage(tab: string) {
    return this.call<{ text: string; passwordFields: number }>({ op: "read_page", tab });
  }
  async navigate(tab: string, url: string): Promise<void> {
    await this.call({ op: "navigate", tab, url });
  }
  async click(tab: string, selector: string): Promise<void> {
    await this.call({ op: "click", tab, selector });
  }
  async typeText(tab: string, selector: string, text: string): Promise<void> {
    await this.call({ op: "type_text", tab, selector, text });
  }
  async pressKey(tab: string, key: string): Promise<void> {
    await this.call({ op: "press_key", tab, key });
  }
  isPasswordField(tab: string, selector: string): Promise<boolean> {
    return this.call<boolean>({ op: "is_password_field", tab, selector });
  }
  openTab(url: string): Promise<string> {
    return this.call<string>({ op: "open_tab", url });
  }
  async closeTab(tab: string): Promise<void> {
    await this.call({ op: "close_tab", tab });
  }
  /** Arrête le démon du moteur (le navigateur, lui, se ferme par `DisposableBrowser.close`). */
  async shutdown(): Promise<void> {
    await this.call({ op: "shutdown" }).catch(() => undefined);
  }
}

export interface GuardedSessionOptions {
  chromeBin: string;
  python: string;
  bridge: string;
  /** La MÊME politique que celle du contrôleur. Liste blanche vide (réglage par défaut) = la session ne démarre pas. */
  policy: BrowserPolicy;
  headless?: boolean;
  telemetryHost?: string;
  /** Filet réseau (proxy mort hors liste blanche). Vrai par défaut ; faux seulement pour mesurer la garde CDP seule. */
  proxyBackstop?: boolean;
  onBlock?: (b: { host: string; resourceType: string }) => void;
}

export interface GuardedSession {
  browser: DisposableBrowser;
  guard: NetworkGuard;
  backend: HarnessBackend;
  close(): Promise<void>;
}

/**
 * La SEULE façon de démarrer E2 : navigateur jetable + garde réseau démontrée + moteur. Si la liste blanche est vide, si l'interception
 * échoue ou n'est pas démontrée, rien ne démarre et le navigateur jetable (profil compris) est détruit.
 */
export async function startGuardedSession(o: GuardedSessionOptions): Promise<GuardedSession> {
  if (o.policy.allowDomains.length === 0) throw new AdapterRefused(A, "liste blanche vide : la session E2 ne démarre pas");
  const browser = await launchDisposableBrowser({ chromeBin: o.chromeBin, headless: o.headless, ...(o.proxyBackstop === false ? {} : { allowDomains: o.policy.allowDomains }) });
  try {
    const guard = await NetworkGuard.start({ cdpUrl: browser.cdpUrl, permits: (u) => urlPermitted(u, o.policy), onBlock: o.onBlock });
    const backend = new HarnessBackend({ python: o.python, bridge: o.bridge, browser, guard, telemetryHost: o.telemetryHost });
    return {
      browser,
      guard,
      backend,
      close: async () => {
        await backend.shutdown();
        guard.close();
        await browser.close();
      },
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
