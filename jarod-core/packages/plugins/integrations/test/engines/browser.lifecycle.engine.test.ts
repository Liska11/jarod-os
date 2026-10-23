// E2 — REVOCATION, CONFINEMENT DU POINT D'ACCÈS CDP, NETTOYAGE ET RÉSEAU UDP, contre le moteur RÉEL (Chrome jetable, site contrôlé, témoins).
// Aucun profil réel n'est ouvert ; seuls les processus et dossiers que ces essais créent eux-mêmes sont touchés.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserApprovalRequest,
  type BrowserAuditEntry,
  commandLineOf,
  ConnectedBrowserHost,
  discoverEnginePaths,
  type GuardedSession,
  startGuardedSession,
  sweepStaleSessions,
} from "../../src/index.js";
import { ROOT } from "./helpers.js";
import { defaultRouteIPv4, startTestSite, startUdpWitness, startWitness, type TestSite, type UdpWitness, type Witness } from "./browser_site.js";

const PYTHON = join(ROOT, "engines", "browser-harness", "Scripts", "python.exe");
const BRIDGE = join(ROOT, "jarod-core", "sidecars", "browser-bridge", "bh_ops.py");
const CHROME = join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe");
const HAS = process.platform === "win32" && existsSync(PYTHON) && existsSync(CHROME);
const LOCAL = { allowDomains: ["localhost"] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Les processus dont la ligne de commande contient `needle` (hors ce processus de test et l'interrogation elle-même). */
function processesMatching(needle: string): { pid: number; name: string }[] {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}') -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -notmatch 'Get-CimInstance' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return out ? out.split(/\r?\n/u).map((l) => ({ pid: Number(l.split("|")[0]), name: l.split("|")[1] ?? "" })) : [];
}
/**
 * Le démon du moteur d'UNE session : le numéro écrit dans son dossier d'exécution privé (`<profil>/bh-state/run/*.pid`), et ses enfants directs
 * (le lanceur du venv et le processus qu'il lance). Comparer tous les démons de la machine avant/après comptait aussi ceux qu'un autre fichier
 * d'essai lance en même temps.
 */
function sessionDaemons(profile: string): number[] {
  const run = join(profile, "bh-state", "run");
  const roots: number[] = [];
  for (const n of existsSync(run) ? readdirSync(run).filter((f) => f.endsWith(".pid")) : []) {
    const raw = readFileSync(join(run, n), "utf8").trim();
    const pid = Number((raw.startsWith("{") ? (JSON.parse(raw) as { pid?: number }).pid : raw.split(/\s+/)[0]) ?? 0);
    if (pid > 0) roots.push(pid);
  }
  if (roots.length === 0) return [];
  const list = roots.join(",");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('browser_harness.daemon') -and (@(${list}) -contains $_.ProcessId -or @(${list}) -contains $_.ParentProcessId) } | ForEach-Object { $_.ProcessId }`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return out ? out.split(/\r?\n/u).map(Number) : [];
}
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

describe.skipIf(!HAS)("E2 — cycle de vie, révocation, confinement CDP, nettoyage, UDP (moteur réel)", () => {
  let site: TestSite;
  let witness: Witness;
  let udp: UdpWitness;
  let routeIp: string | null;

  beforeAll(async () => {
    witness = await startWitness();
    routeIp = await defaultRouteIPv4();
    udp = await startUdpWitness(routeIp ?? "127.0.0.1");
    site = await startTestSite(witness.port);
  }, 60_000);

  afterAll(async () => {
    await site?.close();
    await witness?.close();
    await udp?.close();
  }, 60_000);

  /** L'hôte tel que l'application le construit, avec un réglage de l'UTILISATEUR (domaine pointé : « localhost » seul est refusé par le réglage). */
  function appHost(settings: { v: unknown }) {
    const sessions: GuardedSession[] = [];
    const audit: BrowserAuditEntry[] = [];
    const asked: BrowserApprovalRequest[] = [];
    const host = new ConnectedBrowserHost({
      settings: () => settings.v,
      engine: () => discoverEnginePaths({ root: ROOT }),
      approve: async (r) => (asked.push(r), true),
      audit: (e) => audit.push(e),
      start: async (o) => {
        const s = await startGuardedSession(o);
        sessions.push(s);
        return s;
      },
    });
    return { host, sessions, audit, asked };
  }
  const siteUrl = (path = "/") => `http://site.localhost:${site.port}${path}`;
  const ticks = () => site.hits.filter((h) => h.path === "/tick" || h.path === "/tickimg").length;

  // ── 6. UDP / WebRTC ─────────────────────────────────────────────────────────────────────────────────────
  it("PREUVE RÉSEAU WebRTC/UDP : le témoin UDP reçoit des datagrammes sans durcissement (contrôle) et ZÉRO avec — STUN, TURN-UDP, TURN-TCP et WebTransport", async (ctx) => {
    // Two machine facts make the witness blind if ignored (docs/E2-VALIDATION.md §6.2):
    // - WebRTC sends from sockets bound to a network interface, and Windows refuses those writes towards 127.0.0.1 (EADDRNOTAVAIL):
    //   the UDP witness listens on the default-route address, where Chrome gathers its host candidate;
    // - on some Windows machines Chrome's network-service sandbox alone drops every WebRTC datagram: the measurements below run
    //   without it, so a zero under hardening is the flags' doing, not the sandbox's. A last run uses the app's exact launch.
    if (!routeIp) ctx.skip("preuve UDP non concluante : aucune interface IPv4 avec une route par défaut, le témoin ne verrait rien (docs/E2-VALIDATION.md §6.2)");
    const run = async (o: { hard: boolean; backstop: boolean; appSandbox?: boolean }, path: "rtc" | "wt") => {
      const s = await startGuardedSession({ chromeBin: CHROME, python: PYTHON, bridge: BRIDGE, policy: LOCAL, proxyBackstop: o.backstop, webrtcHardening: o.hard, quicHardening: o.hard, networkServiceSandbox: o.appSandbox === true });
      try {
        witness.reset();
        udp.reset();
        const id = await s.backend.openTab(site.url("localhost", `/${path}?udp=${udp.port}&uh=${udp.host}&tcp=${witness.port}`));
        await wait(5000);
        const text = (await s.backend.readPage(id)).text.replace(/\s+/g, " ");
        return { udp: udp.packets, tcp: witness.connections, candidates: Number(/CANDS:(\d+)/.exec(text)?.[1] ?? 0) };
      } finally {
        await s.close();
      }
    };
    const control = await run({ hard: false, backstop: false }, "rtc");
    // Le contrôle PROUVE que le témoin voit ce qui sortirait : sans lui, un zéro ne dirait rien. S'il reste à zéro, la machine ne laisse
    // sortir aucun UDP WebRTC de Chrome même sans bac à sable : la preuve est déclarée NON CONCLUANTE (ignorée, avec la mesure), jamais réussie.
    if (control.udp === 0) ctx.skip(`preuve UDP non concluante : contrôle WebRTC à 0 datagramme vers ${udp.host} (candidats : ${control.candidates}, TURN-TCP : ${control.tcp}) — docs/E2-VALIDATION.md §6.2`);
    expect(control.candidates).toBeGreaterThan(0);
    const controlWt = await run({ hard: false, backstop: false }, "wt");
    // Même règle pour WebTransport : un témoin aveugle (0) ne prouve rien dans un sens ni dans l'autre. Non concluant, ce n'est ni une réussite ni une fuite.
    if (controlWt.udp === 0) ctx.skip(`preuve UDP non concluante pour WebTransport : contrôle à 0 datagramme vers ${udp.host} alors que WebRTC en a émis ${control.udp} — docs/E2-VALIDATION.md §6.2`);
    expect(controlWt.udp).toBeGreaterThan(0);
    // Le filet (proxy mort) seul NE couvre PAS l'UDP : mesuré, c'est pourquoi le drapeau existe.
    const proxyOnly = await run({ hard: false, backstop: true }, "rtc");
    // Zéro ici veut dire que le proxy mort a aussi arrêté l'UDP, ou que le témoin n'a rien vu : la mesure n'établit plus ce que ce test affirme.
    if (proxyOnly.udp === 0) ctx.skip(`preuve UDP non concluante : avec le seul proxy mort le témoin reçoit 0 datagramme (contrôle sans proxy : ${control.udp}) — la limite « le proxy ne couvre pas l'UDP » n'est pas établie sur cette machine`);
    expect(proxyOnly.udp).toBeGreaterThan(0);
    expect(proxyOnly.tcp).toBe(0);
    // Le drapeau seul ferme l'UDP et ne laisse apprendre aucune adresse de la machine ; le TCP (TURN) est fermé par le filet.
    const flagOnly = await run({ hard: true, backstop: false }, "rtc");
    expect(flagOnly).toMatchObject({ udp: 0, candidates: 0 });
    // La pile complète des durcissements, sans le bac à sable de Chrome : zéro.
    const full = await run({ hard: true, backstop: true }, "rtc");
    expect(full).toEqual({ udp: 0, tcp: 0, candidates: 0 });
    const fullWt = await run({ hard: true, backstop: true }, "wt");
    expect(fullWt).toMatchObject({ udp: 0, tcp: 0 });
    // Et telle que l'application la lance (bac à sable compris) : zéro aussi.
    const app = await run({ hard: true, backstop: true, appSandbox: true }, "rtc");
    expect(app).toEqual({ udp: 0, tcp: 0, candidates: 0 });
  }, 320_000);

  // ── 4. Révocation pendant une opération, requêtes d'arrière-plan comprises ─────────────────────────────
  it("révocation d'un DOMAINE pendant une opération en cours : l'opération est interrompue, les requêtes d'arrière-plan de la page s'arrêtent net, navigateur et profil sont détruits", async () => {
    const settings = { v: { enabled: true, allowDomains: ["site.localhost"] } as unknown };
    const { host, sessions } = appHost(settings);
    try {
      const id = await host.openTab(siteUrl("/ticker"));
      await wait(2000);
      const running = ticks();
      expect(running).toBeGreaterThan(3); // contrôle : la page émet bien, en arrière-plan, sans qu'on fasse rien
      const s = sessions[0]!;
      const profile = s.browser.profileDir;
      expect(processesMatching(profile).length).toBeGreaterThan(0);

      const pending = host.navigate(id, siteUrl("/slow?ms=8000")).then(
        () => "fini",
        (e: Error) => e.message,
      );
      await wait(600);
      settings.v = { enabled: true, allowDomains: ["autre.example.org"] }; // le domaine du site est RETIRÉ
      const t0 = Date.now();
      await host.reconcile();
      const revokedIn = Date.now() - t0;

      expect(await pending).toMatch(/révoquée/);
      expect(revokedIn).toBeLessThan(15_000);
      const atRevoke = ticks();
      await wait(1200);
      expect(ticks()).toBe(atRevoke); // plus une requête d'arrière-plan après la révocation
      expect(existsSync(profile)).toBe(false);
      expect(processesMatching(profile)).toEqual([]);
      expect(s.guard.healthy).toBe(false);
      expect(host.status().state).toMatch(/idle|disabled/);
      // une opération suivante n'a plus de session à réutiliser : domaine retiré = refusé avant tout lancement
      await expect(host.openTab(siteUrl("/"))).rejects.toThrow(/politique/);
      expect(sessions).toHaveLength(1);
    } finally {
      await host.close();
    }
  }, 120_000);

  it("extinction du réglage, puis perte de la garde (navigateur tué) : opérations refusées, session arrêtée, processus et profil nettoyés ; l'action suivante approuvée repart sur une session NEUVE", async () => {
    const settings = { v: { enabled: true, allowDomains: ["site.localhost"] } as unknown };
    const { host, sessions, asked } = appHost(settings);
    try {
      const id = await host.openTab(siteUrl("/ticker"));
      const first = sessions[0]!;
      settings.v = { enabled: false, allowDomains: ["site.localhost"] };
      await host.reconcile();
      expect(existsSync(first.browser.profileDir)).toBe(false);
      await expect(host.readPage(id)).rejects.toThrow(/désactivé/);
      const askedBefore = asked.length;
      await expect(host.openTab(siteUrl("/"))).rejects.toThrow(/désactivé/);
      expect(asked.length).toBe(askedBefore); // éteint : on ne demande même pas

      // perte de la garde : le navigateur est tué de l'extérieur (ce que ferait un plantage)
      settings.v = { enabled: true, allowDomains: ["site.localhost"] };
      await host.openTab(siteUrl("/"));
      const second = sessions[1]!;
      const marker = JSON.parse(readFileSync(join(second.browser.profileDir, "owner.json"), "utf8")) as { chromePid: number };
      spawnSync("taskkill", ["/PID", String(marker.chromePid), "/T", "/F"], { windowsHide: true });
      for (let i = 0; i < 100 && second.guard.healthy; i++) await wait(100);
      expect(second.guard.healthy).toBe(false);
      for (let i = 0; i < 100 && existsSync(second.browser.profileDir); i++) await wait(100);
      expect(existsSync(second.browser.profileDir)).toBe(false); // la session s'est arrêtée d'elle-même
      expect(host.status()).toMatchObject({ state: "failed", reason: expect.stringMatching(/garde perdue/) });
      await expect(second.backend.listTabs()).rejects.toThrow(/révoquée|garde/);
      // l'action suivante, approuvée, démarre une session neuve (garde neuve, profil neuf)
      await host.openTab(siteUrl("/"));
      const third = sessions[2]!;
      expect(third.browser.profileDir).not.toBe(second.browser.profileDir);
      expect(third.guard.healthy).toBe(true);
    } finally {
      await host.close();
    }
  }, 180_000);

  // ── 5. Confinement du point d'accès CDP, confidentialité, nettoyage ────────────────────────────────────
  it("point d'accès CDP : écoute sur le bouclage SEUL, refuse un en-tête Host étranger et une origine de page web, et n'apparaît dans aucun journal, accord, état ni message", async () => {
    const settings = { v: { enabled: true, allowDomains: ["site.localhost"] } as unknown };
    const { host, sessions, audit, asked } = appHost(settings);
    const outputs: string[] = [];
    try {
      const id = await host.openTab(siteUrl("/"));
      outputs.push(await host.readPage(id));
      const s = sessions[0]!;
      const port = Number(new URL(s.browser.cdpUrl).port);
      const marker = JSON.parse(readFileSync(join(s.browser.profileDir, "owner.json"), "utf8")) as { chromePid: number };

      // 1. écoute : toutes les adresses de LECTURE du navigateur sont des adresses de bouclage
      const listen = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Get-NetTCPConnection -State Listen -OwningProcess ${marker.chromePid} | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)" }`], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/u).filter(Boolean);
      expect(listen.length).toBeGreaterThan(0);
      expect(listen.some((l) => l.endsWith(`|${port}`))).toBe(true);
      for (const l of listen) expect(["127.0.0.1", "::1"], l).toContain(l.split("|")[0]);

      // 2. un en-tête Host étranger (rebond DNS) est refusé ; le contrôle (Host de bouclage) passe
      const status = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const q = httpRequest({ host: "127.0.0.1", port, path: "/json/version", headers }, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
          q.on("error", reject);
          q.end();
        });
      expect(await status({})).toBe(200);
      expect(await status({ Host: "evil.example" })).not.toBe(200);

      // 3. une page web (en-tête Origin) ne peut pas ouvrir le WebSocket du navigateur ; sans Origin, si (contrôle)
      const version = await new Promise<string>((resolve, reject) => {
        const q = httpRequest({ host: "127.0.0.1", port, path: "/json/version" }, (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => resolve(b));
        });
        q.on("error", reject);
        q.end();
      });
      const wsPath = new URL((JSON.parse(version) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl).pathname;
      const handshake = (origin?: string) =>
        new Promise<string>((resolve) => {
          const sock = connect(port, "127.0.0.1", () => sock.write(`GET ${wsPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ""}\r\n`));
          let buf = "";
          sock.on("data", (d) => {
            buf += d.toString("latin1");
            if (buf.includes("\r\n")) (sock.destroy(), resolve(buf.split("\r\n")[0]!));
          });
          sock.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
          setTimeout(() => (sock.destroy(), resolve(buf.split("\r\n")[0] ?? "")), 5000);
        });
      expect(await handshake()).toMatch(/101/);
      expect(await handshake("http://evil.example")).toMatch(/403/);

      // 4. confidentialité : ni le port, ni le chemin WebSocket (jeton de capacité du navigateur) dans ce que l'application journalise, demande ou rend
      outputs.push(JSON.stringify(audit), JSON.stringify(asked), JSON.stringify(host.status()));
      for (const p of [() => host.click(id, "#absent"), () => host.readPage("onglet-inconnu"), () => host.openTab("https://pas-permis.example/")]) {
        outputs.push(await p().then(() => "", (e: Error) => String(e.message)));
      }
      const secret = [`:${port}`, wsPath, wsPath.split("/").pop() ?? "x", s.browser.cdpUrl];
      for (const out of outputs) for (const needle of secret) expect(out, needle).not.toContain(needle);

      // 5. le dossier de la session n'est lisible que par l'utilisateur (le fichier DevToolsActivePort contient le chemin secret)
      if (process.platform === "win32") {
        const sids = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Acl '${s.browser.profileDir}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/u);
        const me = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim();
        for (const sid of sids) expect(["S-1-5-18", "S-1-5-32-544", me], sid).toContain(sid.trim());
      } else {
        expect(statSync(s.browser.profileDir).mode & 0o077).toBe(0);
      }
      void userInfo;
    } finally {
      await host.close();
    }
  }, 120_000);

  it("nettoyage : la fermeture n'ôte que ce que la session a créé (navigateur, démon du moteur, profil) ; un dossier voisin et un processus étranger restent intacts", async () => {
    const decoyDir = mkdtempSync(join(tmpdir(), "jarod-e2-decoy-"));
    writeFileSync(join(decoyDir, "intact.txt"), "x");
    const decoyProc = spawn(process.execPath, ["-e", `setTimeout(()=>{}, 60000)`, "--", decoyDir], { stdio: "ignore", windowsHide: true });
    const settings = { v: { enabled: true, allowDomains: ["site.localhost"] } as unknown };
    const { host, sessions } = appHost(settings);
    try {
      await host.openTab(siteUrl("/"));
      const profile = sessions[0]!.browser.profileDir;
      const mine = processesMatching(profile).map((p) => p.pid);
      expect(mine.length).toBeGreaterThan(1); // le navigateur et ses sous-processus
      const myDaemons = sessionDaemons(profile);
      expect(myDaemons.length).toBeGreaterThan(0); // le démon du moteur de CETTE session (le lanceur du venv et le processus qu'il lance)
      // …et il porte le profil dans sa ligne de commande : l'arrêt par le profil le trouve même s'il démarre encore à la fermeture.
      expect(myDaemons.filter((pid) => !mine.includes(pid))).toEqual([]);
      await host.close();
      await wait(1500);
      expect(processesMatching(profile)).toEqual([]);
      expect(myDaemons.filter(pidAlive)).toEqual([]);
      expect(existsSync(profile)).toBe(false);
      // les voisins n'ont pas bougé
      expect(existsSync(join(decoyDir, "intact.txt"))).toBe(true);
      expect(pidAlive(decoyProc.pid ?? 0)).toBe(true);
    } finally {
      await host.close();
      decoyProc.kill();
      rmSync(decoyDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("balayage au démarrage : retire une session ABANDONNÉE (propriétaire mort) — navigateur, démon, profil — et RIEN d'autre", async () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    expect(dead.status).toBe(0);
    // un propriétaire mort : un numéro de processus qui a existé puis fini
    const deadPid = (() => {
      const c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
      return c.pid ?? 0;
    })();
    await wait(1500);
    expect(pidAlive(deadPid)).toBe(false);

    // 1. une session réelle dont le propriétaire « plante » : on réécrit son marqueur avec un propriétaire mort
    const s = await startGuardedSession({ chromeBin: CHROME, python: PYTHON, bridge: BRIDGE, policy: LOCAL });
    const profile = s.browser.profileDir;
    await s.backend.openTab(site.url("localhost"));
    const markerPath = join(profile, "owner.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { ownerPid: number; chromePid: number; createdAt: number };
    // 2. des leurres qui NE doivent PAS être touchés
    const noMarker = mkdtempSync(join(tmpdir(), "jarod-e2-nomarker-"));
    const liveOwner = mkdtempSync(join(tmpdir(), "jarod-e2-liveowner-"));
    writeFileSync(join(liveOwner, "owner.json"), JSON.stringify({ ownerPid: process.pid, chromePid: 0, createdAt: Date.now() }));
    const reusedPid = mkdtempSync(join(tmpdir(), "jarod-e2-reusedpid-"));
    const stranger = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
    writeFileSync(join(reusedPid, "owner.json"), JSON.stringify({ ownerPid: deadPid, chromePid: stranger.pid, createdAt: Date.now() }));
    const outside = mkdtempSync(join(tmpdir(), "autre-"));
    writeFileSync(join(outside, "gardien.txt"), "x");
    const link = join(tmpdir(), `jarod-e2-lien-${process.pid}`);
    let linked = true;
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      linked = false;
    }
    const notOurs = join(tmpdir(), `pas-jarod-${process.pid}`);
    mkdirSync(notOurs);
    writeFileSync(join(notOurs, "owner.json"), JSON.stringify({ ownerPid: deadPid, chromePid: 0, createdAt: 1 }));
    try {
      // sans le plantage simulé, le balayage ne touche pas à la session vivante
      expect(sweepStaleSessions()).not.toContain(profile);
      expect(existsSync(profile)).toBe(true);

      writeFileSync(markerPath, JSON.stringify({ ...marker, ownerPid: deadPid }));
      sweepStaleSessions(); // (un autre processus de test peut balayer en même temps : on vérifie l'effet, pas la liste rendue)
      expect(existsSync(profile)).toBe(false);
      await wait(1000);
      expect(pidAlive(marker.chromePid)).toBe(false); // le navigateur de la session abandonnée a été arrêté
      // le « navigateur » étranger visé par un marqueur à numéro réutilisé n'est PAS tué (sa ligne de commande ne porte pas le dossier)…
      expect(pidAlive(stranger.pid ?? 0)).toBe(true);
      // …et les leurres sont intacts
      expect(existsSync(noMarker)).toBe(true);
      expect(existsSync(liveOwner)).toBe(true);
      expect(existsSync(join(outside, "gardien.txt"))).toBe(true);
      if (linked) expect(existsSync(link)).toBe(true);
      expect(existsSync(notOurs)).toBe(true);
      void commandLineOf;
    } finally {
      await s.close().catch(() => undefined);
      stranger.kill();
      for (const d of [noMarker, liveOwner, reusedPid, outside, notOurs]) rmSync(d, { recursive: true, force: true });
      if (linked) rmSync(link, { recursive: true, force: true });
      expect(readdirSync(tmpdir()).filter((n) => n === `jarod-e2-lien-${process.pid}`).length).toBe(0);
    }
  }, 180_000);
});
