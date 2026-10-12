/**
 * Faits de machine et trace thermique pour les rapports de banc (piste R3, `docs/RECUPERABLE-ECOSYSTEME-2026-10.md`).
 *
 * Idée reprise de la discipline de Magnitude (`design/inference/benchmarking.md`) : un chiffre de banc se lit avec la machine qui l'a
 * produit (OS, pilote, GPU, mémoire) et avec la température pendant la mesure. Règles reprises :
 *  - une sonde qui échoue reste une ERREUR nommée, jamais un zéro ni une température inventée ;
 *  - les moyennes sont pondérées par le temps et excluent les trous (la couverture est affichée) ;
 *  - l'échantillonnage a un coût (un appel à `nvidia-smi`) qui n'est PAS soustrait des mesures ;
 *  - enregistrer n'impose aucune règle de refroidissement et ne prouve pas que deux runs sont thermiquement comparables.
 * Ce module ne change AUCUN seuil et n'est branché sur aucun banc existant (les bancs gelés ne sont pas modifiés) : les nouveaux bancs l'appellent.
 */
import { execFile } from "node:child_process";
import { arch, cpus, hostname, platform, release, totalmem, version as osVersion } from "node:os";

export type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GpuReading {
  index: number;
  name: string;
  driverVersion: string | null;
  temperatureC: number | null;
  utilizationPct: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  smClockMHz: number | null;
  powerW: number | null;
}

export interface HostFacts {
  collectedAt: string;
  hostname: string;
  os: { platform: string; release: string; version: string; arch: string };
  node: string;
  cpu: { model: string | null; logicalCores: number };
  ramBytes: number;
  gpus: Probe<GpuReading[]>;
}

export type Runner = (cmd: string, args: string[]) => Promise<string>;

export const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,memory.used,memory.total,clocks.sm,power.draw",
  "--format=csv,noheader,nounits",
];

/** Exécute une commande sans shell, avec un délai ; rejette avec le message de l'erreur. */
export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} : ${(stderr || err.message).toString().trim().slice(0, 300)}`));
      else resolve(stdout.toString());
    });
  });

/** `[N/A]`, `N/A`, vide ou non numérique → null. Jamais 0. */
function num(raw: string | undefined): number | null {
  const t = (raw ?? "").trim();
  if (t === "" || /^\[?n\/a\]?$/i.test(t) || /^\[?not supported\]?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function text(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  return t === "" || /^\[?n\/a\]?$/i.test(t) ? null : t;
}

/** Sortie de `nvidia-smi --query-gpu=… --format=csv,noheader,nounits` → une lecture par GPU. Lève si une ligne est mal formée. */
export function parseNvidiaSmiCsv(out: string): GpuReading[] {
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("nvidia-smi : sortie vide");
  return lines.map((line) => {
    const c = line.split(",").map((x) => x.trim());
    if (c.length !== 9) throw new Error(`nvidia-smi : ${c.length} colonnes au lieu de 9 dans « ${line.slice(0, 80)} »`);
    const index = num(c[0]);
    if (index === null) throw new Error(`nvidia-smi : indice de GPU illisible dans « ${line.slice(0, 80)} »`);
    return {
      index,
      name: c[1] || "(sans nom)",
      driverVersion: text(c[2]),
      temperatureC: num(c[3]),
      utilizationPct: num(c[4]),
      memoryUsedMiB: num(c[5]),
      memoryTotalMiB: num(c[6]),
      smClockMHz: num(c[7]),
      powerW: num(c[8]),
    };
  });
}

export async function probeGpus(run: Runner = defaultRunner): Promise<Probe<GpuReading[]>> {
  try {
    return { ok: true, value: parseNvidiaSmiCsv(await run("nvidia-smi", NVIDIA_SMI_ARGS)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function collectHostFacts(run: Runner = defaultRunner, now: () => number = Date.now): Promise<HostFacts> {
  const cores = cpus();
  return {
    collectedAt: new Date(now()).toISOString(),
    hostname: hostname(),
    os: { platform: platform(), release: release(), version: osVersion(), arch: arch() },
    node: process.version,
    cpu: { model: cores[0]?.model?.trim() || null, logicalCores: cores.length },
    ramBytes: totalmem(),
    gpus: await probeGpus(run),
  };
}

// ---------------------------------------------------------------------------------------------- trace thermique

export interface ThermalSample {
  /** Millisecondes depuis l'époque, relevées AVANT l'appel de la sonde. */
  at: number;
  /** Durée de la sonde, en ms (non soustraite des mesures du banc). */
  probeMs: number;
  gpus: Probe<GpuReading[]>;
}

export interface Extrema {
  min: number;
  max: number;
  /** Moyenne pondérée par le temps ; chaque lecture vaut jusqu'à la suivante (la dernière jusqu'à la fin). */
  timeWeightedMean: number;
  /** Part de l'intervalle [premier échantillon ; fin] couverte par une lecture valide, entre 0 et 1. */
  coverage: number;
  samples: number;
}

export interface GpuThermalSummary {
  index: number;
  name: string;
  temperatureC: Extrema | null;
  powerW: Extrema | null;
  smClockMHz: Extrema | null;
}

export interface ThermalSummary {
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  samples: number;
  failedProbes: number;
  /** Messages d'erreur distincts, dans l'ordre d'apparition. */
  errors: string[];
  probeMsTotal: number;
  gpus: GpuThermalSummary[];
}

function extrema(points: { at: number; v: number | null }[], endedAt: number): Extrema | null {
  const valid = points.filter((p): p is { at: number; v: number } => p.v !== null);
  if (valid.length === 0) return null;
  const startedAt = points[0]!.at;
  const span = endedAt - startedAt;
  let weighted = 0;
  let covered = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.v === null) continue;
    const until = i + 1 < points.length ? points[i + 1]!.at : endedAt;
    const dt = Math.max(0, until - p.at);
    weighted += p.v * dt;
    covered += dt;
  }
  const values = valid.map((p) => p.v);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    // Un seul instant (durée nulle) : la moyenne est la valeur elle-même, la couverture est celle de l'instant.
    timeWeightedMean: covered > 0 ? weighted / covered : values[0]!,
    coverage: span > 0 ? Math.min(1, covered / span) : 1,
    samples: valid.length,
  };
}

/** Résume une trace. `endedAt` borne le dernier échantillon ; sans échantillon, tout est vide (rien n'est inventé). */
export function summarizeThermal(samples: ThermalSample[], endedAt: number): ThermalSummary {
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  const errors: string[] = [];
  let failed = 0;
  for (const s of ordered) {
    if (!s.gpus.ok) {
      failed++;
      if (!errors.includes(s.gpus.error)) errors.push(s.gpus.error);
    }
  }
  const byGpu = new Map<number, { name: string; rows: { at: number; r: GpuReading | null }[] }>();
  for (const s of ordered) {
    const seenNow = new Set<number>();
    if (s.gpus.ok) {
      for (const r of s.gpus.value) {
        const g = byGpu.get(r.index) ?? { name: r.name, rows: [] };
        g.name = r.name;
        g.rows.push({ at: s.at, r });
        byGpu.set(r.index, g);
        seenNow.add(r.index);
      }
    }
    // Un échantillon en échec ou sans ce GPU laisse un TROU (lecture absente), pas un zéro.
    for (const [index, g] of byGpu) if (!seenNow.has(index)) g.rows.push({ at: s.at, r: null });
  }
  const end = ordered.length ? Math.max(endedAt, ordered[ordered.length - 1]!.at) : endedAt;
  const gpus = [...byGpu.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, g]) => {
      const pts = (pick: (r: GpuReading) => number | null) => g.rows.map((x) => ({ at: x.at, v: x.r ? pick(x.r) : null }));
      return {
        index,
        name: g.name,
        temperatureC: extrema(pts((r) => r.temperatureC), end),
        powerW: extrema(pts((r) => r.powerW), end),
        smClockMHz: extrema(pts((r) => r.smClockMHz), end),
      };
    });
  const startedAt = ordered[0]?.at ?? null;
  return {
    startedAt,
    endedAt: ordered.length ? end : null,
    durationMs: startedAt === null ? 0 : end - startedAt,
    samples: ordered.length,
    failedProbes: failed,
    errors,
    probeMsTotal: ordered.reduce((n, s) => n + s.probeMs, 0),
    gpus,
  };
}

/**
 * Trace d'un banc : `sample()` avant la mise en place, périodiquement (`start`), puis après le nettoyage.
 * L'échantillonnage se fait HORS des opérations chronométrées ; son coût est consigné (`probeMs`), jamais soustrait.
 */
export class ThermalTrace {
  private readonly samples: ThermalSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly now: () => number = Date.now,
  ) {}

  async sample(): Promise<void> {
    const at = this.now();
    const gpus = await probeGpus(this.run);
    this.samples.push({ at, probeMs: Math.max(0, this.now() - at), gpus });
  }

  /** Démarre l'échantillonnage périodique (un seul échantillon à la fois ; un tour en retard est sauté, pas empilé). */
  start(intervalMs: number): void {
    if (this.timer) throw new Error("ThermalTrace : déjà démarrée");
    if (!(intervalMs >= 250)) throw new Error("ThermalTrace : intervalle minimal 250 ms (chaque sonde lance un processus)");
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.sample().finally(() => (this.inFlight = null));
    }, intervalMs);
    // Ne retient pas le processus du banc si l'appelant oublie d'arrêter.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Arrête, prend un dernier échantillon, rend le résumé et les lectures brutes. */
  async stop(): Promise<{ summary: ThermalSummary; samples: ThermalSample[] }> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
    await this.sample();
    return { summary: summarizeThermal(this.samples, this.now()), samples: [...this.samples] };
  }
}
