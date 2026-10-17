// E2 DANS L'APPLICATION (niveau passerelle) : le VRAI noyau, la VRAIE passerelle, un client WebSocket qui joue le rôle de la fenêtre (il répond aux
// demandes d'accord), un FAUX fournisseur de modèle scripté, et le VRAI moteur (browser-harness, Chrome jetable) sur un site contrôlé.
// Les scénarios : éteint ; activé sans domaine ; accord annulé/refusé ; accord ; retrait d'un domaine ; désactivation ; perte de la garde.
// Aucun profil réel n'est ouvert : les données du noyau et le navigateur vivent dans des dossiers temporaires.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { startConnectedBrowser, type ConnectedBrowserHandle } from "../src/gateway/connected-browser.js";
import { createGateway } from "../src/gateway/server.js";
import { startTestSite, startWitness, type TestSite, type Witness } from "../../plugins/integrations/test/engines/browser_site.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const PYTHON = join(ROOT, "engines", "browser-harness", "Scripts", "python.exe");
const CHROME = join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe");
const HAS = process.platform === "win32" && existsSync(PYTHON) && existsSync(CHROME);
const KEY = ["sk", "CANARI-E2-0123456789abcdef0123456"].join("-");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Chunk = Record<string, unknown>;
const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] });
const stop = (reason = "stop"): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const say = (t: string): Chunk[] => [delta({ content: t }), stop()];
const browserCall = (args: Record<string, unknown>): Chunk[] => [
  delta({ tool_calls: [{ index: 0, id: `call-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: "connected_browser", arguments: JSON.stringify(args) } }] }),
  stop("tool_calls"),
];

/** Un fournisseur scripté : chaque requête reçoit la réponse suivante ; les corps reçus sont gardés (pour voir quels outils le modèle se voit offrir). */
function fakeLlm(): Promise<{ port: number; queue: Chunk[][]; bodies: { tools?: { function: { name: string } }[] }[]; close: () => void }> {
  const queue: Chunk[][] = [];
  const bodies: { tools?: { function: { name: string } }[] }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push({});
      }
      const chunks = queue.shift() ?? say("(rien de prévu)");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ port: (server.address() as { port: number }).port, queue, bodies, close: () => server.close() })));
}

const closers: (() => void | Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Les sessions de NAVIGATEUR de ce processus (la passerelle de l'essai tourne dedans) : d'autres essais, en parallèle, ont les leurs dans le même dossier temporaire. */
const sessionDirs = () =>
  readdirSync(tmpdir()).filter((n) => {
    if (!n.startsWith("jarod-e2-")) return false;
    try {
      return (JSON.parse(readFileSync(join(tmpdir(), n, "owner.json"), "utf8")) as { ownerPid?: number }).ownerPid === process.pid;
    } catch {
      return false;
    }
  });
function chromeUsing(dir: string): number {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') -and $_.CommandLine -notmatch 'Get-CimInstance' } | Measure-Object | ForEach-Object { $_.Count }`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim() || "0");
}

describe.skipIf(!HAS)("E2 dans l'application : passerelle, noyau, moteur et navigateur jetable réels", { timeout: 180_000 }, () => {
  async function rig() {
    const llm = await fakeLlm();
    closers.push(llm.close);
    const witness: Witness = await startWitness();
    const site: TestSite = await startTestSite(witness.port);
    closers.push(() => site.close(), () => witness.close());
    const root = mkdtempSync(join(tmpdir(), "jarod-e2app-"));
    dirs.push(root);
    const pm = new ProfileManager(root);
    pm.create("travail");
    pm.setActive("travail");
    const { core } = await openCore({ env: { JAROD_HOME: root, JAROD_CUSTOM_API_KEY: KEY } });
    core.settings.patch({ activeProvider: "custom", activeModel: "jarod-test-model", providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${llm.port}/v1`, models: ["jarod-test-model"] } }, autoTitle: false, toolSearch: "off" });
    await core.skills.reload();
    const logs: string[] = [];
    const work = mkdtempSync(join(tmpdir(), "jarod-e2app-ws-"));
    dirs.push(work);
    const gw = createGateway({ core, version: "test", workspace: work });
    const port = await gw.listen(0);
    // Le branchement EXACT de la passerelle réelle (main.ts) : le même assistant, la même variable.
    const e2: ConnectedBrowserHandle | undefined = startConnectedBrowser(core, { JAROD_E2_ENGINE_ROOT: ROOT }, (l) => logs.push(l));
    closers.push(async () => {
      await e2?.stop();
      await gw.close();
      await core.dispose();
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${gw.token}`);
    closers.push(() => ws.close());
    const events: { type: string; session_id?: string; payload?: any }[] = [];
    const requests: { id: string; method: string; params: any }[] = [];
    const waiting = new Map<number, (f: any) => void>();
    let id = 0;
    ws.addEventListener("message", (m) => {
      const f = JSON.parse(String(m.data));
      if (f.method === "event") events.push(f.params);
      else if (typeof f.method === "string") requests.push({ id: f.id, method: f.method, params: f.params });
      else waiting.get(f.id)?.(f);
    });
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok());
      ws.addEventListener("error", () => bad(new Error("connexion refusée")));
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<{ result?: any; error?: any }>((ok) => {
        const n = ++id;
        waiting.set(n, ok);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      });
    const waitFor = async (pred: () => boolean, ms = 40_000) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`délai dépassé ; événements : ${events.map((e) => e.type).join(",")}`);
        await wait(25);
      }
    };
    const reply = (rid: string, result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, result }));
    const sid = (await call("session.create", { title: "E2" })).result.session_id as string;
    /** Un tour : le modèle appelle l'outil avec `args`, puis conclut. `decide` répond à la demande d'accord (absent : aucune demande attendue). */
    const turn = async (args: Record<string, unknown>, decide?: (req: { params: any }) => "once" | "deny") => {
      const doneBefore = events.filter((e) => e.type === "message.complete").length;
      const reqBefore = requests.length;
      llm.queue.push(browserCall(args), say("fait"));
      await call("prompt.submit", { session_id: sid, text: "agis" });
      if (decide) {
        await waitFor(() => requests.length > reqBefore);
        const req = requests[reqBefore]!;
        reply(req.id, { choice: decide(req) });
      }
      await waitFor(() => events.filter((e) => e.type === "message.complete").length > doneBefore);
      const asked = requests.slice(reqBefore);
      const tool = events.filter((e) => e.type === "tool.complete").at(-1)?.payload?.result_text as string | undefined;
      return { asked, tool: tool ?? "" };
    };
    const tools = () => (core.app as unknown as { tools: { registry: { get(n: string): unknown } } }).tools.registry;
    return { core, llm, site, witness, e2, logs, call, turn, tools, events, requests, sid, waitFor };
  }
  const siteUrl = (r: { site: TestSite }, path = "/") => `http://site.localhost:${r.site.port}${path}`;
  const enable = (r: { core: { settings: { set(k: string, v: unknown): void } } }, domains: string[], enabled = true) => r.core.settings.set("connectedBrowser", { enabled, allowDomains: domains, denyDomains: [] });

  it("ÉTEINT par défaut : aucun outil navigateur connecté, ni dans le registre ni dans ce que le modèle se voit offrir ; aucun navigateur, aucun profil", async () => {
    const dirsBefore = sessionDirs();
    const r = await rig();
    await r.e2!.sync();
    expect(r.tools().get("connected_browser")).toBeUndefined();
    expect(r.e2!.status()).toMatchObject({ state: "disabled" });
    r.llm.queue.push(say("bonjour"));
    await r.call("prompt.submit", { session_id: r.sid, text: "salut" });
    await r.waitFor(() => r.events.some((e) => e.type === "message.complete"));
    const offered = (r.llm.bodies[0]?.tools ?? []).map((t) => t.function.name);
    expect(offered.length).toBeGreaterThan(0); // le contrôle : le modèle reçoit bien une liste d'outils
    expect(offered).not.toContain("connected_browser");
    expect(sessionDirs()).toEqual(dirsBefore);
    expect(r.logs.join("\n")).not.toMatch(/outil branché/);
  });

  it("ACTIVÉ SANS DOMAINE : toujours aucun outil et aucune session ; avec un domaine, l'outil apparaît À CHAUD mais AUCUN navigateur ne démarre", async () => {
    const dirsBefore = sessionDirs();
    const r = await rig();
    enable(r, []);
    await r.e2!.sync();
    expect(r.tools().get("connected_browser")).toBeUndefined();
    expect(r.e2!.status().state).toBe("disabled");
    enable(r, ["site.localhost"]);
    await r.e2!.sync();
    expect(r.tools().get("connected_browser")).toBeTruthy();
    expect(r.e2!.status().state).toBe("idle");
    await wait(1500);
    expect(sessionDirs()).toEqual(dirsBefore); // pas de profil jetable
    r.llm.queue.push(say("ok"));
    await r.call("prompt.submit", { session_id: r.sid, text: "salut" });
    await r.waitFor(() => r.events.some((e) => e.type === "message.complete"));
    expect((r.llm.bodies[0]?.tools ?? []).map((t) => t.function.name)).toContain("connected_browser");
    expect(r.logs.join("\n")).toMatch(/outil branché \(aucun navigateur lancé avant le premier accord\)/);
  });

  it("REFUS d'une action : la demande montre la cible exacte ; refusée, ni lancement, ni profil, ni requête vers le site", async () => {
    const dirsBefore = sessionDirs();
    const r = await rig();
    enable(r, ["site.localhost"]);
    await r.e2!.sync();
    const hits = r.site.hits.length;
    const out = await r.turn({ op: "open_tab", url: siteUrl(r, "/second") }, () => "deny");
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]!.params).toMatchObject({ tool_name: "connected_browser" });
    expect(out.asked[0]!.params.description).toContain("site.localhost");
    expect(out.asked[0]!.params.description).toContain("/second");
    expect(out.asked[0]!.params.choices).toEqual(["once", "deny"]); // ni « toujours » ni « pour la conversation »
    expect(out.asked[0]!.params.allow_permanent).toBe(false);
    expect(out.tool).toMatch(/non accord|refus/i);
    await wait(800);
    expect(sessionDirs()).toEqual(dirsBefore);
    expect(r.site.hits.length).toBe(hits);
    expect(r.e2!.status().state).toBe("idle");
  });

  it("ACCORD : le profil jetable est lancé et l'action EXACTE présentée est exécutée ; puis retrait d'un domaine = session invalidée et fermée aussitôt", async () => {
    const r = await rig();
    enable(r, ["site.localhost", "autre.example.org"]);
    await r.e2!.sync();
    const dirsBefore = sessionDirs();
    const out = await r.turn({ op: "open_tab", url: siteUrl(r, "/second") }, () => "once");
    expect(out.tool).toMatch(/\S/);
    const created = sessionDirs().filter((d) => !dirsBefore.includes(d));
    expect(created).toHaveLength(1); // UN profil jetable, créé par cette action
    const profile = join(tmpdir(), created[0]!);
    expect(chromeUsing(profile)).toBeGreaterThan(0);
    // l'action exacte : une seule requête vers le site, sur le chemin présenté, sous le nom d'hôte présenté
    const mine = r.site.hits.filter((h) => h.host === "site.localhost" && h.path === "/second");
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(r.site.hits.filter((h) => h.path !== "/second" && h.path !== "/favicon.ico")).toEqual([]);
    expect(r.e2!.status()).toMatchObject({ state: "running" });

    // retrait d'un domaine : le jeu change, la session est révoquée sans attendre une opération
    enable(r, ["autre.example.org"]);
    await r.e2!.sync();
    for (let i = 0; i < 100 && existsSync(profile); i++) await wait(100);
    expect(existsSync(profile)).toBe(false);
    expect(chromeUsing(profile)).toBe(0);
    expect(r.e2!.status().state).toBe("idle");
    expect(r.tools().get("connected_browser")).toBeTruthy(); // il reste un domaine : l'outil reste, pas la session

    // désactivation : l'outil disparaît aussi
    enable(r, ["autre.example.org"], false);
    await r.e2!.sync();
    expect(r.tools().get("connected_browser")).toBeUndefined();
    expect(r.e2!.status().state).toBe("disabled");
  });

  it("PERTE DE LA GARDE (navigateur tué) : l'opération suivante est refusée sans demande d'accord, la session est arrêtée ; l'action approuvée d'après repart sur une session neuve", async () => {
    const r = await rig();
    enable(r, ["site.localhost"]);
    await r.e2!.sync();
    const dirsBefore = sessionDirs();
    const first = await r.turn({ op: "open_tab", url: siteUrl(r, "/") }, () => "once");
    expect(first.tool).toMatch(/\S/);
    const profile = join(tmpdir(), sessionDirs().filter((d) => !dirsBefore.includes(d))[0]!);
    const tabId = /([0-9A-F]{32})/.exec(first.tool)?.[1] ?? "";
    const marker = JSON.parse(readFileSync(join(profile, "owner.json"), "utf8")) as { chromePid: number };
    spawnSync("taskkill", ["/PID", String(marker.chromePid), "/T", "/F"], { windowsHide: true });
    for (let i = 0; i < 150 && existsSync(profile); i++) await wait(100);
    expect(existsSync(profile)).toBe(false); // la session s'est arrêtée d'elle-même
    expect(r.e2!.status()).toMatchObject({ state: expect.stringMatching(/failed|idle/) });

    const asked = (await r.turn({ op: "read_page", tab: tabId || "ONGLET" })).asked;
    expect(asked).toHaveLength(0); // plus d'onglet : refusé AVANT toute demande d'accord

    const again = await r.turn({ op: "open_tab", url: siteUrl(r, "/second") }, () => "once");
    expect(again.asked).toHaveLength(1);
    const fresh = sessionDirs().filter((d) => !dirsBefore.includes(d));
    expect(fresh).toHaveLength(1);
    expect(join(tmpdir(), fresh[0]!)).not.toBe(profile);
    expect(r.e2!.status().state).toBe("running");
  });
});
