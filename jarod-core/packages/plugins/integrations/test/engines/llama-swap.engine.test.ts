// G6 — BANC DE MESURE (évaluation, pas une intégration) : llama-swap réel (engines/llama-swap, v262, sha256 = checksums de la release)
// devant deux « modèles » FACTICES (fake_model_server.mjs). On mesure ce qui décide de l'intégrer ou non face à `local_model_server` et au
// hotswap existant : bascule à la demande, déchargement après inactivité, bascule PENDANT une réponse en cours, processus orphelins.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES, ROOT } from "./helpers.js";

const BIN = join(ROOT, "engines", "llama-swap", "llama-swap.exe");
const has = existsSync(BIN);
if (!has) console.warn(`[moteurs] ${BIN} absent : le banc llama-swap est ignoré`);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const dir = mkdtempSync(join(tmpdir(), "jarod-llama-swap-"));
let swap: ChildProcess;
let base = "";
const fake = join(FIXTURES, "fake_model_server.mjs").replaceAll("\\", "/");
const node = process.execPath.replaceAll("\\", "/");

/** Les pid des serveurs factices vus dans les réponses (chaque serveur renvoie le sien) ; vivants = ceux qui répondent au signal 0. */
const seenPids = new Set<number>();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fakesAlive = (): number => [...seenPids].filter(alive).length;

beforeAll(async () => {
  if (!has) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const tag = dir.split("\\").pop();
  // Modèle « lent » : 1,5 s par réponse, pour une bascule pendant une réponse en cours. TTL 3 s pour « rapide ».
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "healthCheckTimeout: 30",
      "models:",
      "  rapide:",
      // Chemin de node entre guillemets : « C:/Program Files/… » contient une espace (llama-swap découpe la commande).
      `    cmd: '"${node}" ${fake} \${PORT} rapide 300 50 ${tag}'`,
      "    ttl: 3",
      "  lent:",
      `    cmd: '"${node}" ${fake} \${PORT} lent 300 1500 ${tag}'`,
      "",
    ].join("\n"),
  );
  swap = spawn(BIN, ["-config", join(dir, "config.yaml"), "-listen", `127.0.0.1:${port}`], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/v1/models`)).ok) break;
    } catch {
      // pas encore prêt
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}, 30_000);

afterAll(async () => {
  if (swap?.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(swap.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // déjà arrêté
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const ask = async (model: string) => {
  const t0 = Date.now();
  const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }] }) });
  const body = (await r.json().catch(() => ({}))) as { model?: string; pid?: number };
  if (body.pid) seenPids.add(body.pid);
  return { status: r.status, body, ms: Date.now() - t0 };
};

describe.skipIf(!has)("G6 — banc llama-swap (mesures)", () => {
  it("bascule à la demande : le modèle nommé dans la requête est démarré, l'autre arrêté", async () => {
    const a = await ask("rapide");
    const b = await ask("lent");
    const a2 = await ask("rapide");
    console.info(`[G6] 1er appel (chargement) ${a.ms} ms ; bascule vers lent ${b.ms} ms ; retour vers rapide ${a2.ms} ms`);
    expect([a.body.model, b.body.model, a2.body.model]).toEqual(["rapide", "lent", "rapide"]);
    expect(a2.body.pid).not.toBe(a.body.pid); // rechargé : un seul modèle à la fois (groupe par défaut)
    expect(fakesAlive()).toBe(1);
  }, 60_000);

  it("bascule PENDANT une réponse en cours : mesurée (la réponse lente aboutit-elle ?)", async () => {
    await ask("lent");
    const slow = ask("lent");
    await new Promise((r) => setTimeout(r, 300));
    const fast = await ask("rapide");
    const s = await slow;
    console.info(`[G6] réponse lente pendant une bascule : statut ${s.status}, modèle ${s.body.model ?? "—"} ; rapide servi en ${fast.ms} ms`);
    expect(fast.body.model).toBe("rapide");
    // Mesure consignée, pas une exigence : voir docs/INTEGRATIONS-PLUS3.md (G6).
    expect([200, 502, 503]).toContain(s.status);
  }, 60_000);

  it("déchargement après inactivité (ttl 3 s)", async () => {
    await ask("rapide");
    expect(fakesAlive()).toBe(1);
    await new Promise((r) => setTimeout(r, 6000));
    console.info(`[G6] après 6 s d'inactivité : ${fakesAlive()} serveur(s) factice(s) en vie`);
    expect(fakesAlive()).toBe(0);
  }, 30_000);

  it("arrêt de llama-swap : aucun processus orphelin", async () => {
    await ask("rapide");
    execFileSync("taskkill", ["/PID", String(swap.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(fakesAlive()).toBe(0);
  }, 30_000);
});

// Réexamen (2026-10-21, recadrage de l'utilisateur) : llama-swap configuré comme Jarod le ferait — écoute 127.0.0.1 EXPLICITE, clé d'API
// (`apiKeys`) —, mesuré sur ce qui restait en suspens : adresses réellement écoutées, ce que la clé protège (pages d'administration comprises),
// CORS face à une page web étrangère, `nvidia-smi` lancé par llama-swap lui-même, et deux modèles en mémoire à la fois (groupe sans bascule),
// ce que le hotswap de Jarod ne fait pas (un seul modèle de discussion à la fois).
describe.skipIf(!has)("G6 — réexamen : llama-swap en écoute locale, avec clé", () => {
  const KEY = "banc-cle-locale-0042";
  const dir2 = mkdtempSync(join(tmpdir(), "jarod-llama-swap-cle-"));
  let swap2: ChildProcess;
  let base2 = "";
  const children = new Set<string>();
  let watcher: ReturnType<typeof setInterval> | undefined;
  /** Les programmes lancés DIRECTEMENT par llama-swap (CIM, parent = son pid). */
  const childNames = () => {
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${swap2.pid}" | ForEach-Object Name`], { encoding: "utf8" });
      for (const n of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) children.add(n.toLowerCase());
    } catch {
      // llama-swap arrêté
    }
  };

  beforeAll(async () => {
    const port = await freePort();
    base2 = `http://127.0.0.1:${port}`;
    const tag = dir2.split("\\").pop();
    writeFileSync(
      join(dir2, "config.yaml"),
      [
        "healthCheckTimeout: 30",
        `apiKeys: ["${KEY}"]`,
        "models:",
        "  rapide:",
        `    cmd: '"${node}" ${fake} \${PORT} rapide 300 50 ${tag}'`,
        "  lent:",
        `    cmd: '"${node}" ${fake} \${PORT} lent 300 50 ${tag}'`,
        "groups:",
        "  duo:",
        "    swap: false",
        "    exclusive: true",
        "    members: [rapide, lent]",
        "",
      ].join("\n"),
    );
    swap2 = spawn(BIN, ["-config", join(dir2, "config.yaml"), "-listen", `127.0.0.1:${port}`], { windowsHide: true, stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base2}/health`)).status < 500) break;
      } catch {
        // pas encore prêt
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    watcher = setInterval(childNames, 1500);
  }, 30_000);

  afterAll(async () => {
    clearInterval(watcher);
    if (swap2?.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(swap2.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // déjà arrêté
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dir2, { recursive: true, force: true, maxRetries: 3 });
  });

  const req = (path: string, init: RequestInit & { key?: boolean; origin?: string } = {}) =>
    fetch(`${base2}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.key ? { authorization: `Bearer ${KEY}` } : {}), ...(init.origin ? { origin: init.origin } : {}) },
    });
  const chat = (model: string, key = true) => req("/v1/chat/completions", { method: "POST", key, body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }] }) });

  it("écoute : seulement 127.0.0.1 (llama-swap et ses modèles)", async () => {
    expect((await chat("rapide")).status).toBe(200);
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `$p=@(${swap2.pid}) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${swap2.pid}" | ForEach-Object ProcessId); Get-NetTCPConnection -State Listen -OwningProcess $p -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }`],
      { encoding: "utf8" },
    );
    const addrs = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    console.info(`[G6] adresses en écoute (llama-swap + modèles) : ${addrs.join(", ")}`);
    expect(addrs.length).toBeGreaterThanOrEqual(2);
    expect(addrs.every((a) => a.startsWith("127.0.0.1:"))).toBe(true);
  }, 60_000);

  it("clé d'API : ce qu'elle protège, ce qu'elle ne protège pas (mesuré)", async () => {
    const paths = ["/v1/models", "/running", "/unload", "/logs", "/ui/", "/upstream/rapide/health"];
    const without: Record<string, number> = {};
    for (const p of paths) without[p] = (await req(p)).status;
    const chatNoKey = (await chat("rapide", false)).status;
    console.info(`[G6] sans clé : chat ${chatNoKey} ; ${Object.entries(without).map(([p, s]) => `${p} ${s}`).join(" ; ")}`);
    expect(chatNoKey).toBe(401);
    expect((await chat("rapide")).status).toBe(200);
  }, 60_000);

  it("CORS : ce qu'une page web étrangère obtient (mesuré)", async () => {
    const pre = await req("/v1/chat/completions", { method: "OPTIONS", origin: "https://page-etrangere.example", headers: { "access-control-request-method": "POST" } as never });
    const get = await req("/v1/models", { key: true, origin: "https://page-etrangere.example" });
    const acao = [pre.headers.get("access-control-allow-origin"), get.headers.get("access-control-allow-origin")];
    console.info(`[G6] CORS pour une origine étrangère : prévol ${pre.status} ACAO=${acao[0]} ; GET ACAO=${acao[1]}`);
    // Mesuré (v262) : CORS ouvert à toute origine. Ce qui protège, c'est la clé : une page étrangère qui ne l'a pas est refusée.
    expect(acao).toEqual(["*", "*"]);
    const foreign = await req("/v1/chat/completions", { method: "POST", origin: "https://page-etrangere.example", body: JSON.stringify({ model: "rapide", messages: [{ role: "user", content: "x" }] }) });
    expect(foreign.status).toBe(401);
  }, 30_000);

  it("groupe sans bascule : deux modèles en mémoire à la fois, servis tous les deux", async () => {
    const a = (await (await chat("rapide")).json()) as { pid: number };
    const b = (await (await chat("lent")).json()) as { pid: number };
    const a2 = (await (await chat("rapide")).json()) as { pid: number };
    console.info(`[G6] groupe duo : rapide pid ${a.pid}, lent pid ${b.pid}, rapide de nouveau pid ${a2.pid}`);
    expect(a2.pid).toBe(a.pid); // pas rechargé : les deux restent en mémoire
    expect(alive(a.pid) && alive(b.pid)).toBe(true);
  }, 60_000);

  it("programmes lancés par llama-swap lui-même : relevés (nvidia-smi ?)", async () => {
    childNames();
    const names = [...children].sort();
    console.info(`[G6] programmes lancés directement par llama-swap pendant le banc : ${names.join(", ") || "aucun"}`);
    // Mesuré (v262, machine NVIDIA) : llama-swap lance nvidia-smi de lui-même (relevé de la mémoire GPU), en plus des modèles.
    expect(names.every((n) => n === "node.exe" || n === "nvidia-smi.exe" || n === "conhost.exe")).toBe(true);
  }, 30_000);
});
