// G7 — BANC (évaluation, pas une intégration) : Windows-MCP réel (engines/windows-mcp, 0.8.7, venv Python 3.14, empreintes) parlé en MCP
// stdio. AUCUNE action de bureau n'est jouée : `Snapshot` lit toutes les fenêtres de l'utilisateur et `Type`/`Click` visent des coordonnées
// de l'écran réel — sans bureau isolé (Cua, G17), on ne les lance pas. On mesure le catalogue exposé et l'interrupteur de télémétrie, la
// télémétrie étant envoyée à un TÉMOIN local (POSTHOG_HOST), jamais à PostHog ; profil redirigé dans un dossier jetable.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

const EXE = join(ROOT, "engines", "windows-mcp", "Scripts", "windows-mcp.exe");
const has = existsSync(EXE);
if (!has) console.warn(`[moteurs] ${EXE} absent : le banc Windows-MCP est ignoré (voir engines.lock/README.md)`);

let witness: Server;
let witnessUrl = "";
let hits = 0;
beforeAll(async () => {
  witness = createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":1}');
  });
  // Témoin aussi en PROXY : une connexion sortante HTTPS (CONNECT) qui respecte HTTP(S)_PROXY est comptée puis coupée.
  witness.on("connect", (_req, socket) => {
    hits++;
    socket.destroy();
  });
  await new Promise<void>((r) => witness.listen(0, "127.0.0.1", () => r()));
  witnessUrl = `http://127.0.0.1:${(witness.address() as { port: number }).port}`;
});
afterAll(() => new Promise((r) => witness.close(r)));

interface Rpc {
  call(method: string, params?: unknown): Promise<{ result?: unknown; error?: { message: string } }>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
  home: string;
}

function start(telemetry: boolean, args: string[] = []): Rpc {
  const home = mkdtempSync(join(tmpdir(), "jarod-wmcp-"));
  const env: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, { USERPROFILE: home, HOME: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"), POSTHOG_HOST: witnessUrl, HTTP_PROXY: witnessUrl, HTTPS_PROXY: witnessUrl, ANONYMIZED_TELEMETRY: telemetry ? "true" : "false", PYTHONIOENCODING: "utf-8" });
  const child: ChildProcess = spawn(EXE, ["serve", ...args], { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  let id = 0;
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line) as { id?: number };
        if (typeof m.id === "number") waiting.get(m.id)?.(m as never);
      } catch {
        // ligne de journal
      }
    }
  });
  const send = (o: unknown) => child.stdin!.write(`${JSON.stringify(o)}\n`);
  return {
    home,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        const t = setTimeout(() => reject(new Error(`${method} : pas de réponse`)), 60_000);
        waiting.set(n, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        send({ jsonrpc: "2.0", id: n, method, ...(params ? { params } : {}) });
      }),
    notify: (method, params) => send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    close: async () => {
      // Fin propre (stdin fermé) : le serveur sort de sa boucle et vide sa télémétrie ; puis l'arbre est arrêté, lui seul.
      child.stdin!.end();
      await new Promise<void>((r) => {
        const t = setTimeout(() => r(), 15_000);
        child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
      if (child.exitCode === null && child.pid) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

async function session(telemetry: boolean, args: string[] = []) {
  const rpc = start(telemetry, args);
  const init = await rpc.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jarod-banc", version: "1" } });
  expect(init.error).toBeUndefined();
  rpc.notify("notifications/initialized");
  return rpc;
}

describe.skipIf(!has)("G7 — banc Windows-MCP (catalogue et télémétrie, sans action de bureau)", () => {
  it("catalogue : bien plus large que le pilotage d'une fenêtre (shell, registre, fichiers, processus, presse-papiers, lecture web)", async () => {
    const rpc = await session(false);
    try {
      const { result } = await rpc.call("tools/list");
      const tools = (result as { tools: { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }[] }).tools;
      const names = tools.map((t) => t.name).sort();
      const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
      console.info(`[G7] ${names.length} outils : ${names.join(", ")} ; destructeurs déclarés : ${destructive.join(", ")}`);
      for (const risky of ["PowerShell", "Registry", "FileSystem", "Process", "Clipboard", "Scrape"]) expect(names, risky).toContain(risky);
      expect(names).toEqual(expect.arrayContaining(["Snapshot", "Click", "Type"]));
    } finally {
      await rpc.close();
    }
  }, 120_000);

  // Mesuré sur 0.8.7 : le client PostHog est CRÉÉ par défaut (identifiant persistant écrit, capture automatique des exceptions), mais le
  // suivi des appels d'outils est inopérant — `with_analytics(get_analytics(), …)` est évalué à l'enregistrement, avant que le client
  // n'existe (défaut amont). Une correction amont l'activerait : la consigne reste ANONYMIZED_TELEMETRY=false, que l'on vérifie ici.
  it("télémétrie : client PostHog créé par défaut (identifiant persistant) ; ANONYMIZED_TELEMETRY=false le supprime ; rien n'atteint le témoin", async () => {
    hits = 0;
    const on = await session(true);
    const r = await on.call("tools/call", { name: "Wait", arguments: { duration: 0 } });
    const onHome = on.home;
    const idWhenOn = JSON.stringify(readdirSync(onHome, { recursive: true })).includes("windows-mcp-user-id");
    // Le client PostHog envoie par lots en arrière-plan : une session réelle reste ouverte bien plus de 3 s.
    await new Promise((res) => setTimeout(res, 3000));
    const t0 = Date.now();
    await on.close();
    const sentWhenOn = hits;
    console.info(`[G7] activée : réponse ${JSON.stringify(r).slice(0, 120)} ; identifiant écrit ${idWhenOn} ; fermeture en ${Date.now() - t0} ms`);

    hits = 0;
    const off = await session(false);
    await off.call("tools/call", { name: "Wait", arguments: { duration: 0 } });
    await new Promise((res) => setTimeout(res, 3000));
    const home = off.home;
    const wroteId = () => existsSync(home) && JSON.stringify(readdirSync(home, { recursive: true })).includes("windows-mcp-user-id");
    const idWhenOff = wroteId();
    await off.close();
    console.info(`[G7] requêtes de télémétrie reçues par le témoin : activée ${sentWhenOn}, coupée ${hits} ; identifiant persistant écrit (coupée) : ${idWhenOff}`);
    expect(idWhenOn).toBe(true);
    expect(idWhenOff).toBe(false);
    // Appel d'outil réussi : aucun événement, même activée (défaut amont ci-dessus) ; coupée : aucun, par construction.
    expect(sentWhenOn).toBe(0);
    expect(hits).toBe(0);
  }, 180_000);
});

// Réexamen (2026-10-21, recadrage de l'utilisateur) : Windows-MCP comme fournisseur OPTIONNEL, outils CHOISIS (`--tools`), télémétrie coupée. Le
// profil retenu ne garde que ce que Jarod n'a pas déjà : géométrie des écrans, attente d'une condition d'interface, glisser-déposer, sélection
// multiple, et (perception, à part) capture et arbre d'interface de l'écran. Toujours AUCUNE action de bureau jouée ici : seuls `Wait` et
// `DisplayInventory` (lecture de la disposition des écrans) sont appelés.
export const WINDOWS_MCP_CHOSEN = ["DisplayInventory", "WaitFor", "Wait", "Move", "MultiSelect", "Screenshot", "Snapshot"];

describe.skipIf(!has)("G7 — réexamen : Windows-MCP en fournisseur optionnel (outils choisis, télémétrie coupée)", () => {
  it("--tools ne garde que les outils choisis ; un outil écarté (PowerShell) est inconnu du serveur", async () => {
    const rpc = await session(false, ["--tools", WINDOWS_MCP_CHOSEN.join(",")]);
    try {
      const { result } = await rpc.call("tools/list");
      const names = (result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
      expect(names).toEqual([...WINDOWS_MCP_CHOSEN].sort());
      // Si le filtre ne tenait pas, la commande serait inoffensive (la date) ; on vérifie qu'elle est refusée.
      const r = await rpc.call("tools/call", { name: "PowerShell", arguments: { command: "Get-Date" } });
      const refused = r.error !== undefined || (r.result as { isError?: boolean } | undefined)?.isError === true;
      console.info(`[G7] appel de PowerShell écarté : ${JSON.stringify(r).slice(0, 160)}`);
      expect(refused).toBe(true);
    } finally {
      await rpc.close();
    }
  }, 120_000);

  it("télémétrie coupée : aucune requête sortante (PostHog ni proxy), aucun identifiant ; DisplayInventory répond (lecture seule)", async () => {
    hits = 0;
    const rpc = await session(false, ["--tools", WINDOWS_MCP_CHOSEN.join(",")]);
    const home = rpc.home;
    let written: string[] = [];
    try {
      const inv = await rpc.call("tools/call", { name: "DisplayInventory", arguments: {} });
      expect(JSON.stringify(inv.result)).toMatch(/display|écran|monitor/i);
      await rpc.call("tools/call", { name: "Wait", arguments: { duration: 0 } });
      await new Promise((res) => setTimeout(res, 3000));
      written = readdirSync(home, { recursive: true }).map(String);
    } finally {
      await rpc.close();
    }
    console.info(`[G7] profil choisi, télémétrie coupée : requêtes sortantes ${hits} ; fichiers écrits dans le profil jetable : ${written.join(", ") || "aucun"}`);
    expect(hits).toBe(0);
    expect(written.some((f) => f.includes("windows-mcp-user-id"))).toBe(false);
  }, 120_000);
});
