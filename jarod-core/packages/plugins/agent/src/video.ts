/**
 * Cockpit, lot 7 — HyperFrames : le RENDU d'une composition vidéo (HTML) en fichier, piloté par l'agent comme une TÂCHE de la porte
 * unique : accord sur l'action résolue (projet, sortie), progression (lignes de la commande), annulation (le signal de la tâche tue
 * l'arbre de processus), délai borné, PREUVE (le fichier relu par ffprobe : durée, dimensions, codec), artefact « video ».
 *
 * Seule la commande locale `hyperframes render` est lancée (jamais `cloud`, `deploy`, `auth`) ; télémétrie coupée ; aucun argument
 * libre du modèle : projet et sortie confinés au dossier de travail, format, qualité et images/s pris dans des listes fermées.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, join, relative } from "node:path";
import { killTree } from "@jarod/kernel/util";
import { type ArtifactStore, inWorkspace } from "./artifacts.js";

export const VIDEO_FORMATS: Record<string, string> = { ".mp4": "mp4", ".webm": "webm", ".mov": "mov", ".gif": "gif" };
const QUALITIES = ["draft", "standard", "high"] as const;
const FPS = [24, 25, 30, 60] as const;
const RENDER_TIMEOUT_MS = 30 * 60_000;

/** Lance un programme (un `.cmd` passe par cmd.exe, arguments constants ou validés) ; rend le code, la sortie, et suit les lignes. */
export type Runner = (file: string, args: string[], o: { cwd: string; signal?: AbortSignal; timeoutMs: number; onLine?: (line: string) => void }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean; aborted?: boolean }>;

export const realRunner: Runner = (file, args, o) =>
  new Promise((resolve) => {
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    let child: ChildProcess;
    try {
      child = spawn(viaCmd ? (process.env.ComSpec ?? "cmd.exe") : file, viaCmd ? ["/d", "/c", file, ...args] : args, {
        cwd: o.cwd,
        windowsHide: true,
        env: { ...process.env, DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1" },
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const feed = (chunk: Buffer, into: "out" | "err") => {
      const text = chunk.toString("utf8");
      if (into === "out") stdout = (stdout + text).slice(-200_000);
      else stderr = (stderr + text).slice(-200_000);
      for (const line of text.split(/\r?\n|\r/)) if (line.trim()) o.onLine?.(line.trim());
    };
    child.stdout?.on("data", (c: Buffer) => feed(c, "out"));
    child.stderr?.on("data", (c: Buffer) => feed(c, "err"));
    const timer = setTimeout(() => ((timedOut = true), killTree(child)), o.timeoutMs);
    const onAbort = () => ((aborted = true), killTree(child));
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => (stderr += e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}) });
    });
  });

/** Un programme du PATH (extensions de PATHEXT sous Windows), ou null. */
export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext.toLowerCase());
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export interface VideoDeps {
  artifacts: ArtifactStore;
  run?: Runner;
  /** Les programmes (tests) ; défaut : le PATH. */
  which?: (name: string) => string | null;
}

/** Ce que ffprobe dit d'un fichier vidéo : durée, dimensions, codec — ou null s'il ne le lit pas. */
export async function probeVideo(file: string, d: Pick<VideoDeps, "run" | "which">, signal?: AbortSignal): Promise<{ duration: number; width: number; height: number; codec: string } | null> {
  const ffprobe = (d.which ?? findProgram)("ffprobe");
  if (!ffprobe) return null;
  const r = await (d.run ?? realRunner)(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", file], { cwd: process.cwd(), timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: { codec_name?: string; width?: number; height?: number }[] };
    const v = (j.streams ?? []).find((s) => s.width);
    const duration = Number(j.format?.duration);
    return v && Number.isFinite(duration) ? { duration, width: v.width ?? 0, height: v.height ?? 0, codec: v.codec_name ?? "?" } : null;
  } catch {
    return null;
  }
}

export function videoTools(d: VideoDeps) {
  const run = d.run ?? realRunner;
  const which = d.which ?? ((n: string) => findProgram(n));
  return [
    {
      name: "video_render",
      description:
        "Rend une composition HyperFrames (dossier de projet du dossier de travail) en vidéo locale (mp4, webm, mov, gif) avec `hyperframes render`. Accord demandé ; progression et annulation dans Réglages › Tâches ; le fichier est vérifié (ffprobe) et enregistré comme artefact.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Dossier du projet HyperFrames, dans le dossier de travail." },
          output: { type: "string", description: "Fichier de sortie (.mp4, .webm, .mov, .gif), dans le dossier de travail." },
          quality: { type: "string", enum: [...QUALITIES] },
          fps: { type: "integer", enum: [...FPS] },
        },
        required: ["project", "output"],
      },
      dangerous: true,
      source: "builtin" as const,
      targetOf: (args: Record<string, unknown>) => (typeof args.output === "string" ? args.output : undefined),
      precheck(args: Record<string, unknown>, ctx: { workspace: string | null }) {
        const project = inWorkspace(ctx.workspace, args.project);
        const output = inWorkspace(ctx.workspace, args.output);
        if (!existsSync(project) || !statSync(project).isDirectory()) throw new Error(`${String(args.project)} n'est pas un dossier de projet.`);
        if (!VIDEO_FORMATS[extname(output).toLowerCase()]) throw new Error("Sortie : .mp4, .webm, .mov ou .gif.");
        if (!which("hyperframes")) throw new Error("HyperFrames n'est pas installé (commande hyperframes introuvable) : rien n'est lancé.");
        return `Rendre la vidéo ${relative(ctx.workspace!, project) || "."} → ${relative(ctx.workspace!, output)} (HyperFrames, local)`;
      },
      async run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }) {
        const project = inWorkspace(ctx.workspace, args.project);
        const output = inWorkspace(ctx.workspace, args.output);
        const format = VIDEO_FORMATS[extname(output).toLowerCase()];
        const hf = which("hyperframes");
        if (!format || !hf) throw new Error("Rendu impossible : format ou HyperFrames manquant.");
        const argv = ["render", "--output", output, "--format", format, "--quiet"];
        if (typeof args.quality === "string" && (QUALITIES as readonly string[]).includes(args.quality)) argv.push("--quality", args.quality);
        if (typeof args.fps === "number" && (FPS as readonly number[]).includes(args.fps)) argv.push("--fps", String(args.fps));
        const r = await run(hf, argv, { cwd: project, timeoutMs: RENDER_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (r.aborted) throw new Error("Rendu annulé.");
        if (r.timedOut) throw new Error("Rendu arrêté : délai de 30 min dépassé.");
        if (r.code !== 0) throw new Error(`hyperframes render a échoué (code ${String(r.code)}) : ${(r.stderr || r.stdout).trim().slice(-1500)}`);
        if (!existsSync(output)) throw new Error("hyperframes render a terminé sans produire le fichier attendu.");
        const a = d.artifacts.register({ sessionId: ctx.sessionId, kind: "video", title: relative(ctx.workspace!, output), path: output, sourcePath: project, origin: "video_render", meta: { format, ...(args.quality ? { quality: args.quality } : {}), ...(args.fps ? { fps: args.fps } : {}) } });
        return JSON.stringify({ output: relative(ctx.workspace!, output), bytes: a.bytes, artifact: a.id });
      },
      // Preuve : le fichier relu par ffprobe a une durée et une image ; sans ffprobe, la vérification est dite impossible (taille seule).
      async verify(_args: Record<string, unknown>, out: string, ctx: { workspace: string | null; signal?: AbortSignal }) {
        const o = JSON.parse(out) as { output: string };
        const file = inWorkspace(ctx.workspace, o.output);
        if (!existsSync(file) || statSync(file).size === 0) return { status: "failed" as const, evidence: `${o.output} absent ou vide` };
        const meta = await probeVideo(file, d, ctx.signal);
        if (!meta) return which("ffprobe") ? { status: "failed" as const, evidence: `${o.output} : ffprobe n'y lit pas de vidéo` } : { status: "unverifiable" as const, evidence: `ffprobe absent : ${o.output} existe (${statSync(file).size} octets), contenu non vérifié` };
        return meta.duration > 0 && meta.width > 0
          ? { status: "verified" as const, evidence: `${o.output} : ${meta.duration.toFixed(2)} s, ${meta.width}×${meta.height}, ${meta.codec}` }
          : { status: "failed" as const, evidence: `${o.output} : durée ou dimensions nulles` };
      },
    },
  ];
}
