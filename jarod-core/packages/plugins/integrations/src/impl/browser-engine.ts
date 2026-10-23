/**
 * E2 — le moteur RÉEL : browser-harness (épinglé, `engines.lock/browser-harness-requirements.txt`) derrière `sidecars/browser-bridge/bh_ops.py`,
 * parlant à un Chrome JETABLE que Jarod lance lui-même (profil neuf, jamais celui de l'utilisateur, effacé à la fermeture).
 *
 * Ce module ne remplace pas la politique : `HarnessBackend` implémente `BrowserBackend`, donc `ConnectedBrowser` (accord par opération,
 * liste blanche, journal) reste l'unique porte. Le pont n'accepte que les opérations de `BrowserBackend` ; il n'y a ni code d'agent, ni CDP brut.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";
import { type BrowserBackend, type BrowserPolicy, type TabRef, urlPermitted } from "./browser.js";
import { NetworkGuard } from "./browser-guard.js";
import { childEnv } from "@jarod/kernel/child-env";

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
  /** Durcissement WebRTC (pas de UDP hors proxy). Vrai par défaut ; faux seulement pour la mesure de CONTRÔLE des essais. */
  webrtcHardening?: boolean;
  /** Pas de QUIC/HTTP3 (WebTransport compris). Vrai par défaut ; faux seulement pour la mesure de CONTRÔLE. */
  quicHardening?: boolean;
  /**
   * Chrome's own network-service sandbox (Windows AppContainer). True by default and never turned off by the app. False only for the
   * UDP proof's measurements: on some Windows machines this sandbox alone stops every WebRTC datagram, which would leave the proof's
   * control at zero and the proof silent (docs/E2-VALIDATION.md §6.2). The proof then shows the hardening flags work without it.
   */
  networkServiceSandbox?: boolean;
}

/** Règles de contournement du proxy mort : les domaines permis (et leurs sous-domaines), le bouclage implicite retiré. */
export function proxyBackstopArgs(allowDomains: string[]): string[] {
  const bypass = ["<-loopback>", ...allowDomains.flatMap((d) => [d, `*.${d}`])];
  return ["--proxy-server=http://jarod-blocked.invalid:9", `--proxy-bypass-list=${bypass.join(";")}`];
}

/**
 * Les arguments du navigateur jetable : UN SEUL dossier de données, celui que Jarod vient de créer ; point d'entrée DevTools sur le bouclage et un port
 * choisi par le système ; rien qui désigne un autre profil, ni un tuyau, ni une adresse publique.
 */
export function browserArgs(userData: string, opts: Pick<LaunchOptions, "headless" | "quicHardening" | "webrtcHardening" | "allowDomains" | "networkServiceSandbox">): string[] {
  return [
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
    ...(opts.quicHardening === false ? [] : ["--disable-quic"]),
    ...(opts.webrtcHardening === false ? [] : ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp"]),
    ...(opts.networkServiceSandbox === false ? ["--disable-features=NetworkServiceSandbox"] : []),
    ...(opts.allowDomains ? proxyBackstopArgs(opts.allowDomains) : []),
    "about:blank",
  ];
}

/**
 * Le contenu de `DevToolsActivePort`, rendu seulement s'il est COMPLET : ligne 1 = port (1..65535), ligne 2 = chemin `/devtools/browser/<guid>`.
 * Un fichier tronqué (écriture en cours) rend null : l'appelant attend, il ne se contente jamais d'un port seul.
 */
export function parseDevToolsActivePort(raw: string): { port: number; browserPath: string } | null {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return null;
  const port = (lines[0] ?? "").trim();
  const browserPath = (lines[1] ?? "").trim();
  if (!/^\d{1,5}$/.test(port)) return null;
  const n = Number(port);
  if (n < 1 || n > 65535) return null;
  if (!/^\/devtools\/browser\/[0-9A-Za-z-]+$/.test(browserPath)) return null;
  return { port: n, browserPath };
}

/** Interroge `/json/version` du port découvert et rend le chemin du WebSocket navigateur annoncé, ou lève si le point d'entrée ne répond pas. */
async function fetchBrowserPath(port: number, timeoutMs: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("pas de webSocketDebuggerUrl");
  return new URL(body.webSocketDebuggerUrl).pathname;
}

/** Les dépendances du lancement, remplaçables pour les essais déterministes seulement. */
export interface LaunchDeps {
  spawn?: typeof spawn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Chemin WebSocket annoncé par le point d'entrée DevTools de ce port. */
  fetchBrowserPath?: (port: number) => Promise<string>;
  /** Vrai si un processus porte encore ce profil (le lanceur parti, le navigateur peut tourner sous un autre numéro). */
  profileHasProcess?: (profileDir: string) => boolean;
  /** Nettoyage : remplacé par les essais qui n'ont pas de vrai navigateur. */
  killProfile?: (profileDir: string) => number;
}

const LAUNCH_POLL_MS = 100;
/** Le lanceur parti sans fichier de port : combien de contrôles consécutifs « plus aucun processus ne porte le profil » avant de conclure à l'échec. */
const ORPHAN_CHECKS = 5;

/**
 * Lance un Chrome neuf sur un profil jetable. Jamais d'argument qui désigne un autre profil.
 *
 * Attente BORNÉE qui distingue : sortie du lanceur (n'est PAS un échec en soi : Chrome peut se relancer sous un autre numéro), disponibilité
 * réelle (fichier de port complet ET point d'entrée qui répond avec le même identifiant de navigateur), échec (lanceur parti ET plus aucun
 * processus sur le profil), annulation et délai dépassé. Dans chaque cas d'échec le navigateur et le profil sont nettoyés.
 */
export async function launchDisposableBrowser(opts: LaunchOptions & { signal?: AbortSignal }, deps: LaunchDeps = {}): Promise<DisposableBrowser> {
  if (!existsSync(opts.chromeBin)) throw new AdapterUnavailable(A, `navigateur introuvable : ${opts.chromeBin}`);
  if (opts.signal?.aborted) throw new AdapterUnavailable(A, "démarrage du navigateur annulé");
  const doSpawn = deps.spawn ?? spawn;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probe = deps.fetchBrowserPath ?? ((port: number) => fetchBrowserPath(port, 3000));
  const hasProcess = deps.profileHasProcess ?? ((dir: string) => profileProcessIds(dir).length > 0);
  const killProfile = deps.killProfile ?? killProfileProcesses;
  const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  if (!isDisposableProfile(profileDir)) throw new AdapterRefused(A, "profil non jetable");
  const userData = join(profileDir, "chrome");
  const args = browserArgs(userData, opts);
  const child: ChildProcess = doSpawn(opts.chromeBin, args, { stdio: "ignore", windowsHide: true, env: childEnv("engine") });
  let spawnError: Error | null = null;
  child.once("error", (e) => {
    spawnError = e;
  });
  // Marqueur de propriété : ce que `sweepStaleSessions` exige avant de toucher à un dossier ou à un processus (jamais le reste du système).
  writeMarker(profileDir, { ownerPid: process.pid, chromePid: child.pid ?? 0, createdAt: now() });
  const kill = async () => {
    if (child.exitCode === null && !spawnError) {
      // L'écouteur d'abord : un `exit` émis pendant `kill()` ne doit pas coûter les 4 s d'attente.
      const exited = new Promise<void>((r) => {
        const t = setTimeout(r, 4000);
        child.once("exit", () => (clearTimeout(t), r()));
      });
      child.kill();
      await exited;
    }
    // Ce qui porte encore le profil (Chrome relancé sous un autre numéro) : sinon il survit et recrée son dossier.
    killProfile(profileDir);
    for (let i = 0; i < 10; i++) {
      if (removeDisposableProfile(profileDir)) return;
      await sleep(300);
    }
  };
  const fail = async (why: string): Promise<never> => {
    await kill();
    throw new AdapterUnavailable(A, why);
  };
  const portFile = join(userData, "DevToolsActivePort");
  const startedAt = now();
  const deadline = startedAt + (opts.timeoutMs ?? 20_000);
  let orphanChecks = 0;
  let lastProblem = "";
  while (now() < deadline) {
    if (opts.signal?.aborted) return fail("démarrage du navigateur annulé");
    if (spawnError) return fail(`le navigateur n'a pas pu être lancé : ${(spawnError as Error).message}`);
    let found: { port: number; browserPath: string } | null = null;
    try {
      // Le profil est neuf : un fichier de port ne peut venir que de CE lancement. Complet seulement, sinon on attend la fin de l'écriture.
      if (existsSync(portFile)) found = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
    } catch {
      /* en cours d'écriture ou verrouillé : au prochain tour */
    }
    if (found) {
      try {
        const announced = await probe(found.port);
        if (announced === found.browserPath) return { cdpUrl: `http://127.0.0.1:${found.port}`, profileDir, close: kill };
        lastProblem = "le point d'entrée DevTools n'annonce pas le navigateur attendu";
      } catch (e) {
        lastProblem = `connexion au point d'entrée DevTools impossible (${e instanceof Error ? e.message : String(e)})`;
      }
    } else if (child.exitCode !== null) {
      // Le lanceur est parti sans fichier de port : le navigateur peut tourner sous un autre numéro. Échec seulement si plus rien ne porte le profil.
      orphanChecks = hasProcess(profileDir) ? 0 : orphanChecks + 1;
      if (orphanChecks >= ORPHAN_CHECKS) return fail(`le navigateur s'est arrêté avant de démarrer (code ${child.exitCode})`);
    }
    await sleep(LAUNCH_POLL_MS);
  }
  return fail(lastProblem ? `le navigateur jetable n'a pas démarré : ${lastProblem}` : "le navigateur jetable n'a pas démarré (délai dépassé)");
}

const MARKER = "owner.json";

/**
 * Un essai d'effacement d'un profil jetable, le marqueur de propriété EN DERNIER : tout le reste d'abord, puis le marqueur et le dossier une
 * fois seuls. Si Windows garde un fichier du navigateur verrouillé, le dossier reste avec son marqueur et le prochain essai (ou balayage) le
 * finit ; un `rmSync` récursif direct pouvait effacer le marqueur puis buter, laissant un dossier que plus rien n'avait le droit de nettoyer.
 * Rend vrai si le dossier n'existe plus. `rm` n'est remplaçable que pour les essais.
 */
export function removeDisposableProfile(dir: string, rm: (path: string, o: { recursive?: boolean; force?: boolean }) => void = rmSync): boolean {
  if (!isDisposableProfile(dir)) return false;
  let rest: string[];
  try {
    rest = readdirSync(dir).filter((n) => n !== MARKER);
  } catch {
    return !existsSync(dir);
  }
  for (const n of rest) {
    try {
      rm(join(dir, n), { recursive: true, force: true });
    } catch {
      /* verrouillé : le marqueur reste */
    }
  }
  try {
    if (readdirSync(dir).some((n) => n !== MARKER)) return false;
    rm(dir, { recursive: true, force: true });
  } catch {
    /* réessayé plus tard */
  }
  return !existsSync(dir);
}

interface Marker {
  ownerPid: number;
  chromePid: number;
  createdAt: number;
}

function writeMarker(profileDir: string, m: Marker): void {
  try {
    writeFileSync(join(profileDir, MARKER), JSON.stringify(m), { mode: 0o600 });
  } catch {
    /* sans marqueur, le balayage ne touchera pas ce dossier : sûr */
  }
}

function readMarker(profileDir: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(join(profileDir, MARKER), "utf8")) as Partial<Marker>;
    if (Number.isInteger(m.ownerPid) && Number.isInteger(m.chromePid) && typeof m.createdAt === "number") return m as Marker;
  } catch {
    /* illisible */
  }
  return null;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** La ligne de commande d'un processus, ou null. Sert à NE tuer que ce qui porte la marque de Jarod (un numéro peut avoir été réutilisé). */
export function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: childEnv("engine") }).trim();
      return out || null;
    }
    return readFileSync(`/proc/${Math.trunc(pid)}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Arrête les processus dont la ligne de commande contient CE profil jetable (et leurs enfants) ; rend leur nombre. Le numéro noté au lancement
 * ne suffit pas : mesuré, Chrome peut continuer sous un autre numéro, que `close()` et le balayage laissaient alors tourner. Le dossier
 * (suffixe aléatoire, vérifié jetable) ne désigne que ce navigateur ; il est passé par l'environnement, jamais collé dans une commande.
 */
export function killProfileProcesses(profileDir: string): number {
  const pids = profileProcessIds(profileDir);
  for (const pid of pids) killTree(pid);
  return pids.length;
}

/** Les processus (hors le nôtre) dont la ligne de commande contient CE profil jetable ; vide si le dossier n'est pas jetable. */
export function profileProcessIds(profileDir: string): number[] {
  if (!isDisposableProfile(profileDir)) return [];
  const needle = resolve(profileDir);
  let pids: number[] = [];
  try {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:JAROD_PROFILE, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }";
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: childEnv("engine", { explicit: { JAROD_PROFILE: needle } }) });
      pids = out.split(/\r?\n/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    } else {
      for (const n of readdirSync("/proc")) {
        if (!/^\d+$/.test(n)) continue;
        try {
          if (readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0").join(" ").includes(needle)) pids.push(Number(n));
        } catch {
          /* parti entre-temps */
        }
      }
    }
  } catch {
    return [];
  }
  return pids.filter((pid) => pid !== process.pid);
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 15_000, windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* déjà parti */
  }
}

/** Le démon du moteur d'une session : son pid est dans le dossier d'exécution PRIVÉ de la session ; il n'est tué que s'il se présente bien comme tel. */
export function stopSessionDaemon(profileDir: string): void {
  if (!isDisposableProfile(profileDir)) return;
  const run = join(profileDir, "bh-state", "run");
  let names: string[] = [];
  try {
    names = readdirSync(run).filter((n) => n.endsWith(".pid"));
  } catch {
    return;
  }
  for (const n of names) {
    try {
      const raw = readFileSync(join(run, n), "utf8").trim();
      const pid = Number((raw.startsWith("{") ? (JSON.parse(raw) as { pid?: number }).pid : raw.split(/\s+/)[0]) ?? 0);
      if (alive(pid) && (commandLineOf(pid) ?? "").includes("browser_harness.daemon")) killTree(pid);
    } catch {
      /* pid illisible : rien à tuer */
    }
  }
}

/**
 * Au démarrage : retire les sessions E2 ABANDONNÉES (le processus de Jarod qui les avait créées est mort sans les fermer). Ne touche que :
 * un dossier `jarod-e2-*` DIRECTEMENT sous le dossier temporaire, qui n'est ni un lien ni un fichier, qui porte le marqueur de Jarod, dont le
 * propriétaire est mort. Un navigateur n'est tué que si sa ligne de commande contient CE dossier ; le démon, que s'il se présente comme tel.
 * Rien d'autre : ni un navigateur de l'utilisateur, ni un dossier sans marqueur, ni la session d'une autre instance vivante.
 */
export function sweepStaleSessions(): string[] {
  const root = tmpdir();
  const swept: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => n.startsWith(PROFILE_PREFIX));
  } catch {
    return swept;
  }
  for (const n of names) {
    const dir = join(root, n);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || !isDisposableProfile(dir)) continue;
      const m = readMarker(dir);
      if (!m || alive(m.ownerPid)) continue;
      // Par le profil, pas par `chromePid` : ce numéro peut être mort alors que le navigateur tourne encore sous un autre.
      killProfileProcesses(dir);
      stopSessionDaemon(dir);
      // Windows garde les fichiers verrouillés un instant après l'arrêt du navigateur : quelques essais courts.
      let removed = false;
      for (let i = 0; i < 20 && !removed; i++) {
        removed = removeDisposableProfile(dir);
        if (!removed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
      if (removed) swept.push(dir);
    } catch {
      /* ce dossier reste : le prochain balayage réessaiera */
    }
  }
  return swept;
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
  private readonly inflight = new Set<ChildProcess>();
  private aborted = "";
  constructor(private readonly o: HarnessOptions) {
    if (!isDisposableProfile(o.browser.profileDir)) throw new AdapterRefused(A, "le moteur n'accepte qu'un profil jetable");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(o.browser.cdpUrl)) throw new AdapterRefused(A, "le moteur n'accepte qu'un navigateur de bouclage");
    if (!o.guard?.healthy) throw new AdapterRefused(A, "le moteur exige une garde réseau saine (interception obligatoire)");
  }

  private call<T>(req: Record<string, unknown>): Promise<T> {
    return new Promise((resolveCall, reject) => {
      // Garde perdue = plus aucune opération (sauf l'arrêt, qui ne touche pas au réseau).
      if (this.aborted) return reject(new AdapterUnavailable(A, `session révoquée : ${this.aborted}`));
      if (!this.o.guard.healthy && req.op !== "shutdown") return reject(new AdapterUnavailable(A, `garde réseau perdue : ${this.o.guard.reason || "inconnue"}`));
      const p = spawn(this.o.python, ["-I", this.o.bridge], { env: bridgeEnv(this.o), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.inflight.add(p);
      let out = "";
      let err = "";
      const timer = setTimeout(() => (p.kill(), reject(new AdapterUnavailable(A, "le moteur ne répond pas"))), this.o.timeoutMs ?? 40_000);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => (clearTimeout(timer), reject(new AdapterUnavailable(A, `moteur impossible à lancer : ${e.message}`))));
      p.on("close", () => {
        clearTimeout(timer);
        this.inflight.delete(p);
        if (this.aborted) return reject(new AdapterUnavailable(A, `session révoquée : ${this.aborted}`));
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
  /** Révocation : toute opération en cours est interrompue (son processus tué), plus aucune ne démarre. */
  abort(why: string): void {
    this.aborted = why || "révoquée";
    for (const p of this.inflight) {
      try {
        p.kill();
      } catch {
        /* déjà fini */
      }
    }
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
  webrtcHardening?: boolean;
  quicHardening?: boolean;
  /** See `LaunchOptions.networkServiceSandbox`: false only for the UDP proof's measurements. */
  networkServiceSandbox?: boolean;
}

export interface GuardedSession {
  browser: DisposableBrowser;
  guard: NetworkGuard;
  backend: HarnessBackend;
  /** Révocation IMMÉDIATE : la garde refuse tout, les opérations en cours sont interrompues, le navigateur et son profil sont détruits. */
  revoke(why?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * La SEULE façon de démarrer E2 : navigateur jetable + garde réseau démontrée + moteur. Si la liste blanche est vide, si l'interception
 * échoue ou n'est pas démontrée, rien ne démarre et le navigateur jetable (profil compris) est détruit. Si la garde est perdue plus tard,
 * la session est arrêtée d'elle-même.
 */
export async function startGuardedSession(o: GuardedSessionOptions): Promise<GuardedSession> {
  if (o.policy.allowDomains.length === 0) throw new AdapterRefused(A, "liste blanche vide : la session E2 ne démarre pas");
  const browser = await launchDisposableBrowser({ chromeBin: o.chromeBin, headless: o.headless, webrtcHardening: o.webrtcHardening, quicHardening: o.quicHardening, networkServiceSandbox: o.networkServiceSandbox, ...(o.proxyBackstop === false ? {} : { allowDomains: o.policy.allowDomains }) });
  let ending: Promise<void> | null = null;
  let holder: { guard: NetworkGuard; backend: HarnessBackend } | null = null;
  const end = (why: string): Promise<void> => {
    ending ??= (async () => {
      holder?.guard.revoke(why);
      holder?.backend.abort(why);
      stopSessionDaemon(browser.profileDir);
      await browser.close();
    })();
    return ending;
  };
  try {
    const guard = await NetworkGuard.start({ cdpUrl: browser.cdpUrl, permits: (u) => urlPermitted(u, o.policy), onBlock: o.onBlock, onUnhealthy: (why) => void end(why) });
    const backend = new HarnessBackend({ python: o.python, bridge: o.bridge, browser, guard, telemetryHost: o.telemetryHost });
    holder = { guard, backend };
    return { browser, guard, backend, revoke: (why = "révoquée") => end(why), close: () => end("fermée") };
  } catch (e) {
    await end("démarrage échoué");
    throw e;
  }
}
