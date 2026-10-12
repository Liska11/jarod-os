// Outils système (phase 1, lecture seule) : l'exécuteur PowerShell. Repris de `winps.py` de Herald OS (MIT, plugins/herald-os-bridge) :
// chaque script part en `-EncodedCommand` (aucune citation à rater) et reçoit ses arguments en JSON dans une variable d'environnement,
// lus dans `$A` ; le texte d'un utilisateur ou d'un modèle n'entre donc JAMAIS dans la source du script. Sortie : JSON UTF-8 sur stdout ;
// un échec = une ligne sur stderr et le code 1. Windows PowerShell 5.1 (présent sur tout Windows 10/11), jamais `pwsh` : on ne dépend
// pas de ce que `PATH` désigne en premier.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$A = $null
if ($env:JAROD_OS_ARGS) { $A = $env:JAROD_OS_ARGS | ConvertFrom-Json }
try {
`;
const POSTLUDE = String.raw`
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/** La ligne de commande est plafonnée à 32 767 caractères et le base64 UTF-16 fait 2,7 fois la source. */
export const MAX_SCRIPT_CHARS = 11_000;

/** Le script a échoué ; le message est la ligne qu'il a écrite sur stderr. */
export class PowerShellError extends Error {}

/** Ce qu'un outil demande à PowerShell : un script, ses arguments, un délai. Remplaçable dans les tests. */
export interface PsRunner {
  /** Exécute `script` et rend son stdout analysé comme JSON (`null` si rien n'a été écrit). */
  json(script: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<unknown>;
}

/** Windows PowerShell par chemin absolu, ou `null`. */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  const candidate = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : null;
}

export function buildArgv(script: string): string[] {
  const body = PRELUDE + script + POSTLUDE;
  if (body.length > MAX_SCRIPT_CHARS) throw new PowerShellError(`Script PowerShell trop long (${body.length} caractères)`);
  const encoded = Buffer.from(body, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
}

/** Le vrai exécuteur : un processus `powershell.exe` par appel, arrêté à l'échéance ou si l'appel est interrompu. */
export function realPsRunner(exe: string | null = powershellExe()): PsRunner {
  return {
    json(script, args, opts = {}) {
      return new Promise((resolve, reject) => {
        if (!exe) return reject(new PowerShellError("Windows PowerShell est introuvable"));
        let argv: string[];
        try {
          argv = buildArgv(script);
        } catch (e) {
          return reject(e);
        }
        const timeoutMs = opts.timeoutMs ?? 20_000;
        const child = spawn(exe, argv, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...(args ? { JAROD_OS_ARGS: JSON.stringify(args) } : {}) },
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const kill = () => {
          try {
            child.kill();
          } catch {
            // Déjà terminé.
          }
        };
        const timer = setTimeout(() => {
          kill();
          done(() => reject(new PowerShellError(`PowerShell a dépassé ${Math.round(timeoutMs / 1000)} s`)));
        }, timeoutMs);
        const onAbort = () => {
          kill();
          done(() => reject(new PowerShellError("Interrompu")));
        };
        if (opts.signal?.aborted) return onAbort();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stderr.on("data", (c: Buffer) => err.push(c));
        child.on("error", (e) => done(() => reject(new PowerShellError(e.message))));
        child.on("close", (code) =>
          done(() => {
            if (code !== 0) {
              const line = Buffer.concat(err).toString("utf8").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
              return reject(new PowerShellError(line || `PowerShell a quitté avec le code ${String(code)}`));
            }
            const text = Buffer.concat(out).toString("utf8").trim().replace(/^\uFEFF/, "");
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text));
            } catch (e) {
              reject(new PowerShellError(`PowerShell a rendu un JSON illisible : ${(e as Error).message}`));
            }
          }),
        );
      });
    },
  };
}

/** `ConvertTo-Json` écrit un objet seul là où il y a un seul élément : on normalise en liste. */
export function asList(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
}
