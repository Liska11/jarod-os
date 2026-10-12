/**
 * U3 — contention SQLite (gap G11) et reprise après arrêt brutal, sur de VRAIS processus et une VRAIE base
 * chiffrée (`Db` de plugin-storage : WAL + busy_timeout 5000, `db.ts:418` de la source) :
 *   1. deux processus écrivent en parallèle → aucune écriture perdue, aucune erreur (busy_timeout absorbe) ;
 *   2. saturation : A tient le verrou d'écriture plus longtemps que busy_timeout → B reçoit une erreur
 *      EXPLICITE (SQLITE_BUSY) après ~5 s, jamais un blocage infini ni une perte silencieuse ; A libéré,
 *      B réécrit ;
 *   3. WAL : un lecteur n'est pas bloqué par un écrivain ;
 *   4. transactions lecture→écriture concurrentes (`Db.tx`) ;
 *   5. processus tué (TerminateProcess) au milieu d'une transaction → base intègre, validé présent,
 *      non validé absent ;
 *   6. job « en cours » dont le processus meurt → remis en file au démarrage suivant du kernel.
 * Les suites « sprint15 » de Kama-One ne faisaient rien de tout cela (compteurs simulés) : voir PHASE-4.md.
 */
import { type ChildProcess, fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import type { JobsService } from "@jarod/plugin-scheduler";
import { Db, type KeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKER = join(import.meta.dirname, "db-worker.ts");
const KEY = "c0ffee".repeat(10) + "abcd";
const children: ChildProcess[] = [];
const opened: Db[] = [];

afterEach(async () => {
  // Les processus d'abord (ils tiennent la base ouverte), puis les dossiers.
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* déjà fermée */
    }
  }
  await Promise.all(
    children.splice(0).map((c) =>
      c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => (c.once("exit", r), c.kill("SIGKILL"))),
    ),
  );
  await cleanup();
});

interface Worker {
  call<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
  /** Envoie sans attendre la réponse (le processus va bloquer). */
  send(op: string, args?: Record<string, unknown>): Promise<unknown>;
  proc: ChildProcess;
}

async function worker(path: string): Promise<Worker> {
  const proc = fork(WORKER, [], { execArgv: ["--import", "tsx"], cwd: ROOT, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(proc);
  let stderr = "";
  proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  let seq = 0;
  const waiting = new Map<number, { ok(v: unknown): void; ko(e: Error): void }>();
  proc.on("message", (m: { id?: number; ok?: boolean; value?: unknown; error?: string; code?: string; ready?: boolean }) => {
    if (m.id === undefined) return;
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.ok) w?.ok(m.value);
    else w?.ko(Object.assign(new Error(m.error), { code: m.code }));
  });
  await new Promise<void>((ok, ko) => {
    proc.once("message", () => ok());
    proc.once("exit", (c) => ko(new Error(`worker mort au démarrage (${c}) : ${stderr}`)));
  });
  const send = (op: string, args: Record<string, unknown> = {}) =>
    new Promise((ok, ko) => {
      const id = ++seq;
      waiting.set(id, { ok, ko });
      proc.send({ id, op, ...args });
    });
  const w: Worker = { call: (op, args) => send(op, args) as never, send, proc };
  await w.call("open", { path, key: KEY });
  return w;
}

const waitFile = async (f: string, ms = 20_000) => {
  const t0 = Date.now();
  while (!existsSync(f)) {
    if (Date.now() - t0 > ms) throw new Error(`témoin absent : ${f}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

function freshDb() {
  const dir = tempDir();
  const path = join(dir, "jarod.db");
  const db = new Db(path, { key: KEY }); // crée + chiffre + migre (schéma complet)
  opened.push(db);
  return { dir, path, db };
}

describe("U3 — contention SQLite entre deux processus (G11)", () => {
  it("écritures parallèles : 2 × 400 insertions, aucune perdue, aucune erreur", { timeout: 60_000 }, async () => {
    const { path, db } = freshDb();
    const [a, b] = await Promise.all([worker(path), worker(path)]);
    const [ra, rb] = await Promise.all([
      a.call<{ ok: number; errors: Record<string, number> }>("insert", { n: 400, label: "A", mode: "auto" }),
      b.call<{ ok: number; errors: Record<string, number> }>("insert", { n: 400, label: "B", mode: "tx" }),
    ]);
    expect(ra).toEqual({ ok: 400, errors: {} });
    expect(rb).toEqual({ ok: 400, errors: {} });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications")!.n).toBe(800);
    expect(db.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok");
    db.close();
  });

  it("saturation : verrou tenu 7 s > busy_timeout 5 s → SQLITE_BUSY explicite après ~5 s ; puis l'écriture passe", { timeout: 60_000 }, async () => {
    const { dir, path, db } = freshDb();
    const [a, b] = await Promise.all([worker(path), worker(path)]);
    const marker = join(dir, "verrou");
    const held = a.send("hold", { ms: 7_000, marker });
    await waitFile(marker);
    // 3. Pendant ce temps, un LECTEUR n'attend pas (WAL) — et ne voit pas la ligne non validée.
    const t0 = Date.now();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE title = 'hold'")!.n).toBe(0);
    expect(Date.now() - t0).toBeLessThan(500);
    // L'écrivain B attend busy_timeout, puis échoue EXPLICITEMENT.
    const busy = await b.call<{ ok: boolean; code?: string; ms: number }>("insertOne", { rowId: "b-1" });
    expect(busy.ok).toBe(false);
    expect(busy.code).toBe("SQLITE_BUSY");
    expect(busy.ms).toBeGreaterThanOrEqual(4_900);
    expect(busy.ms).toBeLessThan(6_900);
    await held; // A valide
    const after = await b.call<{ ok: boolean }>("insertOne", { rowId: "b-2" });
    expect(after.ok).toBe(true);
    expect(db.all<{ id: string }>("SELECT id FROM notifications ORDER BY id").map((r) => r.id)).toEqual(["b-2", expect.stringMatching(/^hold-/)]);
    db.close();
  });

  it("transactions lecture→écriture concurrentes (`Db.tx`) : aucune perte ; toute erreur est dite", { timeout: 60_000 }, async () => {
    const { path, db } = freshDb();
    const [a, b] = await Promise.all([worker(path), worker(path)]);
    const [ra, rb] = await Promise.all([
      a.call<{ ok: number; errors: Record<string, number> }>("insert", { n: 300, label: "RA", mode: "tx-read-write" }),
      b.call<{ ok: number; errors: Record<string, number> }>("insert", { n: 300, label: "RB", mode: "tx-read-write" }),
    ]);
    // Ce qui est compté réussi est en base, rien de plus : pas d'écriture fantôme ni perdue en silence.
    const inDb = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications")!.n;
    expect(inDb).toBe(ra.ok + rb.ok);
    const failures = Object.values(ra.errors).concat(Object.values(rb.errors)).reduce((s, n) => s + n, 0);
    expect(ra.ok + rb.ok + failures).toBe(600);
    // Avant `BEGIN IMMEDIATE` (db.ts) : { SQLITE_BUSY: 223, SQLITE_BUSY_SNAPSHOT: 66 } en 0,3 s — busy_timeout contourné.
    expect({ ...ra.errors, ...rb.errors }).toEqual({});
    expect(failures).toBe(0);
    db.close();
  });
});

describe("U3 — reprise après arrêt brutal", () => {
  it("processus tué au milieu d'une transaction : base intègre, validé présent, non validé absent", { timeout: 60_000 }, async () => {
    const { dir, path, db } = freshDb();
    db.close();
    const a = await worker(path);
    expect(await a.call("insert", { n: 50, label: "valide", mode: "tx" })).toEqual({ ok: 50, errors: {} });
    const marker = join(dir, "en-vol");
    void a.send("hold", { ms: 60_000, marker }).catch(() => {});
    await waitFile(marker);
    const exited = new Promise((r) => a.proc.once("exit", r));
    a.proc.kill("SIGKILL"); // TerminateProcess : aucune chance de valider ni d'annuler proprement
    await exited;
    const reopened = new Db(path, { key: KEY });
    opened.push(reopened);
    expect(reopened.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok");
    expect(reopened.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE title = 'valide'")!.n).toBe(50);
    expect(reopened.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE title = 'hold'")!.n).toBe(0);
    // Et la base reste écrivable.
    reopened.run("INSERT INTO notifications (id, kind, title, body, created_at) VALUES ('apres', 'info', 'apres', '', 0)");
    reopened.close();
  });

  it("job « en cours » d'un processus tué : remis en file au démarrage suivant du kernel (scheduler)", { timeout: 60_000 }, async () => {
    const dataDir = tempDir();
    const keys: KeyStore = { id: "memory", label: "test", load: () => KEY, save: () => {} };
    // Le kernel crée la base du profil (même clé que le worker).
    const first = await bootApp({ storage: { dataDir, keyStores: [keys] }, scheduler: { autoStart: false } });
    const path = (first as unknown as { storage: { dbPath: string } }).storage.dbPath;
    await shutdown(first);
    const w = await worker(path);
    const marker = join(dataDir, "job");
    void w.send("claimAndHang", { kind: "webhook", marker }).catch(() => {});
    await waitFile(marker);
    const jobId = readFileSync(marker, "utf8");
    const exited = new Promise((r) => w.proc.once("exit", r));
    w.proc.kill("SIGKILL");
    await exited;
    const next = (await bootApp({ storage: { dataDir, keyStores: [keys] }, scheduler: { autoStart: false } })) as unknown as { jobs: JobsService };
    expect(next.jobs.get(jobId)).toMatchObject({ status: "pending", lastError: "interrompu par un arrêt" });
  });
});
