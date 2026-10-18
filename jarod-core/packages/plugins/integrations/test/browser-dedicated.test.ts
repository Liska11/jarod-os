// E2 — le navigateur DÉDIÉ à JAROD-OS, et lui seul. Aucune voie vers le profil quotidien de l'utilisateur : ni argument, ni réglage, ni variable, ni code.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { browserArgs, discoverEnginePaths, isDisposableProfile, parseBrowserConfig, proxyBackstopArgs } from "../src/index.js";

const SRC = resolve(import.meta.dirname, "..", "src");
const BRIDGE_SETTINGS = resolve(import.meta.dirname, "..", "..", "..", "bridge", "src", "main", "handlers", "jarod-settings.ts");
const CLI_GATEWAY = resolve(import.meta.dirname, "..", "..", "..", "cli", "src", "gateway");

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, out);
    else if (/\.(ts|py)$/.test(n)) out.push(f);
  }
  return out;
}

describe("navigateur dédié : arguments", () => {
  const userData = join(tmpdir(), "jarod-e2-x", "chrome");
  const args = browserArgs(userData, { allowDomains: ["exemple.org"] });

  it("UN seul dossier de données (celui de la session), jamais un profil désigné par un autre argument", () => {
    expect(args.filter((a) => a.startsWith("--user-data-dir="))).toEqual([`--user-data-dir=${userData}`]);
    expect(isDisposableProfile(join(tmpdir(), "jarod-e2-x"))).toBe(true);
    for (const a of args) expect(a, a).not.toMatch(/--profile-directory|--remote-debugging-pipe|--remote-allow-origins|--load-extension|--restore-last-session|--disk-cache-dir|--app-user-model|--user-data-dir=(?!.*jarod-e2-)/);
  });

  it("DevTools : bouclage seul, port choisi par le système (pas de port fixe devinable)", () => {
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args.filter((a) => a.startsWith("--remote-debugging-"))).toHaveLength(2);
  });

  it("durcissements par défaut : QUIC coupé, UDP de WebRTC fermé, proxy mort hors liste, aucun accès réseau d'arrière-plan", () => {
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(args).toContain("--disable-background-networking");
    expect(args).toContain("--disable-sync");
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--password-store=basic");
    expect(args.find((a) => a.startsWith("--proxy-server="))).toMatch(/\.invalid:\d+$/);
    expect(args.find((a) => a.startsWith("--proxy-bypass-list="))).toBe("--proxy-bypass-list=<-loopback>;exemple.org;*.exemple.org");
    expect(proxyBackstopArgs([])).toContain("--proxy-bypass-list=<-loopback>");
  });

  it("le bac à sable du service réseau de Chrome reste en place par défaut ; seul un `false` explicite (mesures de la preuve UDP) le retire", () => {
    expect(args.some((a) => a.includes("NetworkServiceSandbox"))).toBe(false);
    expect(browserArgs(userData, { networkServiceSandbox: true }).some((a) => a.includes("NetworkServiceSandbox"))).toBe(false);
    expect(browserArgs(userData, { networkServiceSandbox: false })).toContain("--disable-features=NetworkServiceSandbox");
  });
});

describe("navigateur dédié : aucune voie vers le profil quotidien", () => {
  it("la recherche du moteur ne regarde que le venv épinglé et le Chromium de Playwright", () => {
    const seen: string[] = [];
    discoverEnginePaths({ root: "C:/r", platform: "win32", env: { LOCALAPPDATA: "C:/Users/u/AppData/Local" }, exists: (p) => (seen.push(p), false), list: () => [] });
    discoverEnginePaths({ root: "/r", platform: "linux", home: "/home/u", exists: (p) => (seen.push(p), false), list: () => [] });
    expect(seen.join("\n")).not.toMatch(/User Data|Google|Application|google-chrome|chromium-browser|Chrome\.app|Profiles/i);
  });

  it("le réglage de l'utilisateur ne sait exprimer ni profil, ni chemin de navigateur, ni moteur, ni adresse DevTools : toute clé en plus est ignorée", () => {
    const cfg = parseBrowserConfig({ enabled: true, allowDomains: ["exemple.org"], profile: "C:/Users/u/AppData/Local/Google/Chrome/User Data", userDataDir: "x", chromePath: "C:/chrome.exe", cdpUrl: "http://127.0.0.1:9222", python: "x" });
    expect(Object.keys(cfg).sort()).toEqual(["allowDomains", "denyDomains", "enabled"]);
    expect(JSON.stringify(cfg)).not.toMatch(/Google|User Data|9222|chrome\.exe/);
  });

  it("aucun code de l'intégration ne nomme un dossier de navigateur personnel ni ne lit un profil existant", () => {
    const sources = [...files(SRC), ...files(resolve(import.meta.dirname, "..", "..", "..", "..", "sidecars", "browser-bridge")), BRIDGE_SETTINGS, ...files(CLI_GATEWAY)].filter((f) => /browser|connected-browser|bh_ops|jarod-settings/.test(f));
    expect(sources.length).toBeGreaterThan(4);
    for (const f of sources) {
      const code = readFileSync(f, "utf8")
        .split(/\r?\n/u)
        // les commentaires et les chaînes de refus peuvent NOMMER ce qu'on interdit ; le code exécuté, non
        .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/User Data[\\/]Default|Google[\\/]+Chrome[\\/]+User|\.config[\\/]google-chrome|Application Support[\\/]Google|--profile-directory/);
    }
  });

  it("le pont du moteur écarte les variables qui le feraient chercher un navigateur ou un compte ailleurs", () => {
    const bridge = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "..", "sidecars", "browser-bridge", "bh_ops.py"), "utf8");
    for (const name of ["BU_CDP_WS", "BU_BROWSER_ID", "BU_AUTOSPAWN", "BROWSER_USE_API_KEY"]) expect(bridge).toContain(`"${name}"`);
    expect(bridge).toMatch(/jarod-e2-/);
    expect(bridge).toMatch(/127\.0\.0\.1/);
  });
});
