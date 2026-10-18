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
