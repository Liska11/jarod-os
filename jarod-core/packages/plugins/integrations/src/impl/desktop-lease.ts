/**
 * Un seul contrôleur actif par bureau (2026-10-21) : un bail posé dans un fichier du dossier temporaire de l'utilisateur — donc commun à tous les
 * processus Jarod de cette session Windows (bureau, `jarod serve`, autre profil). Le bail porte le processus et la conversation qui pilotent ; une
 * autre conversation, ou un autre processus, est refusée tant que le bail est vivant. Il expire après une inactivité (`idleMs`) ou quand son
 * processus est mort ; l'arrêt d'urgence le libère. Création exclusive (`wx`) : deux prétendants simultanés ne l'obtiennent pas tous les deux.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LeaseHolder {
  pid: number;
  session: string;
  /** Dernière activité (ms). */
  at: number;
}

export const DEFAULT_LEASE_FILE = join(tmpdir(), "jarod-desktop-controller.lock");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class DesktopLease {
  constructor(
    private readonly file = DEFAULT_LEASE_FILE,
    private readonly idleMs = 120_000,
    private readonly now: () => number = Date.now,
    private readonly pid = process.pid,
  ) {}

  /** Le détenteur vivant du bail, ou null (absent, illisible, échu, processus mort). */
  holder(): LeaseHolder | null {
    let h: LeaseHolder;
    try {
      h = JSON.parse(readFileSync(this.file, "utf8")) as LeaseHolder;
    } catch {
      return null;
    }
    if (typeof h?.pid !== "number" || typeof h.session !== "string" || typeof h.at !== "number") return null;
    if (this.now() - h.at > this.idleMs || !alive(h.pid)) return null;
    return h;
  }

  /** Prend (ou renouvelle) le bail pour cette conversation ; lève avec le nom du détenteur si un autre pilote. */
  acquire(session: string): void {
    const h = this.holder();
    if (h && (h.pid !== this.pid || h.session !== session)) {
      const left = Math.max(1, Math.ceil((this.idleMs - (this.now() - h.at)) / 1000));
      throw new Error(
        `un autre contrôleur pilote déjà ce bureau (${h.pid === this.pid ? "une autre conversation de Jarod" : `processus ${h.pid}`}, conversation ${h.session}) ; il se libère après ${left} s d'inactivité ou par l'arrêt d'urgence (Ctrl+Alt+Fin)`,
      );
    }
    const body = JSON.stringify({ pid: this.pid, session, at: this.now() } satisfies LeaseHolder);
    if (h) {
      writeFileSync(this.file, body); // renouvellement par le détenteur lui-même
      return;
    }
    rmSync(this.file, { force: true }); // bail échu ou orphelin
    try {
      writeFileSync(this.file, body, { flag: "wx" });
    } catch {
      throw new Error("un autre contrôleur vient de prendre ce bureau ; réessayer plus tard");
    }
  }

  /** Rend le bail s'il est à ce processus (et à cette conversation, si elle est donnée). */
  release(session?: string): void {
    const h = this.holder();
    if (h && h.pid === this.pid && (session === undefined || h.session === session)) rmSync(this.file, { force: true });
  }
}
