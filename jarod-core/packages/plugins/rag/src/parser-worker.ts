/**
 * `DocumentParser` au-dessus d'un WORKER : un processus enfant sans shell ni port, protocole en lignes JSON sur
 * stdio (précédent : le sidecar turbovec, `turbovec.ts`). PLAN §10 phase 2, lot B ④. Jarod-cordis — nouveau.
 *
 * Générique : rien ici n'est propre à Docling. Le worker Docling (lot B ⑥, Python isolé, opt-in) n'est qu'une
 * commande de plus derrière ce protocole ; les tests utilisent un faux worker Node.
 *
 * Protocole (une ligne JSON par message, une commande à la fois, dans l'ordre) :
 *   → {"op":"hello"}                            ← {"ok":true,"name","version","protocol":1,"pid"}
 *   → {"op":"parse","id":n,"path","name","mime"} ← {"id":n,"ok":true,"manifest":{…},"text":"…"}
 *                                                 ou {"id":n,"ok":false,"code":"…"}
 *   → {"op":"quit"}
 * stderr du worker est JETÉ (il peut contenir le texte du document) ; seule la ligne de réponse compte.
 *
 * Sûreté, dite telle quelle : la garde de chemin, l'environnement en liste blanche, `HF_HUB_OFFLINE`, les threads
 * bornés et la priorité basse sont des CONSIGNES et des contrôles de l'adaptateur, PAS une isolation forte : le
 * worker tourne avec les droits de l'utilisateur.
 *
 * Aucun texte de document, aucun message libre du worker dans les erreurs : uniquement des codes.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { Code, DocumentManifest, type DocumentInput, type DocumentParser, type EngineInfo, type ParsedDocument } from "@jarod/contracts";

export interface WorkerParserConfig {
  /** Nom du parseur annoncé par le worker (`docling`…) : le `hello` et chaque manifeste doivent le porter. */
  name: string;
  /** Commande du worker : chemin EXPLICITE (jamais deviné, jamais cherché dans le PATH). */
  command: string;
  args?: string[];
  cwd?: string;
  /** Extensions prises en charge, avec le point, en minuscules (`.pdf`). */
  extensions: readonly string[];
  /** Garde d'espace de travail : le worker ne reçoit que des chemins qu'elle accepte. */
  allowPath: (path: string) => boolean;
  /** Délai maximal PAR DOCUMENT (défaut 120 s) ; au-delà le worker est arrêté de force. */
  timeoutMs?: number;
  /** Délai du démarrage (imports, chargement des modèles ; défaut 60 s). */
  startTimeoutMs?: number;
  /** Taille maximale d'un fichier envoyé (défaut 25 Mio) : au-delà, refus AVANT tout envoi. */
  maxBytes?: number;
  /** Threads de calcul autorisés au worker (défaut 2) : l'ingestion ne doit pas dégrader NPU, voix ni chat. */
  threads?: number;
  /** Variables d'environnement ajoutées (caches de modèles…) ; rien d'autre ne vient du parent que la liste blanche. */
  env?: Record<string, string>;
}

/** Erreur du worker ou du transport : un CODE machine, jamais un texte de document ni un message du worker. */
export class WorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkerError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Échecs de PROCESSUS consécutifs (mort, délai, réponse invalide, lancement) avant l'indisponibilité définitive. */
const MAX_PROCESS_FAILURES = 3;
const PROTOCOL = 1;

/** Ce que le worker hérite du parent : de quoi démarrer, pas de secrets (clés d'API, jetons…). */
const ENV_ALLOW = ["PATH", "SystemRoot", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];

interface Hello {
  name: string;
  version: string;
  pid: number;
}

interface Pending {
  resolve: (line: string) => void;
  reject: (e: WorkerError) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Arrête le worker ET ses descendants (le lanceur `python.exe` d'un venv Windows engendre l'interpréteur). */
function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  try {
    if (pid && process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else if (pid) process.kill(-pid, "SIGKILL");
  } catch {
    /* déjà mort */
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* déjà mort */
  }
}

export class WorkerParser implements DocumentParser {
  private proc: ChildProcess | null = null;
  private pending: Pending | null = null;
  private hello: Hello | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private failures = 0;
  private dead: WorkerError | null = null;

  constructor(private readonly cfg: WorkerParserConfig) {}

  /** Faux dès que le worker est absent ou a échoué trop de fois de suite : l'appelant se replie. */
  get available(): boolean {
    return !this.dead && existsSync(this.cfg.command);
  }

  /** Pid du worker vivant (contrôle des processus orphelins), null sinon. */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  info(): EngineInfo {
    return { name: this.cfg.name, version: this.hello?.version ?? "inconnue" };
  }

  accepts(name: string, _mime?: string): boolean {
    return this.cfg.extensions.includes(extname(name).toLowerCase());
  }

  async parse(input: DocumentInput, signal?: AbortSignal): Promise<ParsedDocument> {
    signal?.throwIfAborted();
    if (!this.available) throw new WorkerError(this.dead?.code ?? "WORKER_MISSING");
    let temp: string | null = null;
    try {
      let path: string;
      let name: string;
      if ("path" in input) {
        path = input.path;
        name = input.path;
        if (!this.cfg.allowPath(path)) throw new WorkerError("WORKER_PATH_REFUSED");
      } else {
        // Des octets en mémoire : fichier temporaire à nous (jamais un chemin fourni par l'appelant).
        temp = mkdtempSync(join(tmpdir(), "jarod-doc-"));
        name = input.name;
        path = join(temp, `document${extname(input.name).toLowerCase()}`);
        if (input.bytes.length > (this.cfg.maxBytes ?? DEFAULT_MAX_BYTES)) throw new WorkerError("WORKER_TOO_LARGE");
        writeFileSync(path, input.bytes);
      }
      let bytes: Buffer;
      try {
        if (statSync(path).size > (this.cfg.maxBytes ?? DEFAULT_MAX_BYTES)) throw new WorkerError("WORKER_TOO_LARGE");
        bytes = readFileSync(path);
      } catch (e) {
        throw e instanceof WorkerError ? e : new WorkerError("WORKER_UNREADABLE");
      }
      const mime = "bytes" in input ? input.mime : undefined;
      return await this.serialized(() => this.parseOne(path, name, mime, bytes, signal));
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }

  /** Une commande à la fois : le protocole n'a pas d'entrelacement. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async parseOne(path: string, name: string, mime: string | undefined, bytes: Buffer, signal?: AbortSignal): Promise<ParsedDocument> {
    signal?.throwIfAborted();
    if (this.dead) throw this.dead;
    const proc = await this.ensure(signal);
    const id = this.nextId++;
    const line = await this.request(proc, { op: "parse", id, path, name: extname(name).toLowerCase(), ...(mime ? { mime } : {}) }, this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
    const reply = this.decode(line);
    if (reply.id !== id) throw this.processFailure(proc, "WORKER_BAD_RESPONSE");
    if (reply.ok === false) {
      // Erreur du DOCUMENT (illisible, protégé…), pas du processus : ne compte pas, le worker reste utilisable.
      this.failures = 0;
      const code = typeof reply.code === "string" ? reply.code : "";
      throw new WorkerError(`WORKER_ERROR:${Code.safeParse(code).success ? code.slice(0, 100) : "unknown"}`);
    }
    if (reply.ok !== true || typeof reply.text !== "string") throw this.processFailure(proc, "WORKER_BAD_RESPONSE");
    const parsed = DocumentManifest.safeParse(reply.manifest);
    if (!parsed.success) throw this.processFailure(proc, "WORKER_BAD_RESPONSE");
    const manifest = parsed.data;
    const text = reply.text;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const spans = [...manifest.sections, ...manifest.tables, ...manifest.images];
    const consistent =
      manifest.source.sha256 === sha256 &&
      manifest.source.bytes === bytes.length &&
      manifest.parser.name === this.hello?.name &&
      manifest.parser.version === this.hello?.version &&
      spans.every((s) => s.start <= s.end && s.end <= text.length);
    if (!consistent) throw this.processFailure(proc, "WORKER_BAD_RESPONSE");
    this.failures = 0;
    return { manifest, text };
  }

  private decode(line: string): Record<string, unknown> {
    try {
      const v: unknown = JSON.parse(line);
      if (isRecord(v)) return v;
    } catch {
      /* ligne non JSON */
    }
    // Le processus vient de nous répondre n'importe quoi : on ne lui refait pas confiance.
    throw this.processFailure(this.proc, "WORKER_BAD_RESPONSE");
  }

  /** Le worker vivant, lancé et salué au besoin. */
  private async ensure(signal?: AbortSignal): Promise<ChildProcess> {
    if (this.proc && this.hello) return this.proc;
    if (!existsSync(this.cfg.command)) {
      this.dead ??= new WorkerError("WORKER_MISSING");
      throw this.dead;
    }
    const threads = String(Math.max(1, Math.floor(this.cfg.threads ?? 2)));
    const env: Record<string, string> = {};
    for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, {
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      OMP_NUM_THREADS: threads,
      MKL_NUM_THREADS: threads,
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      ...this.cfg.env,
    });
    let proc: ChildProcess;
    try {
      proc = spawn(this.cfg.command, this.cfg.args ?? [], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env,
        cwd: this.cfg.cwd,
        detached: process.platform !== "win32", // groupe de processus propre : arrêt de tout l'arbre
      });
    } catch {
      throw this.processFailure(null, "WORKER_SPAWN");
    }
    this.proc = proc;
    this.hello = null;
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      if (this.proc !== proc) return;
      const p = this.pending;
      this.pending = null;
      p?.resolve(l);
    });
    proc.on("error", () => this.onGone(proc, "WORKER_SPAWN"));
    proc.on("exit", () => this.onGone(proc, "WORKER_EXIT"));
    proc.stdin!.on("error", () => {});
    try {
      if (proc.pid !== undefined) setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* priorité non modifiable : une consigne, pas une garantie */
    }
    const line = await this.request(proc, { op: "hello" }, this.cfg.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, signal);
    const h = this.decode(line);
    if (
      h.ok !== true ||
      h.protocol !== PROTOCOL ||
      h.name !== this.cfg.name ||
      typeof h.version !== "string" ||
      !Code.safeParse(h.version).success ||
      typeof h.pid !== "number"
    )
      throw this.processFailure(proc, "WORKER_BAD_RESPONSE");
    this.hello = { name: h.name, version: h.version, pid: h.pid };
    return proc;
  }

  /** Envoie une ligne et attend UNE ligne de réponse (délai, arrêt et mort du processus rattrapés). */
  private request(proc: ChildProcess, msg: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => done(() => reject(this.processFailure(proc, "WORKER_TIMEOUT"))), timeoutMs);
      const onAbort = () =>
        done(() => {
          this.stop(proc); // arrêt demandé : ce n'est pas un échec du worker
          reject(signal!.reason instanceof Error ? signal!.reason : new DOMException("Aborted", "AbortError"));
        });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        resolve: (l) => done(() => resolve(l)),
        reject: (e) => done(() => reject(e)),
      };
      proc.stdin!.write(`${JSON.stringify(msg)}\n`);
    });
  }

  /** Le processus s'est arrêté sans qu'on le lui ait demandé. */
  private onGone(proc: ChildProcess, code: string): void {
    if (this.proc !== proc) return;
    const p = this.pending;
    this.pending = null;
    this.proc = null;
    this.hello = null;
    const err = this.recordFailure(code);
    p?.reject(err);
  }

  private recordFailure(code: string): WorkerError {
    this.failures++;
    const err = new WorkerError(code);
    if (this.failures >= MAX_PROCESS_FAILURES) this.dead ??= new WorkerError("WORKER_UNAVAILABLE");
    return err;
  }

  /** Échec de PROCESSUS : le worker est arrêté, le suivant sera relancé (jusqu'à `MAX_PROCESS_FAILURES` de suite). */
  private processFailure(proc: ChildProcess | null, code: string): WorkerError {
    if (proc && this.proc === proc) {
      this.proc = null;
      this.hello = null;
      this.pending = null;
      killTree(proc);
    }
    return this.recordFailure(code);
  }

  private stop(proc: ChildProcess): void {
    if (this.proc === proc) {
      this.proc = null;
      this.hello = null;
      this.pending = null;
    }
    killTree(proc);
  }

  /** Termine le worker (poliment, puis de force) ; le fournisseur reste réutilisable (le prochain appel relance). */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.hello = null;
    this.pending = null;
    const exited = new Promise<void>((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", () => r())));
    try {
      proc.stdin!.end(`${JSON.stringify({ op: "quit" })}\n`);
    } catch {
      /* déjà fermé */
    }
    const t = setTimeout(() => killTree(proc), 2_000);
    await exited;
    clearTimeout(t);
    killTree(proc); // descendants éventuels
  }
}
