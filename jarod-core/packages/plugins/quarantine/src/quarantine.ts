/**
 * Quarantaine : tout fichier venu de l'extérieur y entre, y est empreinté, tracé (provenance), analysé, et n'en
 * sort que par une promotion contrôlée.
 *
 * Règles tenues ici, chacune testée :
 *  - l'entrée copie le fichier sous son empreinte SHA-256 (le nom d'origine n'est qu'une étiquette) ; la source
 *    n'est ni déplacée ni modifiée, et un lien n'est jamais suivi ;
 *  - « propre » ne veut dire que ce que l'analyseur a dit : sans analyseur disponible le statut est `unscanned`,
 *    et un fichier non analysé ne sort jamais ;
 *  - la promotion exige un statut `clean`, l'empreinte recalculée identique à l'entrée (sinon `tampered`), un
 *    accord explicite par le canal d'approbation fourni (sans canal : refus), une destination qui n'existe pas
 *    encore, et une copie dont l'empreinte est revérifiée ;
 *  - l'audit ne contient que des empreintes, des tailles et des statuts.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

export type QuarantineStatus = "quarantined" | "clean" | "infected" | "unscanned" | "tampered" | "promoted" | "deleted";

export interface Provenance {
  /** D'où vient le fichier : `download`, `mcp`, `attachment`, `sandbox`…, libre mais court. */
  source: string;
  url?: string;
}

export interface QuarantineRecord {
  id: string;
  size: number;
  /** Étiquette seulement : jamais utilisée comme chemin. */
  label: string;
  provenance: Provenance;
  intakeAt: number;
  status: QuarantineStatus;
  scan: { at: number; scanner: string; verdict: string } | null;
  promotedTo?: string;
}

export type ScanVerdict = { verdict: "clean" | "infected" | "unavailable"; scanner: string; detail?: string };
export interface Scanner {
  scan(file: string): ScanVerdict;
}

export type Approver = (request: { id: string; label: string; size: number; provenance: Provenance; destination: string }) => Promise<boolean>;

export interface QuarantineEvent {
  at: number;
  id: string;
  action: "intake" | "scan" | "promote" | "refused" | "delete";
  detail: Record<string, string | number | boolean | null>;
}

export class QuarantineError extends Error {}

/** Ce que l'admission d'une entrée externe a décidé (`admitBytes`). */
export interface AdmitResult {
  admitted: boolean;
  record: QuarantineRecord;
  /** Pourquoi c'est refusé, en clair, pour la personne. */
  reason?: string;
}

/** La forme de l'admission que les plugins consommateurs reçoivent (sans dépendre de ce paquet). */
export type AdmitExternal = (data: Buffer, label: string, provenance: Provenance) => AdmitResult;

const ID = /^[0-9a-f]{64}$/;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Le dernier segment du nom, `/` comme `\` étant des séparateurs sur tout système ; jamais `.` ni `..`. */
function safeLabel(name: string): string {
  const label = win32.basename(name).replace(/[^\w.\- ]/g, "_").slice(0, 120);
  return label === "." || label === ".." || !label ? "fichier" : label;
}

/** L'analyseur de Windows (Defender), s'il est là. Lecture seule : `-DisableRemediation`, rien n'est supprimé. */
export class DefenderScanner implements Scanner {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private binary(): string | null {
    const candidates: string[] = [];
    const programs = this.env.ProgramFiles;
    if (programs) candidates.push(join(programs, "Windows Defender", "MpCmdRun.exe"));
    const data = this.env.ProgramData;
    if (data) {
      const platform = join(data, "Microsoft", "Windows Defender", "Platform");
      if (existsSync(platform)) {
        for (const v of readdirSync(platform).sort().reverse()) candidates.push(join(platform, v, "MpCmdRun.exe"));
      }
    }
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  scan(file: string): ScanVerdict {
    if (process.platform !== "win32") return { verdict: "unavailable", scanner: "defender", detail: "n'existe pas sur cette plateforme" };
    const bin = this.binary();
    if (!bin) return { verdict: "unavailable", scanner: "defender", detail: "MpCmdRun.exe introuvable" };
    const run = spawnSync(bin, ["-Scan", "-ScanType", "3", "-File", file, "-DisableRemediation"], { timeout: 120_000, windowsHide: true });
    if (run.error) return { verdict: "unavailable", scanner: "defender", detail: run.error.message };
    // 0 : rien trouvé. 2 : une menace. Tout autre code : l'analyse n'a pas eu lieu, ce n'est PAS un « propre ».
    if (run.status === 0) return { verdict: "clean", scanner: "defender" };
    if (run.status === 2) return { verdict: "infected", scanner: "defender" };
    return { verdict: "unavailable", scanner: "defender", detail: `code ${run.status}` };
  }
}

export interface QuarantineDeps {
  root: string;
  scanner?: Scanner;
  approve?: Approver | null;
  onEvent?: (e: QuarantineEvent) => void;
}

export class QuarantineService {
  constructor(private readonly d: QuarantineDeps) {}

  private get root(): string {
    mkdirSync(this.d.root, { recursive: true });
    if (lstatSync(this.d.root).isSymbolicLink()) throw new QuarantineError("la racine de la quarantaine est un lien : refusée");
    return realpathSync.native(resolve(this.d.root));
  }

  private emit(id: string, action: QuarantineEvent["action"], detail: QuarantineEvent["detail"] = {}): void {
    this.d.onEvent?.({ at: Date.now(), id, action, detail });
  }

  private blob(id: string): string {
    return join(this.root, `${id}.blob`);
  }

  private metaPath(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private load(id: string): QuarantineRecord {
    if (!ID.test(id)) throw new QuarantineError(`identifiant inconnu : ${id}`);
    const path = this.metaPath(id);
    if (!existsSync(path)) throw new QuarantineError(`identifiant inconnu : ${id}`);
    return JSON.parse(readFileSync(path, "utf8")) as QuarantineRecord;
  }

  private save(record: QuarantineRecord): void {
    writeFileSync(this.metaPath(record.id), JSON.stringify(record, null, 2));
  }

  get(id: string): QuarantineRecord {
    return this.load(id);
  }

  list(): QuarantineRecord[] {
    return readdirSync(this.root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.root, f), "utf8")) as QuarantineRecord);
  }

  /** Copie `source` en quarantaine. La source reste où elle est. */
  intake(source: string, provenance: Provenance): QuarantineRecord {
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new QuarantineError("la source n'est pas un fichier ordinaire (un lien n'est jamais suivi)");
    const bytes = readFileSync(source);
    const id = sha256(bytes);
    if (existsSync(this.metaPath(id)) && this.load(id).status !== "deleted") return this.load(id);
    writeFileSync(this.blob(id), bytes);
    const record: QuarantineRecord = {
      id,
      size: bytes.length,
      label: safeLabel(source),
      provenance: { source: String(provenance.source).slice(0, 40), ...(provenance.url ? { url: String(provenance.url).slice(0, 500) } : {}) },
      intakeAt: Date.now(),
      status: "quarantined",
      scan: null,
    };
    this.save(record);
    this.emit(id, "intake", { size: bytes.length, source: record.provenance.source });
    return record;
  }

  private intact(record: QuarantineRecord): boolean {
    const path = this.blob(record.id);
    return existsSync(path) && sha256(readFileSync(path)) === record.id;
  }

  scan(id: string): QuarantineRecord {
    const record = this.load(id);
    if (record.status === "deleted" || record.status === "promoted") throw new QuarantineError(`le fichier est ${record.status}`);
    if (!this.intact(record)) {
      record.status = "tampered";
      this.save(record);
      this.emit(id, "scan", { verdict: "tampered" });
      return record;
    }
    const result = (this.d.scanner ?? new DefenderScanner()).scan(this.blob(id));
    record.scan = { at: Date.now(), scanner: result.scanner, verdict: result.verdict };
    record.status = result.verdict === "clean" ? "clean" : result.verdict === "infected" ? "infected" : "unscanned";
    this.save(record);
    this.emit(id, "scan", { verdict: result.verdict, scanner: result.scanner });
    return record;
  }

  /** Fait sortir un fichier propre vers `destDir`, après accord. Rend le chemin créé, ou lève une erreur. */
  async promote(id: string, destDir: string, name?: string): Promise<string> {
    const refuse = (why: string): never => {
      this.emit(id, "refused", { why });
      throw new QuarantineError(why);
    };
    const record = this.load(id);
    if (record.status !== "clean") refuse(`statut « ${record.status} » : seul un fichier analysé et propre peut sortir`);
    if (!this.intact(record)) {
      record.status = "tampered";
      this.save(record);
      refuse("l'empreinte du fichier a changé depuis l'entrée");
    }
    const dir = resolve(destDir);
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) refuse("la destination n'est pas un dossier ordinaire");
    const target = join(realpathSync.native(dir), safeLabel(name ?? record.label));
    if (existsSync(target)) refuse("la destination existe déjà : rien n'est écrasé");
    const approve = this.d.approve;
    if (!approve) refuse("aucun canal d'approbation n'est branché : une promotion sans accord n'est pas une promotion");
    let granted = false;
    try {
      granted = await approve!({ id, label: record.label, size: record.size, provenance: record.provenance, destination: target });
    } catch {
      granted = false;
    }
    if (!granted) refuse("l'utilisateur n'a pas donné son accord");
    copyFileSync(this.blob(id), target);
    if (sha256(readFileSync(target)) !== id) {
      rmSync(target, { force: true });
      refuse("la copie ne correspond pas à l'empreinte : retirée");
    }
    record.status = "promoted";
    record.promotedTo = target;
    this.save(record);
    this.emit(id, "promote", { size: record.size });
    return target;
  }

  /**
   * V-07 — l'ADMISSION d'une entrée externe (pièce jointe d'une messagerie ou du téléphone, fichier rapporté par un outil Internet, skill
   * publique) : le contenu entre, est empreinté et analysé, et n'est admis que si l'analyseur l'a dit propre. Infecté, non analysable ou
   * altéré : refusé. Dans tous les cas la copie en quarantaine est détruite après la décision (aucune copie en clair d'une pièce jointe que
   * le magasin chiffre) ; la trace reste : empreinte, provenance, verdict.
   *
   * Pas de canal d'approbation ici, à la différence de `promote` : la porte a déjà été ouverte par la personne (passerelle configurée,
   * téléphone appairé, appel d'outil accordé) ; la quarantaine ajoute l'analyse, elle ne redemande pas l'accord.
   */
  admitBytes(data: Buffer, label: string, provenance: Provenance): AdmitResult {
    const id = sha256(data);
    writeFileSync(this.blob(id), data);
    const record: QuarantineRecord = {
      id,
      size: data.length,
      label: safeLabel(label),
      provenance: { source: String(provenance.source).slice(0, 40), ...(provenance.url ? { url: String(provenance.url).slice(0, 500) } : {}) },
      intakeAt: Date.now(),
      status: "quarantined",
      scan: null,
    };
    this.save(record);
    this.emit(id, "intake", { size: data.length, source: record.provenance.source });
    const scanned = this.scan(id);
    rmSync(this.blob(id), { force: true });
    if (scanned.status === "clean") {
      scanned.status = "promoted";
      scanned.promotedTo = `admis (${scanned.provenance.source})`;
      this.save(scanned);
      this.emit(id, "promote", { size: scanned.size, admitted: true });
      return { admitted: true, record: scanned };
    }
    const reason =
      scanned.status === "infected"
        ? `menace détectée par ${scanned.scan?.scanner ?? "l'analyseur"}`
        : scanned.status === "tampered"
          ? "le contenu a changé pendant l'analyse"
          : `aucune analyse possible (${scanned.scan?.scanner ?? "analyseur"} indisponible) : un fichier non analysé n'entre pas`;
    this.emit(id, "refused", { why: reason });
    return { admitted: false, record: scanned, reason };
  }

  /**
   * L'admission d'un FICHIER déjà écrit par un outil dans un dossier de transit : propre, il est copié (empreinte revérifiée) vers
   * `destDir` et le chemin créé est rendu ; sinon `QuarantineError`. Le dossier de transit appartient à l'appelant, qui le vide.
   */
  admitFile(source: string, provenance: Provenance, destDir: string, name?: string): string {
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new QuarantineError("la source n'est pas un fichier ordinaire (un lien n'est jamais suivi)");
    const bytes = readFileSync(source);
    const verdict = this.admitBytes(bytes, name ?? source, provenance);
    if (!verdict.admitted) throw new QuarantineError(`refusé par la quarantaine : ${verdict.reason}`);
    mkdirSync(destDir, { recursive: true });
    const dir = resolve(destDir);
    if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) throw new QuarantineError("la destination n'est pas un dossier ordinaire");
    const target = join(realpathSync.native(dir), safeLabel(name ?? source));
    if (existsSync(target)) {
      // Le même contenu, déjà admis là (la même vidéo demandée deux fois) : rien à écrire. Un AUTRE contenu n'écrase jamais.
      if (lstatSync(target).isFile() && sha256(readFileSync(target)) === verdict.record.id) return target;
      throw new QuarantineError("la destination existe déjà : rien n'est écrasé");
    }
    writeFileSync(target, bytes);
    if (sha256(readFileSync(target)) !== verdict.record.id) {
      rmSync(target, { force: true });
      throw new QuarantineError("la copie ne correspond pas à l'empreinte : retirée");
    }
    return target;
  }

  /** Détruit le contenu ; la trace (empreinte, provenance, statut) reste. */
  delete(id: string): QuarantineRecord {
    const record = this.load(id);
    rmSync(this.blob(id), { force: true });
    record.status = "deleted";
    this.save(record);
    this.emit(id, "delete");
    return record;
  }
}
