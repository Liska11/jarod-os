/**
 * G5 — le TEXTE d'une vidéo en ligne par yt-dlp (yt-dlp/yt-dlp) : URL autorisée → métadonnées, sous-titres ou audio → traitement local.
 *
 *  - URL http(s) seulement ; jamais d'identifiants dans l'adresse ; hôte privé ou de bouclage refusé (SSRF) — sauf l'option de test
 *    `allowPrivateHosts`, qu'aucun argument de l'agent ne peut régler. La requête (`?…`) n'est jamais reprise dans un résultat ni un journal.
 *  - Jamais de cookies : `--no-cookies`, `--no-cookies-from-browser` ; aucune configuration lue (`--ignore-config`) ; une seule vidéo
 *    (`--no-playlist`, `--playlist-items 1`) ; pas de direct ; durée, taille et espace disque bornés AVANT le téléchargement.
 *  - L'outil de l'agent est dans INTERNET_TOOLS du noyau : hors ligne, il est refusé avant toute demande d'accord. Le programme yt-dlp
 *    lui-même n'est pas coupé du réseau par une barrière (limite X-04) : c'est la porte qui décide qu'il ne démarre pas.
 *  - Le texte rendu dit son ORIGINE : sous-titres « originaux » (déposés par l'auteur), « automatiques » (générés par la plateforme), ou
 *    aucun (audio seul, à transcrire localement). Rien n'est dit des images : seul le texte est traité.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export type MediaMode = "metadata" | "subtitles" | "audio";

export interface MediaLimits {
  /** Durée maximale de la vidéo (s). */
  maxDurationSec: number;
  /** Taille maximale d'un fichier téléchargé (octets). */
  maxBytes: number;
  /** Espace libre à laisser sur le disque après téléchargement (octets). */
  minFreeBytes: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = { maxDurationSec: 4 * 3600, maxBytes: 300 * 1024 * 1024, minFreeBytes: 2 * 1024 * 1024 * 1024 };

export interface MediaInfo {
  title: string;
  uploader?: string;
  durationSec?: number;
  isLive: boolean;
  /** Origine + chemin, sans requête. */
  page: string;
  subtitles: string[];
  automaticCaptions: string[];
}

export interface MediaResult {
  info: MediaInfo;
  mode: MediaMode;
  textOrigin: "original" | "automatique" | "aucun";
  language?: string;
  /** Texte des sous-titres, sans horodatage ni balises ; absent en mode métadonnées ou audio. */
  text?: string;
  /** Fichier écrit (sous-titres ou audio). */
  file?: string;
  note: string;
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Adresse rendue sans requête ni fragment (pour un résultat ou un journal). */
export const safeUrl = (u: URL) => `${u.origin}${u.pathname}`;

export function checkMediaUrl(raw: string, allowPrivateHosts = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AdapterRefused("G5", "adresse invalide");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AdapterRefused("G5", "seuls http et https sont permis");
  if (u.username || u.password) throw new AdapterRefused("G5", "identifiants interdits dans l'adresse");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (isIP(host) === 4 && PRIVATE_V4.some((r) => r.test(host))) || (isIP(host) === 6 && /^(::1?|f[cd]|fe80)/.test(host));
  if (local && !allowPrivateHosts) throw new AdapterRefused("G5", `hôte local ou privé refusé : ${host}`);
  return u;
}

/** yt-dlp : JAROD_YTDLP, sinon JAROD_ENGINES_DIR\yt-dlp\yt-dlp.exe. */
export function ytdlpBinary(env: Record<string, string | undefined> = process.env): string | null {
  const c = [env.JAROD_YTDLP, env.JAROD_ENGINES_DIR && join(env.JAROD_ENGINES_DIR, "yt-dlp", "yt-dlp.exe")].filter((x): x is string => Boolean(x));
  return c.find((p) => existsSync(p)) ?? null;
}

// Une seule vidéo par `--playlist-items 1` : mesuré sur 2026.08.19, `--max-downloads 1` arrête AVANT d'écrire les métadonnées (code 101).
const BASE_ARGS = ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist", "--playlist-items", "1","--no-mtime", "--restrict-filenames", "--no-warnings"];
const ENV_KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return env;
}

function info(bin: string, url: URL, signal?: AbortSignal): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...BASE_ARGS, "--skip-download", "--dump-single-json", url.href], { env: childEnv(), windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      if (err) {
        if ((err as Error).name === "AbortError") return reject(new AdapterRefused("G5", "annulé"));
        return reject(new AdapterUnavailable("G5", `lecture des métadonnées impossible : ${String(stderr || (err as Error).message).replaceAll(url.href, safeUrl(url)).slice(0, 400)}`));
      }
      try {
        const j = JSON.parse(stdout) as { title?: string; uploader?: string; duration?: number; is_live?: boolean; live_status?: string; subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown> };
        resolve({
          title: String(j.title ?? "(sans titre)"),
          ...(j.uploader ? { uploader: String(j.uploader) } : {}),
          ...(typeof j.duration === "number" ? { durationSec: j.duration } : {}),
          isLive: j.is_live === true || j.live_status === "is_live",
          page: safeUrl(url),
          subtitles: Object.keys(j.subtitles ?? {}).filter((k) => k !== "live_chat"),
          automaticCaptions: Object.keys(j.automatic_captions ?? {}),
        });
      } catch {
        reject(new AdapterUnavailable("G5", "métadonnées illisibles"));
      }
    });
  });
}

/** Choix de la piste : originale d'abord, automatique seulement si permis ; jamais l'une prise pour l'autre. */
export function pickTrack(i: MediaInfo, langs: string[], allowAuto: boolean): { lang: string; origin: "original" | "automatique" } | null {
  const want = (avail: string[]) => langs.map((l) => avail.find((a) => a === l || a.startsWith(`${l}-`))).find((x): x is string => Boolean(x));
  const orig = want(i.subtitles);
  if (orig) return { lang: orig, origin: "original" };
  if (allowAuto) {
    const auto = want(i.automaticCaptions);
    if (auto) return { lang: auto, origin: "automatique" };
  }
  return null;
}

/** Texte d'un fichier WebVTT ou SRT, sans en-tête, horodatages, numéros, balises ni répétitions consécutives. */
export function subtitleText(raw: string): string {
  const out: string[] = [];
  for (const line of raw.replace(/^﻿/, "").split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l === "WEBVTT" || /^(Kind|Language|NOTE|STYLE|REGION)\b/.test(l) || /^\d+$/.test(l) || /-->/.test(l)) continue;
    const text = l.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (text && out.at(-1) !== text) out.push(text);
  }
  return out.join("\n");
}

function download(bin: string, args: string[], url: URL, signal: AbortSignal | undefined, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...BASE_ARGS, "--newline", ...args, url.href], { env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      for (const m of d.toString("utf8").matchAll(/\[download\]\s+([\d.]+)%/g)) onProgress?.(Number(m[1]));
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-4000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new AdapterRefused("G5", "annulé"));
      if (code === 0) return resolve();
      reject(new AdapterUnavailable("G5", `téléchargement impossible (code ${code}) : ${err.replaceAll(url.href, safeUrl(url)).slice(-400)}`));
    });
  });
}

export async function fetchMediaText(o: {
  bin: string;
  url: string;
  mode: MediaMode;
  outDir: string;
  langs?: string[];
  allowAuto?: boolean;
  limits?: Partial<MediaLimits>;
  allowPrivateHosts?: boolean;
  signal?: AbortSignal;
  onProgress?: (pct: number) => void;
}): Promise<MediaResult> {
  const limits = { ...DEFAULT_MEDIA_LIMITS, ...o.limits };
  const url = checkMediaUrl(o.url, o.allowPrivateHosts === true);
  const i = await info(o.bin, url, o.signal);
  if (i.isLive) throw new AdapterRefused("G5", "diffusion en direct refusée");
  if (i.durationSec !== undefined && i.durationSec > limits.maxDurationSec) throw new AdapterRefused("G5", `durée ${Math.round(i.durationSec)} s au-delà de la limite (${limits.maxDurationSec} s)`);
  if (o.mode === "metadata") return { info: i, mode: "metadata", textOrigin: "aucun", note: "métadonnées seulement ; aucun fichier écrit" };

  mkdirSync(o.outDir, { recursive: true });
  const fs = statfsSync(o.outDir);
  const free = Number(fs.bavail) * Number(fs.bsize);
  if (free - limits.maxBytes < limits.minFreeBytes) throw new AdapterRefused("G5", `espace disque insuffisant (${Math.round(free / 1048576)} Mo libres)`);
  const before = new Set(readdirSync(o.outDir));
  const fresh = () => readdirSync(o.outDir).filter((f) => !before.has(f) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
  const common = ["-P", o.outDir, "-o", "%(id)s.%(ext)s", "--max-filesize", String(limits.maxBytes), "--match-filters", `!is_live & duration <=? ${limits.maxDurationSec}`];

  if (o.mode === "subtitles") {
    const track = pickTrack(i, o.langs?.length ? o.langs : ["fr", "en"], o.allowAuto === true);
    if (!track) {
      const why = i.automaticCaptions.length && !o.allowAuto ? "seuls des sous-titres automatiques existent (non demandés)" : "aucun sous-titre dans les langues demandées";
      return { info: i, mode: "subtitles", textOrigin: "aucun", note: `${why} ; l'audio peut être téléchargé puis transcrit localement` };
    }
    await download(o.bin, ["--skip-download", track.origin === "original" ? "--write-subs" : "--write-auto-subs", "--sub-langs", track.lang, "--sub-format", "vtt/srt/best", ...common], url, o.signal, o.onProgress);
    const file = fresh().find((f) => f.includes(`.${track.lang}.`));
    if (!file) throw new AdapterUnavailable("G5", "sous-titres annoncés mais aucun fichier écrit");
    const path = join(o.outDir, file);
    return { info: i, mode: "subtitles", textOrigin: track.origin, language: track.lang, text: subtitleText(readFileSync(path, "utf8")), file: path, note: track.origin === "automatique" ? "sous-titres générés automatiquement par la plateforme : erreurs possibles" : "sous-titres déposés avec la vidéo" };
  }

  await download(o.bin, ["-f", "bestaudio/best", ...common], url, o.signal, o.onProgress);
  const file = fresh()[0];
  if (!file) throw new AdapterUnavailable("G5", "aucun fichier audio écrit (taille au-delà de la limite ?)");
  const path = join(o.outDir, file);
  if (statSync(path).size > limits.maxBytes) throw new AdapterUnavailable("G5", "fichier au-delà de la limite");
  return { info: i, mode: "audio", textOrigin: "aucun", file: path, note: "audio seul : aucun texte n'existe encore ; la transcription se fait localement (voix de Jarod)" };
}

/**
 * V-07 — l'admission d'un fichier par la quarantaine (`QuarantineService.admitFile`, vue par sa forme) : rend le chemin admis dans `destDir`
 * ou lève une erreur qui dit pourquoi.
 */
export type AdmitFile = (source: string, provenance: { source: string; url?: string }, destDir: string) => string;

/**
 * Le fichier qu'a rapporté yt-dlp, du dossier de transit vers `<dossier de travail>/.jarod-media/`, seulement s'il est admis. Sans quarantaine,
 * rien n'entre : un fichier venu d'Internet n'est jamais rangé sans analyse.
 */
export function admitMediaFile(file: string, url: string, workspace: string, admit: AdmitFile | null): string {
  if (!admit) throw new Error("la quarantaine n'est pas chargée : aucun fichier venu d'Internet n'entre sans analyse");
  return admit(file, { source: "media_fetch", url }, join(workspace, ".jarod-media"));
}

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
export interface MediaToolDef {
  name: "media_fetch";
  description: string;
  parameters: Record<string, unknown>;
  dangerous: true;
  source: "builtin";
  targetOf(args: Record<string, unknown>): string | null;
  operationOf(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }): Promise<string>;
}

/**
 * Outil de l'agent : métadonnées, sous-titres ou audio d'UNE vidéo en ligne, rangés dans `<dossier de travail>/.jarod-media/`. Il va sur
 * Internet : accord à chaque appel (la cible présentée est l'hôte), refus hors ligne par la porte. Le texte rendu dit son origine.
 */
export function mediaTool(bin: () => string | null, admit: () => AdmitFile | null = () => null): MediaToolDef {
  return {
    name: "media_fetch",
    description:
      "Récupère le TEXTE d'une vidéo en ligne (yt-dlp) : mode metadata (titre, durée, langues des sous-titres), subtitles (sous-titres originaux ; automatiques seulement si allowAuto) ou audio (fichier à transcrire localement). Une seule vidéo, jamais de cookies, durée et taille bornées. Ne voit pas les images.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        mode: { type: "string", enum: ["metadata", "subtitles", "audio"] },
        langs: { type: "array", items: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$" }, maxItems: 5 },
        allowAuto: { type: "boolean", description: "accepter des sous-titres générés automatiquement par la plateforme" },
      },
      required: ["url", "mode"],
    },
    dangerous: true,
    source: "builtin",
    targetOf: (args) => {
      try {
        return new URL(String(args.url)).hostname;
      } catch {
        return null;
      }
    },
    // Autonomie configurable : le mode est l'opération — une règle peut accorder « subtitles » sur un hôte sans accorder « audio ».
    operationOf: (args) => (typeof args.mode === "string" ? args.mode : undefined),
    async run(args, ctx) {
      const b = bin();
      if (!b) return "Indisponible : yt-dlp introuvable — régler JAROD_YTDLP ou JAROD_ENGINES_DIR (voir engines.lock/README.md).";
      if (!ctx.workspace) return "Indisponible : aucun dossier de travail pour ranger le fichier.";
      // V-07 : yt-dlp écrit dans un dossier de transit ; le fichier n'atteint le dossier de travail qu'admis par la quarantaine.
      const staging = mkdtempSync(join(tmpdir(), "jarod-media-"));
      try {
        const fetched = await fetchMediaText({
          bin: b,
          url: String(args.url ?? ""),
          mode: String(args.mode) as MediaMode,
          outDir: staging,
          ...(Array.isArray(args.langs) ? { langs: args.langs.map(String) } : {}),
          allowAuto: args.allowAuto === true,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        let r = fetched;
        if (fetched.file) {
          try {
            r = { ...fetched, file: admitMediaFile(fetched.file, String(args.url ?? ""), ctx.workspace, admit()) };
          } catch (e) {
            // Refusé : ni le fichier ni le texte qu'il contient ne sont rendus.
            return `Refusé : ${(e as Error).message}`;
          }
        }
        const head = `« ${r.info.title} »${r.info.uploader ? ` — ${r.info.uploader}` : ""}${r.info.durationSec ? ` — ${Math.round(r.info.durationSec)} s` : ""} (${r.info.page})`;
        const langs = `sous-titres originaux : ${r.info.subtitles.join(", ") || "aucun"} ; automatiques : ${r.info.automaticCaptions.length ? `${r.info.automaticCaptions.length} langue(s)` : "aucun"}`;
        return [head, langs, `origine du texte : ${r.textOrigin}${r.language ? ` (${r.language})` : ""} — ${r.note}`, r.file ? `fichier : ${r.file}` : "", r.text ?? ""].filter(Boolean).join("\n");
      } catch (e) {
        return `Échec : ${(e as Error).message}`;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  };
}
