/**
 * `VectorIndexProvider` au-dessus du sidecar turbovec (`sidecars/turbovec`, accord B17 ; Q15, PLAN §10
 * phase 1). Jarod-cordis — nouveau.
 *
 * Le sidecar est un processus enfant sans shell ni port : protocole en lignes sur stdio (`ok …` /
 * `err <code> <message>`, une réponse par commande, dans l'ordre). Il ne garde que des identifiants
 * (`rag_chunks.id`) et des vecteurs compressés (TurboQuant 4 bits : le seul réglage gagnant au bench Q15,
 * DECISIONS 2026-09-29) ; SQLite reste la source, tout se reconstruit par `rebuild`.
 *
 * Le binaire est un chemin EXPLICITE (config du plugin), jamais deviné. Un sidecar absent, mort ou hors
 * délai rend le fournisseur indisponible (`available = false`) : l'appelant dégrade, rien ne bloque.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type ChunkId,
  type EngineInfo,
  type IndexCheckpoint,
  type IndexHealth,
  type IndexSpec,
  type VectorHit,
  type VectorIndexProvider,
  type VectorRow,
  type VectorSearchRequest,
  embeddingGeneration,
} from "@jarod/contracts";

export interface TurbovecConfig {
  /** `turbovec-sidecar(.exe)` compilé par `cargo build --release --offline --locked`. */
  bin: string;
  /** Bits par coordonnée ; 4 = seul réglage adopté (turbovec-2 perdant au bench Q15). */
  bits?: 4;
  /** Délai maximal d'une commande (défaut 30 s) ; au-delà le sidecar est arrêté. */
  timeoutMs?: number;
}

/** Échantillon de calibration TQ+ (bench Q15 : ≈ 1 024 lignes, une fois avant l'ingest). */
const CALIBRATION_ROWS = 1024;

/** Erreur du sidecar ou du transport, avec un code machine (jamais le texte d'une requête). */
export class TurbovecError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`TURBOVEC_${code.toUpperCase()}: ${message}`);
  }
}

const b64 = (bytes: ArrayBufferView) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

function u64s(ids: readonly ChunkId[]): Uint8Array {
  const out = new BigUint64Array(ids.length);
  ids.forEach((id, i) => {
    out[i] = BigInt(id);
  });
  return new Uint8Array(out.buffer);
}

function concat(rows: readonly VectorRow[], dim: number): Float32Array {
  const out = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => {
    if (r.vector.length !== dim) throw new TurbovecError("dim", `ligne ${r.id} en ${r.vector.length} dimensions, index en ${dim}`);
    out.set(r.vector, i * dim);
  });
  return out;
}

export class TurbovecProvider implements VectorIndexProvider {
  readonly kind = "turbovec" as const;
  private proc: ChildProcess | null = null;
  private readonly waiting: { resolve: (l: string) => void; reject: (e: Error) => void }[] = [];
  private spec: IndexSpec | null = null;
  private dead: TurbovecError | null = null;

  constructor(private readonly cfg: TurbovecConfig) {}

  /** Faux dès que le binaire manque ou que le sidecar est mort : l'appelant se replie. */
  get available(): boolean {
    return !this.dead && existsSync(this.cfg.bin);
  }

  info(): EngineInfo {
    return { name: "turbovec", version: `1.0.0-b${this.cfg.bits ?? 4}`, device: "CPU" };
  }

  private start(): ChildProcess {
    if (this.dead) throw this.dead;
    if (this.proc) return this.proc;
    if (!existsSync(this.cfg.bin)) throw new TurbovecError("missing", "binaire du sidecar absent");
    const proc = spawn(this.cfg.bin, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    createInterface({ input: proc.stdout! }).on("line", (l) => this.waiting.shift()?.resolve(l));
    const fail = (code: string, msg: string) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.dead ??= new TurbovecError(code, msg);
      for (const w of this.waiting.splice(0)) w.reject(this.dead);
    };
    proc.on("error", (e) => fail("spawn", e.message));
    proc.on("exit", (c) => fail("exit", `sidecar arrêté (code ${c})`));
    proc.stdin!.on("error", () => {});
    this.proc = proc;
    return proc;
  }

  private cmd(line: string): Promise<string> {
    const proc = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dead ??= new TurbovecError("timeout", `${line.split(" ")[0]} hors délai`);
        proc.kill();
      }, this.cfg.timeoutMs ?? 30_000);
      this.waiting.push({
        resolve: (l) => {
          clearTimeout(timer);
          if (l === "ok" || l.startsWith("ok ")) return resolve(l.slice(3));
          const [, code = "sidecar", ...msg] = l.split(" ");
          reject(new TurbovecError(code, msg.join(" ")));
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      proc.stdin!.write(`${line}\n`);
    });
  }

  private need(indexId: string): IndexSpec {
    if (!this.spec || this.spec.indexId !== indexId) throw new TurbovecError("state", `index inconnu : ${indexId}`);
    return this.spec;
  }

  private dim(): number {
    const d = this.spec?.embedding.dim;
    if (!d) throw new TurbovecError("state", "index dense attendu");
    return d;
  }

  async create(spec: IndexSpec): Promise<void> {
    if (!spec.embedding.dim) throw new TurbovecError("state", "index dense attendu");
    await this.cmd(`new ${spec.embedding.dim} ${this.cfg.bits ?? 4}`);
    this.spec = spec;
  }

  /** Ajout en masse par fichiers temporaires (une ligne base64 de 10⁵ vecteurs ne tiendrait pas). */
  private async addMany(rows: readonly VectorRow[]): Promise<void> {
    if (!rows.length) return;
    const dir = mkdtempSync(join(tmpdir(), "jarod-tv-"));
    try {
      const v = join(dir, "v.f32");
      const ids = join(dir, "ids.u64");
      writeFileSync(v, concat(rows, this.dim()));
      writeFileSync(ids, u64s(rows.map((r) => r.id)));
      await this.cmd(`addfile ${v} ${ids}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async upsert(indexId: string, rows: readonly VectorRow[]): Promise<void> {
    this.need(indexId);
    for (const r of rows) await this.cmd(`remove ${r.id}`);
    await this.addMany(rows);
    await this.cmd("prepare");
  }

  async remove(indexId: string, ids: readonly ChunkId[]): Promise<void> {
    this.need(indexId);
    for (const id of ids) await this.cmd(`remove ${id}`);
  }

  async search(req: VectorSearchRequest): Promise<VectorHit[]> {
    this.need(req.indexId);
    req.signal?.throwIfAborted();
    if (req.allow && req.allow.length === 0) return [];
    if (req.vector.length !== this.dim()) throw new TurbovecError("dim", `requête en ${req.vector.length} dimensions`);
    const allow = req.allow ? ` ${b64(u64s(req.allow))}` : "";
    const out = await this.cmd(`search ${Math.max(1, Math.floor(req.k))} ${b64(req.vector)}${allow}`);
    return out
      .split(" ")
      .filter(Boolean)
      .map((p) => {
        const [id, score] = p.split(":");
        return { id: Number(id), score: Number(score) };
      });
  }

  async size(): Promise<number> {
    return Number(await this.cmd("len"));
  }

  /** Phase 1 : l'index fantôme vit en mémoire et se reconstruit depuis SQLite ; `sync` rend son état. */
  async sync(indexId: string): Promise<IndexCheckpoint> {
    const spec = this.need(indexId);
    return { indexId, generation: embeddingGeneration(spec.embedding), size: await this.size(), at: Date.now() };
  }

  async verify(indexId: string): Promise<IndexHealth> {
    if (!this.spec || this.spec.indexId !== indexId) return { indexId, ok: false, size: 0, generation: null, error: "unknown-index" };
    try {
      return { indexId, ok: true, size: await this.size(), generation: embeddingGeneration(this.spec.embedding) };
    } catch (e) {
      return { indexId, ok: false, size: 0, generation: null, error: e instanceof TurbovecError ? e.code : "sidecar" };
    }
  }

  async rebuild(spec: IndexSpec, source: AsyncIterable<VectorRow> | Iterable<VectorRow>): Promise<IndexCheckpoint> {
    const rows: VectorRow[] = [];
    for await (const r of source) rows.push(r);
    await this.create(spec);
    if (rows.length) {
      // TQ+ : échantillon réparti uniformément dans l'ensemble indexé, avant l'ingest (protocole Q15).
      const n = Math.min(CALIBRATION_ROWS, rows.length);
      const sample = Array.from({ length: n }, (_, i) => rows[Math.floor((i * rows.length) / n)]!);
      const dir = mkdtempSync(join(tmpdir(), "jarod-tv-"));
      try {
        const file = join(dir, "sample.f32");
        writeFileSync(file, concat(sample, this.dim()));
        await this.cmd(`calibrate ${file}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      await this.addMany(rows);
      await this.cmd("prepare");
    }
    return this.sync(spec.indexId);
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.dead ??= new TurbovecError("closed", "fournisseur fermé");
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.stdin!.end("quit\n");
    const t = setTimeout(() => proc.kill(), 2_000);
    await exited;
    clearTimeout(t);
  }
}
