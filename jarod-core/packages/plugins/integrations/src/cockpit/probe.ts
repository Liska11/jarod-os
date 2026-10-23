/**
 * Sondes du registre de capacités : ce qu'elles ont le droit de faire, et rien d'autre.
 *
 *  - lire l'existence d'un fichier, lire un petit fichier texte de version ;
 *  - chercher un programme dans le PATH (avec PATHEXT sous Windows) ;
 *  - lancer le PROGRAMME D'UNE INTÉGRATION avec des arguments CONSTANTS de diagnostic (`--version`, `--help`, `-version`),
 *    sans shell, avec un délai court. Jamais un argument venu du modèle, jamais un binaire cible (une sonde n'analyse rien).
 *
 * Tout passe par `ProbeHost`, que les tests remplacent : les tests « simulés » et « réels » sont séparés par l'hôte, pas par des drapeaux.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ProbeResult } from "./types.js";
import { childEnv } from "@jarod/kernel/child-env";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Le délai a expiré : le processus a été tué. */
  timedOut?: boolean;
  /** Le lancement lui-même a échoué (ENOENT, EACCES…). */
  error?: string;
}

export interface ProbeHost {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  /** Petit fichier texte (≤ 64 Ko), `null` s'il est absent ou illisible. */
  readText(path: string): string | null;
  run(file: string, args: readonly string[], timeoutMs: number): Promise<RunResult>;
}

const MAX_READ = 64 * 1024;
const MAX_OUT = 16 * 1024;

/** L'hôte réel. `execFile` sans shell ; un `.cmd`/`.bat` (shims npm, scoop) passe par `cmd.exe /d /c` avec des arguments constants. */
export function nodeProbeHost(): ProbeHost {
  return {
    platform: process.platform,
    env: process.env,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    readText: (p) => {
      try {
        if (statSync(p).size > MAX_READ) return null;
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    run: (file, args, timeoutMs) =>
      new Promise((resolve) => {
        const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
        const exe = viaCmd ? (process.env.ComSpec ?? "cmd.exe") : file;
        const argv = viaCmd ? ["/d", "/c", file, ...args] : [...args];
        execFile(
          exe,
          argv,
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8", env: childEnv("engine", { explicit: { DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1" } }) },
          (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
            resolve({
              code: e ? (typeof e.code === "number" ? e.code : null) : 0,
              stdout: String(stdout ?? "").slice(0, MAX_OUT),
              stderr: String(stderr ?? "").slice(0, MAX_OUT),
              ...(e?.killed ? { timedOut: true } : {}),
              ...(e && typeof e.code === "string" ? { error: e.code } : {}),
            });
          },
        );
      }),
  };
}

/** Cherche un programme dans le PATH ; sous Windows, essaie les extensions de PATHEXT (et le nom nu en dernier). */
export function which(host: ProbeHost, name: string): string | null {
  const path = host.env.PATH ?? host.env.Path ?? "";
  const win = host.platform === "win32";
  const exts = win ? (host.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
  // Les chemins suivent la plateforme de l'HÔTE sondé, pas celle du processus (un hôte Windows simulé reste Windows sous Linux).
  const { delimiter: sep, join } = win ? win32 : posix;
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (host.exists(candidate)) return candidate;
    }
    if (win && /\.[a-z0-9]+$/i.test(name) && host.exists(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Le premier numéro de version d'un texte (`v1.2.3`, `1.2`, `12.1.4`). */
export function firstVersion(text: string): string | undefined {
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/.exec(text)?.[1];
}

export const notInstalled = (what: string, detail?: string): ProbeResult => ({ state: "not-installed", detail: detail ?? `${what} introuvable`, missing: [what] });

/** Un programme du PATH et sa version : non installé, en erreur (il ne répond pas), ou trouvé. */
export async function cli(host: ProbeHost, name: string, label: string, args: string[] = ["--version"]) {
  const file = which(host, name);
  if (!file) return { kind: "absent" as const, result: notInstalled(label, `${label} introuvable dans le PATH (${name})`) };
  return program(host, file, label, args);
}

/** Un programme à un chemin connu et sa version. */
export async function program(host: ProbeHost, file: string, _label: string, args: string[] = ["--version"]) {
  const v = await versionOf(host, file, args);
  if (!v.ok) return { kind: "error" as const, result: { state: "error", detail: v.why, found: [file] } as ProbeResult };
  return { kind: "ok" as const, file, version: v.version };
}

/** Lance `<prog> <args>` et rend sa version, ou la raison de l'échec — sans jamais lever. */
export async function versionOf(
  host: ProbeHost,
  file: string,
  args: readonly string[] = ["--version"],
  timeoutMs = 8000,
): Promise<{ ok: true; version?: string; text: string } | { ok: false; why: string }> {
  try {
    const r = await host.run(file, args, timeoutMs);
    if (r.timedOut) return { ok: false, why: `${file} ${args.join(" ")} : aucune réponse en ${timeoutMs} ms` };
    if (r.error) return { ok: false, why: `${file} : lancement impossible (${r.error})` };
    const text = `${r.stdout}\n${r.stderr}`.trim();
    if (r.code !== 0 && !text) return { ok: false, why: `${file} ${args.join(" ")} : code ${r.code}, aucune sortie` };
    const version = firstVersion(text);
    return { ok: true, text, ...(version ? { version } : {}) };
  } catch (e) {
    return { ok: false, why: `${file} : ${(e as Error).message}` };
  }
}
