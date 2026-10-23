// Outils système, phase 1 (lecture seule) : analyseurs purs, outils avec un PowerShell simulé, mesure de disque et chemins protégés,
// puis (Windows seulement) les vrais appels sur la machine. Barres écrites avant de mesurer : voir jarod-herald-reuse.md § 6.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry, type ToolContext, type ToolDef } from "../src/registry.js";
import { measureTree, protectedRoot, protectedRoots } from "../src/system/disk.js";
import {
  buildProcessRows, formatLogLines, parseBluetooth, parseNetwork, parseRunningApps, parseStartApps, parseSystemInfo, parseWlan, summariseCrash,
} from "../src/system/parse.js";
import { buildArgv, MAX_SCRIPT_CHARS, type PsRunner, realPsRunner } from "../src/system/ps.js";
import * as S from "../src/system/scripts.js";
import { systemReadTools } from "../src/system/tools.js";

const win = process.platform === "win32";
const ctx = { sessionId: "s", workspace: null } as ToolContext;

describe("analyseurs (données d'essai)", () => {
  it("system_info : octets, disques sans taille écartés, batterie, build", () => {
    const out = parseSystemInfo({
      caption: "Microsoft Windows 11 Pro", version: "10.0.26300", build: "26300", total_kb: 1000, free_kb: 250, uptime_seconds: 90, chip: "  Intel(R)   Core  ", logical: 8,
      disks: [{ mount: "C:\\", total_bytes: 100, free_bytes: 30 }, { mount: "E:\\", total_bytes: 0, free_bytes: 0 }], battery: { percent: 80, status: 6 },
    });
    expect(out).toEqual({
      os: "Windows 11 Pro (10.0.26300)", build: "26300", chip: "Intel(R) Core", cpu_cores: 8, memory_total_bytes: 1_024_000, memory_used_bytes: 768_000, load_average: null,
      uptime_seconds: 90, disks: [{ mount: "C:\\", total_bytes: 100, used_bytes: 70, free_bytes: 30 }], battery: { percent: 80, state: "charging" },
    });
    expect(parseSystemInfo({ disks: { mount: "D:\\", total_bytes: 10, free_bytes: 10 }, battery: null })).toMatchObject({ disks: [{ used_bytes: 0 }], battery: null });
  });

  it("processus : le CPU (somme des cœurs) est ramené à 0-100, la mémoire en pourcentage, la commande retombe sur le nom", () => {
    const rows = buildProcessRows({ total_memory: 1000, rows: [{ pid: 4, ppid: 1, name: "a", path: "", rss: 100, cpu: 400, user: "u" }, { pid: 5, ppid: 1, name: "b", path: "C:\\b.exe", rss: 0, cpu: 50 }] }, 8);
    expect(rows).toEqual([
      { pid: 4, ppid: 1, user: "u", name: "a", cpu_percent: 50, mem_percent: 10, rss_bytes: 100, command: "a" },
      { pid: 5, ppid: 1, user: "", name: "b", cpu_percent: 6.3, mem_percent: 0, rss_bytes: 0, command: "C:\\b.exe" },
    ]);
    expect(buildProcessRows({ total_memory: 0, rows: [{ pid: 1, cpu: 9000, rss: 5, name: "x" }] }, 1)[0]).toMatchObject({ cpu_percent: 100, mem_percent: 0 });
  });

  it("applications : doublons du menu Démarrer fusionnés par nom, tri sans casse ; fenêtres ouvertes", () => {
    expect(parseStartApps([{ name: "Zed", id: "z" }, { name: "alpha", id: "a1" }, { name: "Alpha", id: "a2" }, { name: "", id: "x" }]).map((a) => [a.name, a.bundle_id])).toEqual([["alpha", "a1"], ["Zed", "z"]]);
    expect(parseRunningApps({ pid: 7, process: "notepad", description: "Bloc-notes", path: "C:\\n.exe" })).toEqual([{ name: "Bloc-notes", path: "C:\\n.exe", bundle_id: null, running: true, pid: 7 }]);
  });

  const EN = `There is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Intel(R) Wi-Fi 6\n    State                  : connected\n    SSID                   : MyNet\n    BSSID                  : 11:22:33:44:55:66\n    Network type           : Infrastructure\n    Radio type             : 802.11ax\n    Authentication         : WPA2-Personal\n    Cipher                 : CCMP\n    Connection mode        : Auto Connect\n    Channel                : 36\n    Receive rate (Mbps)    : 866.7\n    Transmit rate (Mbps)   : 866.7\n    Signal                 : 91%\n`;
  const FR = `    Nom                    : Wi-Fi\n    SSID                   : Réseau\n    BSSID                  : 11:22:33:44:55:66\n    Type de réseau         : Infrastructure\n    Type de radio          : 802.11ac\n    Authentification       : WPA2-Personnel\n    Chiffrement            : CCMP\n    Mode de connexion      : Connexion automatique\n    Canal                  : 6\n    Vitesse de réception (Mbits/s) : 300\n    Vitesse de transmission (Mbits/s) : 300\n    Signal                 : 70%\n`;
  const DE = `    Name : WLAN\n    SSID : Netz\n    BSSID : 11:22:33:44:55:66\n    Netzwerktyp : Infrastruktur\n    Funktyp : 802.11n\n    Authentifizierung : WPA2\n    Verschlüsselung : CCMP\n    Verbindungsmodus : Auto\n    Kanal : 11\n    Empfangsrate : 150\n    Übertragungsrate : 150\n    Signal : 55%\n`;
  it("Wi-Fi : anglais, français, et une langue inconnue lue par position", () => {
    expect(parseWlan(EN)).toEqual({ interface: "Wi-Fi", connected: true, ssid: "MyNet", phy_mode: "802.11ax", channel: 36, rate_mbps: 866.7, signal_percent: 91, security: "WPA2-Personal" });
    expect(parseWlan(FR)).toMatchObject({ ssid: "Réseau", phy_mode: "802.11ac", channel: 6, rate_mbps: 300, signal_percent: 70, security: "WPA2-Personnel" });
    expect(parseWlan(DE)).toMatchObject({ ssid: "Netz", phy_mode: "802.11n", channel: 11, rate_mbps: 150, signal_percent: 55, security: "WPA2" });
    expect(parseWlan("Aucune interface sans fil")).toBeNull();
  });

  it("réseau : interface par défaut = celle qui a une passerelle ; APIPA écartée ; un DNS seul n'est pas une liste", () => {
    const out = parseNetwork({
      config: [
        { name: "Ethernet", description: "Intel I219", ipv4: "192.168.1.42", gateway: "192.168.1.254", dns: "1.1.1.1" },
        { name: "Wi-Fi", description: "Intel AX", ipv4: "169.254.3.3", gateway: "", dns: [] },
        { name: "vEthernet", description: "Hyper-V", ipv4: "172.24.0.1", gateway: "", dns: [] },
      ],
      adapters: [{ name: "Ethernet", mac: "10-B6" }],
      wlan: "",
    });
    expect(out).toMatchObject({ online: true, default_interface: "Ethernet", gateway: "192.168.1.254", dns: ["1.1.1.1"], wifi: null });
    expect(out.interfaces).toEqual([
      { name: "Intel I219", device: "Ethernet", mac: "10-B6", ipv4: "192.168.1.42", default_route: true },
      { name: "Hyper-V", device: "vEthernet", mac: null, ipv4: "172.24.0.1", default_route: false },
    ]);
    expect(parseNetwork({ config: [], adapters: [], wlan: "" })).toMatchObject({ online: false, default_interface: null, dns: [] });
  });

  it("Bluetooth : appairés par identifiant d'appareil, radio présente et en marche ; Windows ne dit pas lesquels sont connectés", () => {
    const out = parseBluetooth([
      { name: "Intel Wireless Bluetooth", id: "USB\\VID_8087", status: "OK", present: true },
      { name: "Casque", id: "BTHENUM\\DEV_AABB", status: "OK", present: true },
      { name: "Casque", id: "BTHLE\\DEV_CCDD", status: "OK", present: true },
      { name: "Service", id: "BTHENUM\\{0000}", status: "OK", present: true },
    ]);
    expect(out).toEqual({ powered_on: true, connected: [], paired: ["Casque"], note: expect.stringContaining("does not tell") });
    expect(parseBluetooth([])).toMatchObject({ powered_on: null, paired: [], note: null });
  });

  it("journal : lignes chronologiques, les dernières seulement ; plantage résumé avec le sens du code", () => {
    const rows = [{ time: "t3", level: 2, provider: "P", message: "c" }, { time: "t2", level: 1, provider: "Q", message: "b" }, { time: "t1", level: 3, provider: "R", message: "" }];
    expect(formatLogLines(rows, 2)).toEqual(["t2 CRITICAL Q: b", "t3 ERROR P: c"]);
    expect(summariseCrash({ record: "9", code: "c0000005", pid: "1234", app: "x.exe", message: "m" })).toMatchObject({
      report: "9", exception: { code: "0xc0000005", meaning: expect.stringContaining("access violation") }, process_id: 1234,
    });
    expect(summariseCrash({ code: "0xdeadbeef" })).toMatchObject({ exception: { code: "0xdeadbeef", meaning: null }, process_id: null });
  });
});

describe("scripts PowerShell", () => {
  it("chacun tient dans la ligne de commande, et le texte du modèle n'y entre jamais (argv ne contient que le script encodé)", () => {
    for (const [name, script] of Object.entries(S)) {
      const argv = buildArgv(script);
      expect(argv.slice(0, 5), name).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
      expect(Buffer.from(argv[5]!, "base64").toString("utf16le").length, name).toBeLessThanOrEqual(MAX_SCRIPT_CHARS);
    }
  });

  it("aucun script ne lit autre chose que $A pour ses entrées, et les accents graves sont bien rendus", () => {
    expect(S.EVENT_LOG).toContain('-split "`r?`n"');
    expect(S.NETWORK).toContain('-join "`n"');
    for (const [name, script] of Object.entries(S)) expect(script, name).not.toContain("@BT@");
  });
});

/** Un PowerShell simulé : enregistre les appels, rend ce qu'on lui donne. */
function fakePs(reply: (script: string, args: Record<string, unknown> | undefined) => unknown): PsRunner & { calls: { script: string; args: Record<string, unknown> | undefined }[] } {
  const calls: { script: string; args: Record<string, unknown> | undefined }[] = [];
  return { calls, json: async (script, args) => (calls.push({ script, args }), reply(script, args)) };
}
const tool = (tools: ToolDef[], name: string) => tools.find((t) => t.name === name)!;

describe("outils avec PowerShell simulé", () => {
  it("hors Windows la famille n'existe pas ; sous Windows elle a sept outils, sans accord par appel mais audités", () => {
    expect(systemReadTools({ platform: "linux" })).toEqual([]);
    expect(systemReadTools({ platform: "darwin" })).toEqual([]);
    const tools = systemReadTools({ platform: "win32", ps: fakePs(() => null) });
    expect(tools.map((t) => t.name)).toEqual(["system_info", "system_processes", "system_disk_usage", "system_network", "system_logs", "system_apps", "system_find_files"]);
    for (const t of tools) {
      expect(t.dangerous, t.name).toBeFalsy();
      expect(t.audited, t.name).toBe(true);
      expect(t.source).toBe("builtin");
    }
  });

  it("system_info : le JSON documenté, avec les faits locaux (machine, utilisateur, dossier personnel)", async () => {
    const ps = fakePs(() => ({ caption: "Windows 11", version: "1", build: "2", total_kb: 4, free_kb: 1, logical: 2, disks: [], battery: null }));
    const out = JSON.parse(await tool(systemReadTools({ platform: "win32", ps, home: "C:\\Users\\moi" }), "system_info").run({}, ctx));
    expect(out).toMatchObject({ os: "Windows 11 (1)", memory_total_bytes: 4096, memory_used_bytes: 3072, home: "C:\\Users\\moi" });
    expect(Object.keys(out)).toEqual(expect.arrayContaining(["hostname", "arch", "user", "cpu_cores", "disks", "battery", "uptime_seconds"]));
    expect(ps.calls[0]!.script).toBe(S.SYSTEM_INFO);
  });

  it("system_processes : le nom cherché voyage en JSON, jamais dans le script, même s'il contient du PowerShell", async () => {
    const ps = fakePs(() => ({ total_memory: 100, rows: [{ pid: 1, name: "x", rss: 1, cpu: 0 }] }));
    const t = tool(systemReadTools({ platform: "win32", ps, logicalCpus: 4 }), "system_processes");
    const evil = `'; Remove-Item C:\\ -Recurse; "$(calc)" \`n`;
    await t.run({ action: "find", name: evil, limit: 1000 }, ctx);
    expect(ps.calls[0]!.script).toBe(S.PROCESSES);
    expect(ps.calls[0]!.script).not.toContain("Remove-Item C:");
    expect(ps.calls[0]!.args).toEqual({ sort: "cpu", limit: 100, name: evil });
  });

  it("system_processes : top / find / port, bornes et erreurs nettes", async () => {
    const ps = fakePs((script) => (script === S.LISTENERS ? [] : { total_memory: 0, rows: [] }));
    const t = tool(systemReadTools({ platform: "win32", ps }), "system_processes");
    expect(JSON.parse(await t.run({ action: "top", sort: "memory" }, ctx))).toEqual({ sort: "memory", processes: [] });
    expect(ps.calls.at(-1)!.args).toEqual({ sort: "memory", limit: 15, name: "" });
    expect(JSON.parse(await t.run({ action: "port", port: 3000 }, ctx))).toEqual({ port: 3000, listeners: [], note: "Rien n'écoute sur le port 3000." });
    expect(ps.calls.at(-1)!.args).toEqual({ port: 3000 });
    await expect(t.run({ action: "find" }, ctx)).rejects.toThrow(/name est requis/);
    await expect(t.run({ action: "port" }, ctx)).rejects.toThrow(/port est requis/);
    await expect(t.run({ action: "port", port: 70000 }, ctx)).resolves.toBeDefined(); // borné à 65535
    await expect(t.run({ action: "kill" }, ctx)).rejects.toThrow(/action doit être l'un de/);
    await expect(t.run({ action: "top", limit: "beaucoup" }, ctx)).rejects.toThrow(/limit doit être un nombre/);
    expect(ps.calls.at(-1)!.args).toEqual({ port: 65535 });
  });

  it("system_logs : niveaux, plancher et plafond, rapport de plantage réservé aux numéros", async () => {
    const ps = fakePs((script) => (script === S.CRASH ? { record: "5", code: "c0000005" } : []));
    const t = tool(systemReadTools({ platform: "win32", ps }), "system_logs");
    await t.run({ minutes: 9999, level: "fault", process: "chrome", limit: 0 }, ctx);
    expect(ps.calls.at(-1)!.args).toEqual({ minutes: 240, levels: [1], process: "chrome", limit: 1 });
    await t.run({ level: "any" }, ctx);
    expect(ps.calls.at(-1)!.args).toMatchObject({ minutes: 10, levels: [], process: "", limit: 40 });
    await t.run({ action: "crash_report", report: "5" }, ctx);
    expect(ps.calls.at(-1)!.args).toEqual({ record: 5 });
    await expect(t.run({ action: "crash_report", report: "5; calc" }, ctx)).rejects.toThrow(/numéro d'enregistrement/);
    await expect(t.run({ action: "crash_report" }, ctx)).rejects.toThrow(/report est requis/);
    await expect(t.run({ level: "debug" }, ctx)).rejects.toThrow(/level doit être/);
  });

  it("system_apps : filtre sans casse, quit n'existe pas encore (phase 3)", async () => {
    const ps = fakePs((script) => (script === S.INSTALLED_APPS ? [{ name: "Notepad++", id: "n" }, { name: "Paint", id: "p" }] : []));
    const t = tool(systemReadTools({ platform: "win32", ps }), "system_apps");
    expect(JSON.parse(await t.run({ action: "installed", filter: "NOTE" }, ctx))).toMatchObject({ count: 1, apps: [{ name: "Notepad++" }] });
    await expect(t.run({ action: "quit", name: "Paint" }, ctx)).rejects.toThrow(/action doit être l'un de : installed, running/);
  });

  it("un échec PowerShell remonte tel quel, sans fabriquer de résultat", async () => {
    const ps: PsRunner = { json: async () => Promise.reject(new Error("Access denied")) };
    await expect(tool(systemReadTools({ platform: "win32", ps }), "system_network").run({}, ctx)).rejects.toThrow("Access denied");
  });

  it("dans un registre : offerts au modèle, et un `available` faux (pas de PowerShell) les masque", () => {
    const r = new ToolRegistry();
    for (const t of systemReadTools({ platform: "win32", ps: fakePs(() => null) })) r.register(t);
    expect(r.specs([]).map((t) => t.name)).toContain("system_processes");
    const none = new ToolRegistry();
    for (const t of systemReadTools({ platform: "win32", env: { SystemRoot: "Z:\\nulle-part", windir: "Z:\\nulle-part" } })) none.register(t);
    expect(none.specs([]).map((t) => t.name)).toEqual(["system_disk_usage", "system_find_files"]); // seuls les outils sans PowerShell restent offerts
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-sys-"));
  dirs.push(d);
  return d;
};

describe("system_disk_usage", () => {
  it("mesure par dossier, les plus gros d'abord, et plafonne", async () => {
    const root = temp();
    mkdirSync(join(root, "gros", "sous"), { recursive: true });
    mkdirSync(join(root, "petit"));
    writeFileSync(join(root, "gros", "a.bin"), Buffer.alloc(5000));
    writeFileSync(join(root, "gros", "sous", "b.bin"), Buffer.alloc(3000));
    writeFileSync(join(root, "petit", "c.bin"), Buffer.alloc(10));
    writeFileSync(join(root, "racine.bin"), Buffer.alloc(100));
    const t = tool(systemReadTools({ platform: "win32", ps: fakePs(() => null) }), "system_disk_usage");
    const out = JSON.parse(await t.run({ path: root, depth: 2 }, ctx));
    expect(out).toMatchObject({ path: root, total_bytes: 8110, timed_out: false });
    expect(out.entries).toEqual([{ path: join(root, "gros"), bytes: 8000 }, { path: join(root, "gros", "sous"), bytes: 3000 }, { path: join(root, "petit"), bytes: 10 }]);
    expect(JSON.parse(await t.run({ path: root, depth: 1, limit: 1 }, ctx)).entries).toEqual([{ path: join(root, "gros"), bytes: 8000 }]);
  });

  // Variantes de casse et chemins « C:\… » : règles de Windows, seule plateforme de la famille system_* (tools.ts).
  it.runIf(win)("refuse un chemin relatif, un chemin protégé (avant toute lecture) et ses variantes de casse", async () => {
    const home = temp();
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_rsa"), "secret");
    const appdata = join(home, "AppData", "Roaming");
    mkdirSync(join(appdata, "Microsoft", "Credentials"), { recursive: true });
    const env = { APPDATA: appdata, LOCALAPPDATA: join(home, "AppData", "Local"), SystemRoot: join(home, "Windows"), ProgramFiles: join(home, "PF") };
    const t = tool(systemReadTools({ platform: "win32", ps: fakePs(() => null), home, env }), "system_disk_usage");
    await expect(t.run({ path: "dossier" }, ctx)).rejects.toThrow(/non absolu/);
    await expect(t.run({ path: "~/.ssh" }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(t.run({ path: join(home, ".SSH") }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(t.run({ path: join(appdata, "Microsoft", "Credentials", "sous") }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(t.run({ path: join(home, "Windows") }, ctx)).rejects.toThrow(/emplacement protégé/);
    // Un nom voisin n'est PAS protégé (le préfixe ne suffit pas : « .sshfoo » n'est pas « .ssh »).
    expect(protectedRoot(join(home, ".sshfoo"), protectedRoots(env, home), true)).toBeNull();
    expect(protectedRoot(join(home, ".ssh", "x"), protectedRoots(env, home), true)).toBe(join(home, ".ssh"));
  });

  it.runIf(win)("une jonction n'est pas suivie dans la mesure, et ne contourne pas la liste des emplacements protégés", async () => {
    const root = temp();
    const secret = join(root, "protege");
    const outside = join(root, "dehors");
    mkdirSync(secret);
    mkdirSync(outside);
    writeFileSync(join(secret, "k"), Buffer.alloc(7000));
    writeFileSync(join(outside, "x"), Buffer.alloc(1));
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", join(outside, "lien"), secret], { stdio: "ignore" });
    // La jonction vers le dossier de 7000 octets n'est pas comptée : 1 octet seulement.
    const measured = await measureTree(outside, 1, { deadline: Date.now() + 10_000 });
    expect(measured.total).toBe(1);
    expect([...measured.sizes.keys()]).toEqual([]);
    // Passer par la jonction ne contourne pas un emplacement protégé : le chemin réel est vérifié aussi.
    const env = { APPDATA: join(root, "a"), SystemRoot: secret };
    const t = tool(systemReadTools({ platform: "win32", ps: fakePs(() => null), home: root, env }), "system_disk_usage");
    await expect(t.run({ path: join(outside, "lien") }, ctx)).rejects.toThrow(/emplacement protégé/);
  });

  it("le délai arrête la mesure et le dit", async () => {
    const root = temp();
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "f"), "x");
    const out = await measureTree(root, 1, { deadline: Date.now() - 1 });
    expect(out.timedOut).toBe(true);
  });

  it("un appel interrompu s'arrête", async () => {
    const root = temp();
    writeFileSync(join(root, "f"), "x");
    const ac = new AbortController();
    ac.abort();
    await expect(measureTree(root, 1, { deadline: Date.now() + 10_000, signal: ac.signal })).rejects.toThrow(/Interrompu/);
  });
});

describe.runIf(win)("sur cette machine (vrai PowerShell, Windows)", () => {
  const real = systemReadTools();
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const out = JSON.parse(await tool(real, name).run(args, ctx));
    return { out, ms: Date.now() - t0 };
  };

  it("system_info rend des données non vides", async () => {
    const { out } = await run("system_info");
    expect(out.os).toMatch(/Windows/);
    expect(out.cpu_cores).toBeGreaterThan(0);
    expect(out.memory_total_bytes).toBeGreaterThan(out.memory_used_bytes);
    expect(out.disks.length).toBeGreaterThan(0);
  }, 60_000);

  it("system_processes top : des processus réels, triés, avec des pourcentages de CPU bornés", async () => {
    const { out } = await run("system_processes", { action: "top", sort: "memory", limit: 100 });
    expect(out.processes.length).toBeGreaterThan(5);
    expect(out.processes.every((p: { rss_bytes: number }, i: number, a: { rss_bytes: number }[]) => i === 0 || a[i - 1]!.rss_bytes >= p.rss_bytes)).toBe(true);
    const cpu = await run("system_processes", { action: "top", sort: "cpu", limit: 20 });
    expect(cpu.out.processes.length).toBeGreaterThan(0);
    expect(cpu.out.processes.every((p: { cpu_percent: number }) => p.cpu_percent >= 0 && p.cpu_percent <= 100)).toBe(true);
  }, 60_000);

  // Mesure, pas fonction (2026-10-22) : sur une machine au repos, mesuré 1,1–1,3 s (mémoire) et 1,5–1,8 s (CPU, qui échantillonne) sur 8 passes ; le coût est
  // le démarrage de PowerShell et la fenêtre d'échantillonnage. Plus de 5 s ne s'observe que machine chargée (suites lancées en parallèle) : la MÉDIANE de trois
  // passes porte la borne, pour qu'un pic isolé ne fasse pas échouer la fonction et qu'une vraie lenteur durable, elle, la fasse échouer.
  it("system_processes top : médiane de trois passes sous 5 s (mesure de latence)", async () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const memory: number[] = [];
    const cpu: number[] = [];
    for (let i = 0; i < 3; i++) {
      memory.push((await run("system_processes", { action: "top", sort: "memory", limit: 100 })).ms);
      cpu.push((await run("system_processes", { action: "top", sort: "cpu", limit: 20 })).ms);
    }
    expect(median(memory), `passes mémoire (ms) : ${memory.join(", ")}`).toBeLessThan(5000);
    expect(median(cpu), `passes CPU (ms) : ${cpu.join(", ")}`).toBeLessThan(5000);
  }, 90_000);

  it("system_processes find et port : retrouve notre propre processus puis un port ouvert par nous", async () => {
    const found = await run("system_processes", { action: "find", name: "node", limit: 100 });
    expect(found.out.processes.some((p: { pid: number }) => p.pid === process.pid)).toBe(true);
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const port = (server.address() as { port: number }).port;
      const { out } = await run("system_processes", { action: "port", port });
      expect(out.listeners.map((l: { pid: number }) => l.pid)).toContain(process.pid);
    } finally {
      server.close();
    }
  }, 60_000);

  // 2026-10-23 : Get-NetIPConfiguration lève une exception terminante quand une interface porte plusieurs adaptateurs (runner Windows de la CI) ;
  // le repli par les cmdlets de bas niveau doit rendre la MÊME forme. Forcé ici, puisque cette machine ne déclenche pas la panne.
  it("system_network : le repli (sans Get-NetIPConfiguration) rend la même forme que le chemin normal", async () => {
    const ps = realPsRunner();
    const normal = (await ps.json(S.NETWORK, undefined, { timeoutMs: 45_000 })) as { config: Record<string, unknown>[]; adapters: unknown[] };
    const fallback = (await ps.json(S.NETWORK, { forceFallback: true }, { timeoutMs: 45_000 })) as { config: Record<string, unknown>[]; adapters: unknown[] };
    expect(Array.isArray(fallback.config)).toBe(true);
    expect(fallback.adapters.length).toBe(normal.adapters.length);
    for (const c of fallback.config) expect(Object.keys(c).sort()).toEqual(["description", "dns", "gateway", "ipv4", "name"]);
    // Les interfaces connectées avec une adresse IPv4, vues par les deux chemins.
    const named = (cfg: Record<string, unknown>[]) => cfg.filter((c) => c.ipv4).map((c) => String(c.name)).sort();
    expect(named(fallback.config)).toEqual(named(normal.config));
  }, 120_000);

  it("system_network, system_apps et system_logs répondent avec la forme documentée", async () => {
    expect(Object.keys((await run("system_network")).out)).toEqual(expect.arrayContaining(["online", "interfaces", "dns", "wifi"]));
    expect((await run("system_apps", { action: "installed" })).out.count).toBeGreaterThan(0);
    expect(Array.isArray((await run("system_logs", { minutes: 5 })).out.lines)).toBe(true);
    expect(Array.isArray((await run("system_logs", { action: "crashes", limit: 2 })).out.crashes)).toBe(true);
  }, 120_000);
});
