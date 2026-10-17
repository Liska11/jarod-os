// Un Firefox de TEST piloté par geckodriver : build ESR séparé (engines/firefox-test), profil neuf créé par geckodriver, aucune relation avec le Firefox de
// l'utilisateur. Sert à essayer la VRAIE extension : installation temporaire, onglets leurres, geste simulé sur le bouton de l'extension.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const FIREFOX_DIR = (root: string) => join(root, "engines", "firefox-test");
export const firefoxBin = (root: string) => join(FIREFOX_DIR(root), "firefox", "core", "firefox.exe");
export const geckodriverBin = (root: string) => join(FIREFOX_DIR(root), "geckodriver", "geckodriver.exe");
export const hasFirefoxTest = (root: string) => process.platform === "win32" && existsSync(firefoxBin(root)) && existsSync(geckodriverBin(root));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

export class FirefoxTest {
  private constructor(
    private readonly base: string,
    private readonly proc: ChildProcess,
    readonly session: string,
  ) {}

  static async start(root: string, o: { headless?: boolean } = {}): Promise<FirefoxTest> {
    const port = await freePort();
    const proc = spawn(geckodriverBin(root), ["--port", String(port), "--binary", firefoxBin(root), "--log", "fatal", "--allow-system-access"], { stdio: "ignore", windowsHide: true });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/status`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const res = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            browserName: "firefox",
            acceptInsecureCerts: true,
            "moz:firefoxOptions": {
              binary: firefoxBin(root),
              // `-no-remote` : jamais de lien avec une instance déjà ouverte ; le profil est CELUI que geckodriver crée (neuf, effacé à la fin)
              args: [...(o.headless === false ? [] : ["-headless"]), "-no-remote"],
              prefs: { "browser.shell.checkDefaultBrowser": false, "datareporting.policy.dataSubmissionEnabled": false, "app.update.auto": false, "app.update.enabled": false, "extensions.autoDisableScopes": 0 },
            },
          },
        },
      }),
    });
    const body = (await res.json()) as { value: { sessionId?: string; error?: string; message?: string } };
    if (!body.value.sessionId) {
      proc.kill();
      throw new Error(`Firefox de test : ${body.value.error ?? "?"} ${body.value.message ?? ""}`);
    }
    return new FirefoxTest(base, proc, body.value.sessionId);
  }

  async cmd<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/session/${this.session}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? (method === "POST" ? { body: "{}" } : {}) : { body: JSON.stringify(body) }) });
    const json = (await res.json()) as { value: T & { error?: string; message?: string } };
    if (json.value && typeof json.value === "object" && "error" in json.value && json.value.error) throw new Error(`${path}: ${json.value.error} ${json.value.message ?? ""}`);
    return json.value;
  }

  installAddon(dir: string) {
    return this.cmd<string>("POST", "/moz/addon/install", { path: dir, temporary: true });
  }
  windows() {
    return this.cmd<string[]>("GET", "/window/handles");
  }
  async newTab(url: string): Promise<string> {
    const w = await this.cmd<{ handle: string }>("POST", "/window/new", { type: "tab" });
    await this.cmd("POST", "/window", { handle: w.handle });
    await this.cmd("POST", "/url", { url });
    return w.handle;
  }
  select(handle: string) {
    return this.cmd("POST", "/window", { handle });
  }
  navigate(url: string) {
    return this.cmd("POST", "/url", { url });
  }
  close() {
    return this.cmd("DELETE", "/window");
  }
  /** Script dans la PAGE du contexte courant. */
  page<T = unknown>(script: string, args: unknown[] = []) {
    return this.cmd<T>("POST", "/execute/sync", { script, args });
  }
  /** Script ASYNCHRONE dans la page : le dernier argument est le rappel de fin. */
  pageAsync<T = unknown>(script: string, args: unknown[] = []) {
    return this.cmd<T>("POST", "/execute/async", { script, args });
  }
  /** Script dans le CHROME du navigateur de test (interface), pour simuler le geste sur le bouton de l'extension. */
  async chrome<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    await this.cmd("POST", "/moz/context", { context: "chrome" });
    try {
      return await this.cmd<T>("POST", "/execute/sync", { script, args });
    } finally {
      await this.cmd("POST", "/moz/context", { context: "content" });
    }
  }

  async quit(): Promise<void> {
    try {
      await this.cmd("DELETE", "");
    } catch {
      /* déjà parti */
    }
    this.proc.kill();
  }
}
