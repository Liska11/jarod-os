// SPECS-P5-CLI.md §3-§4 (b) : `jarod health` — lecture seule, sans verrou, code 0 si tout va bien, 1 sinon. Profils réels sur disque (stockage chiffré).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarodApp, start, stop } from "@jarod/kernel";
import { acquireRuntimeLock, writeSupervisorState } from "@jarod/plugin-agent";
import { ProfileManager } from "@jarod/plugin-persona";
import { defaultKeyStores } from "@jarod/plugin-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectHealth, healthExitCode, renderHealth, schemaCheck } from "../src/health.js";
import { main } from "../src/main.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-health-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cipher = { encrypt: (s: string) => `ss:${s}`, decrypt: (s: string) => s.slice(3) };
const storageApp = (dir: string) => new JarodApp({ plugins: { storage: { dataDir: dir, cipher } } } as never);

/** Profil réel sur disque : base chiffrée, créée puis fermée par le noyau. */
async function makeProfile(opts: { ecosystem?: Record<string, unknown> } = {}): Promise<{ root: string; dir: string; profile: string }> {
  const root = temp();
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const dir = pm.dirFor("travail");
  const app = storageApp(dir);
  const started = await start(app);
  if (opts.ecosystem) (app as unknown as { storage: { settings: { set(k: string, v: unknown): void } } }).storage.settings.set("ecosystem", opts.ecosystem);
  await stop(started);
  return { root, dir, profile: "travail" };
}

const byId = (r: ReturnType<typeof collectHealth>, id: string) => r.checks.find((c) => c.id === id)!;

/**
 * Empreinte de TOUT le dossier (noms, tailles, contenus) : « sans rien écrire » se prouve par l'égalité avant/après.
 * Seule exception, constatée à la mesure : SQLite exige qu'un lecteur d'une base WAL dispose de `-shm` et `-wal` ; une connexion en lecture seule
 * les crée VIDES (0 octet pour le journal) si elles n'existent pas. Ils ne contiennent aucune donnée : le test exige qu'ils soient vides.
 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (name.endsWith(".db-shm")) continue;
      if (name.endsWith(".db-wal")) {
        expect(statSync(p).size, `${name} doit rester vide`).toBe(0);
        continue;
      }
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = `${statSync(p).size}:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`;
    }
  };
  walk(dir);
  return out;
}

describe("jarod health", () => {
  it("profil sain : tout est ok, code 0, aucun secret dans le rapport", { timeout: 60_000 }, async () => {
    const { root, dir, profile } = await makeProfile();
    const r = collectHealth({ dataRoot: root, profile });
    expect(r.checks.filter((c) => c.status !== "ok"), JSON.stringify(r.checks)).toEqual([]);
    expect(r.status).toBe("ok");
    expect(healthExitCode(r)).toBe(0);
    for (const id of ["data", "profile", "database", "schema", "lock", "instance", "embeddings", "reranker", "node"])
      expect(byId(r, id), id).toBeDefined();
    const key = defaultKeyStores().map((s) => s.load(dir)).find(Boolean);
    expect(key, "la clé de la base doit exister pour que le test ait un sens").toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(key as string);
    expect(renderHealth(r)).not.toContain(key as string);
  });

  it("n'écrit RIEN : aucun fichier créé, modifié ou supprimé dans le dossier de données", { timeout: 60_000 }, async () => {
    const { root, profile } = await makeProfile();
    const before = snapshot(root);
    collectHealth({ dataRoot: root, profile });
    expect(snapshot(root)).toEqual(before);
  });

  it("l'application ouverte (base en service, verrou tenu) : health s'exécute et le dit", { timeout: 60_000 }, async () => {
    const { root, dir, profile } = await makeProfile();
    const app = storageApp(dir);
    const started = await start(app);
    const release = acquireRuntimeLock(dir, "desktop");
    try {
      const r = collectHealth({ dataRoot: root, profile });
      expect(byId(r, "database").status).toBe("ok");
      expect(byId(r, "lock").status).toBe("ok");
      expect(byId(r, "lock").detail).toContain(String(process.pid));
      expect(byId(r, "lock").detail).toMatch(/application de bureau/);
    } finally {
      release();
      await stop(started);
    }
  });

  it("base abîmée → échec, code 1", { timeout: 60_000 }, async () => {
    const { root, dir, profile } = await makeProfile();
    const db = join(dir, "jarod.db");
    const bytes = readFileSync(db);
    for (let i = 4096; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    writeFileSync(db, bytes);
    const r = collectHealth({ dataRoot: root, profile });
    expect(byId(r, "database").status).toBe("échec");
    expect(r.status).toBe("échec");
    expect(healthExitCode(r)).toBe(1);
  });

  it("base chiffrée dont la clé a disparu → échec nommé, aucune clé n'est créée", { timeout: 60_000 }, async () => {
    const { root, dir, profile } = await makeProfile();
    for (const f of readdirSync(dir)) if (f.startsWith("db.key")) rmSync(join(dir, f));
    const before = readdirSync(dir).sort();
    const r = collectHealth({ dataRoot: root, profile });
    expect(byId(r, "database").status).toBe("échec");
    expect(byId(r, "database").detail).toMatch(/clé/);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("base absente (profil jamais ouvert) → dégradé, pas d'échec", () => {
    const root = temp();
    const pm = new ProfileManager(root);
    pm.create("neuf");
    pm.setActive("neuf");
    const r = collectHealth({ dataRoot: root, profile: "neuf" });
    expect(byId(r, "database").status).toBe("dégradé");
    expect(r.checks.some((c) => c.status === "échec"), JSON.stringify(r.checks)).toBe(false);
    expect(healthExitCode(r)).toBe(1);
  });

  it("dossier de données absent ou profil inconnu → échec", () => {
    const missing = collectHealth({ dataRoot: join(temp(), "rien-ici") });
    expect(byId(missing, "data").status).toBe("échec");
    expect(healthExitCode(missing)).toBe(1);
    const root = temp();
    new ProfileManager(root).create("a");
    const unknown = collectHealth({ dataRoot: root, profile: "inconnu" });
    expect(byId(unknown, "profile").status).toBe("échec");
  });

  it("version du schéma : en retard → dégradé (migration au prochain démarrage), en avance → échec", () => {
    expect(schemaCheck(20, 20).status).toBe("ok");
    expect(schemaCheck(19, 20).status).toBe("dégradé");
    expect(schemaCheck(19, 20).detail).toMatch(/prochain démarrage/);
    expect(schemaCheck(21, 20).status).toBe("échec");
    expect(schemaCheck(21, 20).detail).toMatch(/plus récente/);
  });

  it("verrou et instance : périmés → dégradé, vivants → ok", { timeout: 60_000 }, async () => {
    const { root, dir, profile } = await makeProfile();
    writeFileSync(join(dir, "runtime.lock"), JSON.stringify({ pid: 2147483646, mode: "serve", startedAt: 1 }));
    writeSupervisorState(root, { pid: 2147483646, mode: "serve", startedAt: 1, version: "x", profile, dataDir: dir, stopRequestedAt: null });
    const stale = collectHealth({ dataRoot: root, profile });
    expect(byId(stale, "lock").status).toBe("dégradé");
    expect(byId(stale, "instance").status).toBe("dégradé");
    writeSupervisorState(root, { pid: process.pid, mode: "serve", startedAt: Date.now(), version: "x", profile, dataDir: dir, stopRequestedAt: null });
    const live = collectHealth({ dataRoot: root, profile });
    expect(byId(live, "instance").status).toBe("ok");
    expect(byId(live, "instance").detail).toContain(String(process.pid));
  });

  it("embeddings.json et reranker.json sont facultatifs ; présents, ils sont contrôlés (modèle, mode)", { timeout: 60_000 }, async () => {
    const { root, dir, profile } = await makeProfile({ ecosystem: { reranker: "bge-reranker-v2-m3-npu", rerankMode: "shadow" } });
    const absent = collectHealth({ dataRoot: root, profile });
    expect(byId(absent, "embeddings").status).toBe("ok");
    expect(byId(absent, "reranker").status).toBe("ok");

    const model = join(dir, "modele");
    mkdirSync(model);
    writeFileSync(join(dir, "reranker.json"), JSON.stringify({ modelDir: model, port: 8930 }));
    writeFileSync(join(dir, "embeddings.json"), JSON.stringify({ modelDir: model, port: 8920 }));
    const ok = collectHealth({ dataRoot: root, profile });
    expect(byId(ok, "reranker").status).toBe("ok");
    expect(byId(ok, "reranker").detail).toContain("shadow");
    expect(byId(ok, "embeddings").status).toBe("ok");

    writeFileSync(join(dir, "reranker.json"), JSON.stringify({ modelDir: join(dir, "absent"), port: 8930 }));
    writeFileSync(join(dir, "embeddings.json"), "{ pas du json");
    const bad = collectHealth({ dataRoot: root, profile });
    expect(byId(bad, "reranker").status).toBe("dégradé");
    expect(byId(bad, "embeddings").status).toBe("dégradé");
    expect(healthExitCode(bad)).toBe(1);
  });
});

describe("jarod health (ligne de commande)", () => {
  let out: string[] = [];
  let saved: string | undefined;
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    saved = process.env.JAROD_HOME;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.JAROD_HOME;
    else process.env.JAROD_HOME = saved;
  });

  it("--json : un objet structuré, code 0 sur un profil sain ; sans --json : une ligne par contrôle", { timeout: 60_000 }, async () => {
    const { root } = await makeProfile();
    process.env.JAROD_HOME = root;
    expect(await main(["health", "--json"])).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { status: string; checks: { id: string }[] };
    expect(parsed.status).toBe("ok");
    expect(parsed.checks.map((c) => c.id)).toContain("database");
    out = [];
    expect(await main(["health"])).toBe(0);
    expect(out.join("\n")).toMatch(/database/);
  });

  it("code 1 quand l'installation est dégradée", { timeout: 60_000 }, async () => {
    const { root, dir } = await makeProfile();
    process.env.JAROD_HOME = root;
    writeFileSync(join(dir, "reranker.json"), "{ cassé");
    expect(await main(["health"])).toBe(1);
  });
});
