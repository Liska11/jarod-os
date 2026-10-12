/**
 * Priorité de la voix (SPECS-P5-VOIX-PRIORITAIRE.md, validée le 2026-10-01) — Jarod-cordis, nouveau.
 *
 * La voix est « active » de la détection du mot d'activation (la capture passe à `recording`) à la fin de la transcription
 * (retour à `listening`), et pendant tout appel de transcription hors capture (bouton micro du chat, messages vocaux).
 * L'écoute passive (`listening`) ne compte JAMAIS : elle est continue, la compter suspendrait l'ingestion en permanence.
 *
 * Reprise garantie : l'état est DÉRIVÉ de l'état de la capture et d'un compteur d'appels (`try/finally`) — il n'y a aucun
 * verrou à relâcher. Garde-fous d'horloge pour ce que l'état ne couvre pas seul (flux du micro interrompu en pleine écoute,
 * transcription qui ne rend pas la main) : la fenêtre se ferme d'office après `recordingCapMs` / `transcribingCapMs`, avec un
 * avertissement. Ce sont des garde-fous de sécurité, pas des réglages : l'ingestion ne doit jamais rester suspendue sur
 * une voix défaillante. Ils ne modifient PAS l'état de la capture.
 */
import type { VoicePriority } from "@jarod/contracts";
import type { CaptureState } from "./capture.js";

export interface PriorityConfig {
  /** Faux : la voix n'est jamais prioritaire (condition TÉMOIN du banc de contention). Défaut vrai. */
  enabled?: boolean;
  /** Plafond de la fenêtre en `recording` (défaut 20 000 ms = `maxMs` de la capture + 5 s). */
  recordingCapMs?: number;
  /** Plafond en `transcribing` ou d'un appel direct (défaut 130 000 ms : le délai de whisper est de 120 s). */
  transcribingCapMs?: number;
}

export const DEFAULT_RECORDING_CAP_MS = 20_000;
export const DEFAULT_TRANSCRIBING_CAP_MS = 130_000;

export class VoicePriorityGate implements VoicePriority {
  private readonly enabled: boolean;
  private readonly recCap: number;
  private readonly trCap: number;
  private state: CaptureState = "listening";
  private stateSince = 0;
  private seq = 0;
  private readonly direct = new Map<number, number>();
  private readonly waiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    cfg: PriorityConfig = {},
    private readonly warn: (line: string) => void = () => {},
  ) {
    this.enabled = cfg.enabled ?? true;
    this.recCap = cfg.recordingCapMs ?? DEFAULT_RECORDING_CAP_MS;
    this.trCap = cfg.transcribingCapMs ?? DEFAULT_TRANSCRIBING_CAP_MS;
  }

  get active(): boolean {
    return this.enabled && this.activeAt(Date.now());
  }

  private activeAt(t: number): boolean {
    if (this.state === "recording" && t - this.stateSince < this.recCap) return true;
    if (this.state === "transcribing" && t - this.stateSince < this.trCap) return true;
    for (const start of this.direct.values()) if (t - start < this.trCap) return true;
    return false;
  }

  /** Appelé à chaque changement d'état de la capture (`onState`). */
  onCaptureState(state: CaptureState): void {
    this.state = state;
    this.stateSince = Date.now();
    this.changed();
  }

  /** Enveloppe une transcription : la fenêtre est ouverte pendant l'appel, quoi qu'il arrive (`finally`). */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    const id = ++this.seq;
    this.direct.set(id, Date.now());
    this.changed();
    try {
      return await fn();
    } finally {
      this.direct.delete(id);
      this.changed();
    }
  }

  whenIdle(signal?: AbortSignal): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters.delete(done);
        reject(signal!.reason instanceof Error ? signal!.reason : new DOMException("Aborted", "AbortError"));
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Libère tout le monde et arrête le minuteur (fermeture du plugin). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  private changed(): void {
    if (!this.active) {
      const ws = [...this.waiters];
      this.waiters.clear();
      for (const w of ws) w();
    }
    this.arm();
  }

  /** Prochaine échéance d'un plafond, pour réveiller les attentes même si plus rien n'arrive. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    const now = Date.now();
    const ends: number[] = [];
    if (this.state === "recording") ends.push(this.stateSince + this.recCap);
    if (this.state === "transcribing") ends.push(this.stateSince + this.trCap);
    for (const start of this.direct.values()) ends.push(start + this.trCap);
    const next = Math.min(...ends.filter((e) => e > now));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => this.onCap(), next - now + 1);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private onCap(): void {
    this.timer = null;
    const now = Date.now();
    const closed: string[] = [];
    if (this.state === "recording" && now - this.stateSince >= this.recCap) closed.push(`écoute (${this.recCap} ms)`);
    if (this.state === "transcribing" && now - this.stateSince >= this.trCap) closed.push(`transcription (${this.trCap} ms)`);
    if ([...this.direct.values()].some((s) => now - s >= this.trCap)) closed.push(`appel de transcription (${this.trCap} ms)`);
    if (closed.length) this.warn(`voix prioritaire : fenêtre fermée d'office après le plafond — ${closed.join(", ")}`);
    this.changed();
  }
}
