/**
 * Second processus pour les suites U3 (contention G11, crash recovery) : ouvre la MÊME base chiffrée que
 * le test avec le `Db` de plugin-storage (WAL, busy_timeout 5000 — `db.ts:418` de la source) et exécute
 * des opérations commandées par IPC. Lancé par `fork(…, { execArgv: ["--import", "tsx"] })`.
 * Pour tenir un verrou d'écriture, le processus BLOQUE son fil (Atomics.wait) à l'intérieur d'une
 * transaction : il ne peut plus répondre, donc il le signale par un fichier témoin écrit juste avant.
 */
import { writeFileSync } from "node:fs";
import { Db } from "@jarod/plugin-storage";
import { JobsService } from "@jarod/plugin-scheduler";

let db: Db | null = null;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const code = (e: unknown) => (e as { code?: string }).code ?? (e as Error).message;

type Msg = { id: number; op: string } & Record<string, unknown>;

const ops: Record<string, (m: Msg) => unknown> = {
  open: (m) => {
    db = new Db(m.path as string, { key: m.key as string });
    return { pid: process.pid };
  },
  /** N insertions ; `mode` : "auto" (une instruction), "tx" (BEGIN + écriture), "tx-read-write" (lecture puis écriture). */
  insert: (m) => {
    const errors: Record<string, number> = {};
    let ok = 0;
    for (let i = 0; i < (m.n as number); i++) {
      const id = `${m.label}-${i}`;
      const write = () => db!.run("INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?, 'info', ?, '', ?)", id, m.label as string, Date.now());
      try {
        if (m.mode === "auto") write();
        else if (m.mode === "tx") db!.tx(write);
        else
          db!.tx(() => {
            db!.get("SELECT COUNT(*) AS n FROM notifications");
            write();
          });
        ok++;
      } catch (e) {
        errors[code(e)] = (errors[code(e)] ?? 0) + 1;
      }
    }
    return { ok, errors };
  },
  /** Prend le verrou d'écriture (une insertion dans une transaction), écrit le témoin, bloque `ms`, puis valide. */
  hold: (m) => {
    db!.tx(() => {
      db!.run("INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?, 'info', 'hold', '', ?)", `hold-${m.id}`, Date.now());
      writeFileSync(m.marker as string, String(Date.now()));
      sleep(m.ms as number);
    });
    return { committed: true };
  },
  /** Une insertion chronométrée : réussite, ou le code d'erreur et le temps d'attente avant l'erreur. */
  insertOne: (m) => {
    const t0 = Date.now();
    try {
      db!.run("INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?, 'info', 'one', '', ?)", m.rowId as string, Date.now());
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, code: code(e), message: (e as Error).message, ms: Date.now() - t0 };
    }
  },
  count: (m) => db!.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE title = ?`, m.label as string)?.n ?? 0,
  /** Une file durable : met un job en file, le PREND (en cours), écrit le témoin, puis bloque — le test tue le processus. */
  claimAndHang: (m) => {
    const jobs = new JobsService({ db: db! });
    const { job } = jobs.enqueue({ kind: m.kind as string, payload: { n: 1 } });
    jobs.claim(job.id);
    writeFileSync(m.marker as string, job.id);
    sleep(600_000);
    return null;
  },
  close: () => {
    db?.close();
    db = null;
    return true;
  },
};

process.on("message", (raw) => {
  const m = raw as Msg;
  try {
    process.send!({ id: m.id, ok: true, value: ops[m.op]!(m) });
  } catch (e) {
    process.send!({ id: m.id, ok: false, error: (e as Error).message, code: code(e) });
  }
});
process.send!({ ready: true });
