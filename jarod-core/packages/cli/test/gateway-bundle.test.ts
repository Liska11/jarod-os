// Jarod-OS installé : la passerelle compilée en UN fichier (`scripts/bundle-gateway.mjs`) démarre avec `node` seul, sans TypeScript ni dossier de plugins,
// depuis un dossier qui ne contient QUE la sortie de la compilation, et sert les mêmes outils que le code source.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dirs: string[] = [];
let child: ChildProcess | null = null;
afterAll(async () => {
  // Sous Windows le dossier courant d'un processus vivant ne se supprime pas : on demande l'arrêt (entrée fermée), on attend, puis seulement on nettoie.
  const running = child;
  if (running && running.exitCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        running.kill();
        done();
      }, 10_000);
      running.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      running.stdin?.end();
    });
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

describe("passerelle compilée", { timeout: 180_000 }, () => {
  const out = temp("jarod-bundle-out-");
  const home = temp("jarod-bundle-home-");
  const workspace = temp("jarod-bundle-ws-");
  const token = "jeton-de-test";
  let base = "";

  beforeAll(async () => {
    execFileSync(process.execPath, [join(root, "scripts", "bundle-gateway.mjs"), "--out", out], { cwd: root, stdio: "pipe" });
    // Un dossier de travail NEUF et sans variable du dépôt : seul le contenu de `out` est disponible.
    child = spawn(process.execPath, [join(out, "gateway.mjs"), "--init", "--exit-on-stdin-close", "--workspace", workspace], {
      cwd: out,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", JAROD_HOME: home, JAROD_GATEWAY_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const port = await new Promise<number>((resolvePort, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`pas prête : ${stderr}`)), 90_000);
      child!.stdout?.on("data", (c: Buffer) => {
        buffer += c.toString("utf8");
        const m = /HERMES_BACKEND_READY port=(\d+)/.exec(buffer);
        if (m) {
          clearTimeout(timer);
          resolvePort(Number(m[1]));
        }
      });
      child!.once("exit", (code) => reject(new Error(`arrêtée (code ${String(code)}) : ${stderr}`)));
    });
    base = `http://127.0.0.1:${port}`;
  });

  const get = async (path: string, withToken = true) => {
    const r = await fetch(base + path, { headers: withToken ? { "x-hermes-session-token": token } : {} });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  };

  it("la sortie ne contient que ce qu'il faut : un fichier, deux fichiers de travail, le module SQLite de cette plateforme", () => {
    const names = readdirSync(out).sort();
    expect(names).toEqual(["BUNDLE.json", "gateway.mjs", "node_modules", "runner.cjs", "wakeword-worker.cjs"]);
    const manifest = JSON.parse(readFileSync(join(out, "BUNDLE.json"), "utf8")) as { plugins: string[]; native: string[] };
    expect(manifest.plugins).toContain("storage");
    expect(manifest.plugins).toContain("agent");
    expect(manifest.native).toEqual([join("node_modules", "better-sqlite3-multiple-ciphers", "prebuilds", `${process.platform}-${process.arch}.node`)]);
    // Aucun TypeScript, aucun module « workspace » : le fichier ne dépend pas du dépôt.
    expect(existsSync(join(out, "node_modules", "@jarod"))).toBe(false);
    expect(readFileSync(join(out, "gateway.mjs"), "utf8")).not.toContain(root.split("\\").join("/") + "/packages/plugins/storage/src");
  });

  it("répond comme un `hermes serve` : état, jeton exigé, outils de tous les plugins", async () => {
    expect((await get("/api/status")).body).toMatchObject({ status: "ok", backend: "jarod" });
    expect((await get("/api/tools/toolsets", false)).status).toBe(401);
    const toolsets = (await get("/api/tools/toolsets")).body as { name: string; tools?: string[] }[];
    const names = toolsets.map((t) => t.name);
    for (const expected of ["memory", "files", "terminal", "web", "agents", "automation", "skills"]) expect(names).toContain(expected);
    const tools = toolsets.flatMap((t) => t.tools ?? []);
    expect(tools.length).toBeGreaterThan(40);
    if (process.platform === "win32") expect(tools).toContain("system_disk_usage");
  });

  it("ouvre sa base chiffrée (module natif copié) et garde le profil dans JAROD_HOME", async () => {
    mkdirSync(home, { recursive: true });
    const memory = await get("/api/memory");
    expect(memory.status).toBe(200);
    expect(existsSync(join(home, "profiles", "default"))).toBe(true);
  });
});
