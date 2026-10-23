import dgram from "node:dgram";
import dns from "node:dns";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAUTIOUS_POLICY,
  connectTarget,
  decideHost,
  DEFAULT_POLICY,
  installNetworkGuard,
  isLoopback,
  type NetworkPolicy,
  OFFLINE_CODE,
  parsePolicy,
  policyReader,
  toolVerdict,
  uninstallNetworkGuard,
} from "../src/network.js";

// Mêmes cas que apps/desktop/electron/network.test.ts : les deux implémentations doivent décider pareil.
const off: NetworkPolicy = { ...DEFAULT_POLICY, internet: false };

describe("fichier de politique", () => {
  it("pas de fichier : défaut ; mal formé : Internet coupé", () => {
    expect(parsePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(parsePolicy("{")).toEqual(CAUTIOUS_POLICY);
    expect(parsePolicy('{"version":2,"internet":true}')).toEqual(CAUTIOUS_POLICY);
    expect(parsePolicy('{"version":1,"internet":"yes"}')).toEqual(CAUTIOUS_POLICY);
    expect(parsePolicy("[]")).toEqual(CAUTIOUS_POLICY);
  });

  it("garde les seules adresses valides, en minuscules, sans doublon", () => {
    const p = parsePolicy(JSON.stringify({ version: 1, internet: false, remoteMachines: true, remoteHosts: ["100.64.0.7", "PC-Bureau.tail1234.ts.net", "bad host", 3, "100.64.0.7"] }));
    expect(p.remoteHosts).toEqual(["100.64.0.7", "pc-bureau.tail1234.ts.net"]);
  });

  it("le lecteur suit les changements du fichier, et lit un fichier disparu comme Internet coupé", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-net-"));
    try {
      const file = join(dir, "network-policy.json");
      writeFileSync(file, JSON.stringify(DEFAULT_POLICY));
      const read = policyReader(file);
      expect(read().internet).toBe(true);
      writeFileSync(file, JSON.stringify(off));
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(read().internet).toBe(false);
      rmSync(file);
      expect(read()).toEqual(CAUTIOUS_POLICY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hôtes permis", () => {
  it("cette machine toujours", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", "LOCALHOST."]) {
      expect(isLoopback(h), h).toBe(true);
      expect(decideHost(off, h), h).toBe("loopback");
    }
  });

  it("Internet et réseau local bloqués pareil hors ligne", () => {
    for (const h of ["example.com", "8.8.8.8", "192.168.1.20", "10.0.0.5", "100.64.0.7", "pc-bureau", "128.0.0.1"]) expect(decideHost(off, h), h).toBe("blocked");
  });

  it("seules les machines distantes configurées, et seulement avec l'exception", () => {
    const remote: NetworkPolicy = { ...off, remoteMachines: true, remoteHosts: ["100.64.0.7"] };
    expect(decideHost(remote, "100.64.0.7")).toBe("remote");
    expect(decideHost(remote, "100.64.0.8")).toBe("blocked");
    expect(decideHost({ ...remote, remoteMachines: false }, "100.64.0.7")).toBe("blocked");
  });
});

describe("outils hors ligne", () => {
  it("en ligne, rien n'est refusé", () => {
    for (const n of ["web_search", "run_shell", "browser_open"]) expect(toolVerdict(DEFAULT_POLICY, n).ok).toBe(true);
  });

  it("refuse les outils Internet et le navigateur, garde les outils locaux", () => {
    for (const n of ["web_search", "web_fetch", "http_request", "browser_open", "browser_click", "connected_browser", "skill_hub_install"]) expect(toolVerdict(off, n).ok, n).toBe(false);
    for (const n of ["read_file", "write_file", "memory_search", "rag_search", "system_info", "list_dir"]) expect(toolVerdict(off, n).ok, n).toBe(true);
  });

  it("refuse run_shell et les outils MCP sauf exception « commandes locales »", () => {
    expect(toolVerdict(off, "run_shell").ok).toBe(false);
    expect(toolVerdict(off, "github__list", "mcp").ok).toBe(false);
    const local = { ...off, localCommands: true };
    expect(toolVerdict(local, "run_shell").ok).toBe(true);
    expect(toolVerdict(local, "github__list", "mcp").ok).toBe(true);
    // L'exception ne rouvre pas Internet.
    expect(toolVerdict(local, "web_fetch").ok).toBe(false);
  });
});

describe("garde des sockets", () => {
  afterEach(() => uninstallNetworkGuard());

  it("reconnaît toutes les formes de connect", () => {
    expect(connectTarget([{ host: "example.com", port: 443 }])).toBe("example.com");
    expect(connectTarget([[{ host: "8.8.8.8", port: 53 }, null]])).toBe("8.8.8.8");
    expect(connectTarget([80, "example.org"])).toBe("example.org");
    expect(connectTarget(["8080"])).toBe("localhost");
    expect(connectTarget(["\\\\.\\pipe\\jarod"])).toBeNull();
    expect(connectTarget([{ path: "/tmp/s.sock" }])).toBeNull();
  });

  it("laisse passer la boucle locale, refuse le reste avant toute tentative", async () => {
    installNetworkGuard((h) => decideHost(off, h) !== "blocked");
    const server = net.createServer((s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1");
      let t = "";
      s.on("data", (d) => (t += d));
      s.on("end", () => resolve(t));
      s.on("error", reject);
    });
    server.close();
    expect(reply).toBe("ok");

    const failure = await fetch("http://203.0.113.9/", { signal: AbortSignal.timeout(5000) }).catch((e: Error & { cause?: { code?: string } }) => e);
    expect((failure as Error & { cause?: { code?: string } }).cause?.code).toBe(OFFLINE_CODE);
  });
});

// V-05 : le résolveur appelé directement et les envois UDP passaient (mesuré le 2026-10-23). Aucun essai ici ne sort de la machine : un
// refus n'atteint pas le réseau, et ce qui est permis vise la boucle locale.
describe("garde DNS et UDP (V-05)", () => {
  afterEach(() => uninstallNetworkGuard());
  const guardOff = () => installNetworkGuard((h) => decideHost(off, h) !== "blocked");
  const code = (p: Promise<unknown>) => p.then(() => "résolu", (e: NodeJS.ErrnoException) => e.code);

  it("Internet coupé : toute résolution directe d'un nom est refusée (rappel, promesse, Resolver, import nommé), la boucle locale passe", async () => {
    guardOff();
    const viaCallback = await new Promise<string | undefined>((res) => dns.lookup("example.com", (e) => res(e ? (e as NodeJS.ErrnoException).code : "résolu")));
    expect(viaCallback).toBe(OFFLINE_CODE);
    expect(await code(dns.promises.resolve4("example.com"))).toBe(OFFLINE_CODE);
    expect(await code(dns.promises.resolveTxt("exfil.example.com"))).toBe(OFFLINE_CODE);
    expect(await code(new dns.promises.Resolver().resolve4("example.com"))).toBe(OFFLINE_CODE);
    const resolver = new dns.Resolver();
    expect(await new Promise((res) => resolver.resolveTxt("exfil.example.com", (e) => res(e ? (e as NodeJS.ErrnoException).code : "résolu")))).toBe(OFFLINE_CODE);
    const { lookup } = await import("node:dns");
    expect(await new Promise((res) => lookup("example.com", (e) => res(e ? (e as NodeJS.ErrnoException).code : "résolu")))).toBe(OFFLINE_CODE);
    expect(await code(dns.promises.lookup("localhost"))).toBe("résolu");
  });

  it("Internet coupé : un envoi UDP hors de la machine est refusé ; vers la boucle locale il arrive", async () => {
    guardOff();
    const out = dgram.createSocket("udp4");
    try {
      expect(await new Promise((res) => out.send(Buffer.from("x"), 53, "1.1.1.1", (e) => res(e ? (e as NodeJS.ErrnoException).code : "envoyé")))).toBe(OFFLINE_CODE);
      // Sans rappel, le refus arrive par l'événement `error`, jamais en silence.
      const viaEvent = new Promise((res) => out.once("error", (e) => res((e as NodeJS.ErrnoException).code)));
      out.send("y", 53, "203.0.113.9");
      expect(await viaEvent).toBe(OFFLINE_CODE);
      const local = dgram.createSocket("udp4");
      await new Promise<void>((r) => local.bind(0, "127.0.0.1", () => r()));
      const got = new Promise((res) => local.once("message", (m) => res(String(m))));
      out.send("bonjour", local.address().port, "127.0.0.1");
      expect(await got).toBe("bonjour");
      local.close();
    } finally {
      out.close();
    }
  });

  it("un socket UDP connecté est jugé à chaque envoi : une bascule vers « coupé » l'arrête", async () => {
    let policy: NetworkPolicy = { ...DEFAULT_POLICY, internet: true };
    installNetworkGuard((h) => decideHost(policy, h) !== "blocked");
    const s = dgram.createSocket("udp4");
    try {
      await new Promise<void>((r) => s.connect(9, "203.0.113.9", () => r()));
      policy = { ...policy, internet: false };
      expect(await new Promise((res) => s.send("z", (e) => res(e ? (e as NodeJS.ErrnoException).code : "envoyé")))).toBe(OFFLINE_CODE);
    } finally {
      s.close();
    }
  });

  it("une connexion UDP vers un hôte refusé n'est pas établie", async () => {
    guardOff();
    const s = dgram.createSocket("udp4");
    const err = new Promise((res) => s.once("error", (e) => res((e as NodeJS.ErrnoException).code)));
    s.connect(53, "1.1.1.1");
    expect(await err).toBe(OFFLINE_CODE);
    s.close();
  });

  it("retirer la garde rend le résolveur et dgram d'origine", async () => {
    const before = [dns.lookup, dns.promises.resolve4, dns.Resolver.prototype.resolve4, dgram.Socket.prototype.send, dgram.Socket.prototype.connect];
    guardOff();
    expect(dns.lookup).not.toBe(before[0]);
    uninstallNetworkGuard();
    expect([dns.lookup, dns.promises.resolve4, dns.Resolver.prototype.resolve4, dgram.Socket.prototype.send, dgram.Socket.prototype.connect]).toEqual(before);
  });
});
