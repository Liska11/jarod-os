/**
 * Q12 — les 12 canaux fichiers/médias de SANK-UI, sous la garde `file-gate.ts` (décision utilisateur 2026-09-28).
 * Sources des formes : SANK-UI `src/main/ipc/register.ts:1770-1836` (médias, pièces collées), `:2984-3100`
 * (dossier, lecture, ouverture, terminal, image), `media.ts`, `attachment-staging.ts` (rév. 3aaadb0, MIT ©
 * github.com/fathah). Écarts de sécurité (tous décidés, Q12 a-d) :
 * - tout chemin du renderer passe par la garde (chemin réel sous une racine, hors interdits) ; refus = forme
 *   SANK-UI d'échec (`null` / `false`) + ligne `deny` au journal ; lecture autorisée = ligne `read` (chemin, taille,
 *   canal) ;
 * - `read-file` : 100 Ko par défaut (SANK-UI), plafond 1 Mo ; images et médias : extensions d'image, ≤ 25 Mo ;
 * - `media-file-exists` : `false` hors racine (pas d'oracle sur le disque) ;
 * - `open-file-in-editor` : extension de document seulement ; sinon refus + « Afficher dans l'explorateur » (c) ;
 * - `save-media-file` / « Enregistrer sous » : destination = boîte native du main, jamais un dossier protégé ;
 *   URL http(s) refusée (d : un téléchargement relève de la règle d'accord) ;
 * - `show-media-menu` : « Ouvrir » = image sous racine ou `data:` matérialisée ; URL refusée (pas de menu) ;
 * - `stage-attachment` : écrit SEULEMENT dans `<profil>/attachments/staging/<conversation>/` (nom assaini,
 *   ≤ 25 Mo, 100 Mo par conversation) — sous-dossier `staging` : `attachments/` contient les pièces jointes
 *   chiffrées de Jarod, que la garde ne sert pas.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { FileGate, GateDenied, isForbiddenName, sanitizeSegment } from "../file-gate.js";
import type { HandlerContext } from "./context.js";

export const READ_FILE_DEFAULT = 100 * 1024;
export const READ_FILE_MAX = 1024 * 1024;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const STAGING_QUOTA = 100 * 1024 * 1024;

/** `media.ts:29-38` (médias rendus : sans `.ico`). */
const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};
/** `register.ts:3073-3094` (aperçu d'image : + `.ico`). */
const IMAGE_MIME: Record<string, string> = { ...MEDIA_MIME, ".ico": "image/x-icon" };
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MEDIA_MIME).map(([ext, mime]) => [mime, ext]));

/**
 * Q12 (c) — documents qu'`open-file-in-editor` confie à l'application associée : texte, code NON exécutable par
 * défaut, images matricielles, PDF, bureautique sans macros. Tout le reste (exécutables, scripts — `.js .py .ps1
 * .sh .bat` —, raccourcis, HTML/SVG qui s'ouvrent dans un navigateur, `.docm`…) : « Afficher dans l'explorateur ».
 */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "txt md markdown log csv tsv json jsonc yaml yml toml ini cfg conf xml rst tex " +
    "ts tsx mts cts jsx c h cc cpp hpp cs java kt go rs swift css scss less sql diff patch " +
    "png jpg jpeg gif webp bmp avif tif tiff ico heic pdf " +
    "doc docx xls xlsx ppt pptx odt ods odp rtf"
  )
    .split(" ")
    .map((e) => `.${e}`),
);

function decodeDataUrl(src: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (!match) return null;
  const buffer = Buffer.from(match[2]!, "base64");
  if (buffer.length <= 0 || buffer.length > MAX_MEDIA_BYTES) return null;
  return { mime: match[1]!.toLowerCase(), buffer };
}

const isUrl = (src: string) => /^https?:\/\//i.test(src);

/** Garde du kernel servi : racines relues à chaque appel (profil, réglages et conversations du moment). */
export function createFileGate(ctx: HandlerContext): FileGate {
  let media: string | null = null;
  return new FileGate({
    protectedDirs: () => [ctx.kernel().dataRoot, ...(ctx.shell.userDataDir ? [ctx.shell.userDataDir()] : [])],
    stagingRoot: () => stagingRoot(ctx),
    mediaRoot: () => (media ??= join(ctx.shell.tempDir(), "jarod-media")),
    workFolders: () => {
      const agent = ctx.kernel().agent;
      const out: { path: string; source: "workspace" | "session" }[] = [];
      const w = agent.settings.get("workspace");
      if (w) out.push({ path: w, source: "workspace" });
      for (const s of agent.sessions.list(Number.MAX_SAFE_INTEGER)) {
        if (s.context?.workspace) out.push({ path: s.context.workspace, source: "session" });
      }
      return out;
    },
    logFile: () => join(ctx.shell.logsDir(), "file-gate.jsonl"),
  });
}

const stagingRoot = (ctx: HandlerContext) => join(new ProfileManager(ctx.kernel().dataRoot).dirFor(ctx.kernel().profile), "attachments", "staging");
const stagingDirOf = (ctx: HandlerContext, sessionId: unknown) => join(stagingRoot(ctx), sanitizeSegment(sessionId || "default", "default"));

/** `attachment-staging.ts:70-84` : vide le dossier des pièces collées d'UNE conversation (au mieux). */
export function clearStaging(ctx: HandlerContext, gate: FileGate, sessionId: unknown): void {
  if (typeof sessionId !== "string" || !sanitizeSegment(sessionId, "")) return;
  const dir = stagingDirOf(ctx, sessionId);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
    gate.log({ op: "delete", channel: "clear-staged-attachments", path: dir });
  } catch {
    /* fichier ouvert ailleurs : nettoyage au mieux (SANK-UI) */
  }
}

export function createFileHandlers(ctx: HandlerContext, gate: FileGate) {
  const media = () => join(ctx.shell.tempDir(), "jarod-media");

  /** Le chemin réel autorisé, ou null (refus déjà journalisé). */
  const allowed = (channel: string, path: unknown, kind: "file" | "dir"): string | null => {
    try {
      return gate.authorize(channel, path, kind);
    } catch (e) {
      if (e instanceof GateDenied) return null;
      throw e;
    }
  };

  /** Image autorisée en `data:` URL (extension de la table, taille bornée), sinon null. */
  const imageDataUrl = (channel: string, path: unknown, table: Record<string, string>): string | null => {
    const real = allowed(channel, path, "file");
    if (!real) return null;
    const mime = table[extname(real).toLowerCase()];
    const size = statSync(real).size;
    if (!mime || size > MAX_MEDIA_BYTES) {
      gate.log({ op: "deny", channel, path: real, size, reason: mime ? "plus de 25 Mo" : "pas une image" });
      return null;
    }
    const data = readFileSync(real);
    gate.log({ op: "read", channel, path: real, size: data.length });
    return `data:${mime};base64,${data.toString("base64")}`;
  };

  /** `media.ts:95-125` : `data:` écrite dans `<temp>/jarod-media/` (nom = empreinte + nom assaini). */
  const materialize = (src: string, name: unknown): string | null => {
    const decoded = decodeDataUrl(src);
    if (!decoded || !Object.hasOwn(EXT_BY_MIME, decoded.mime)) return null;
    let filename = sanitizeSegment(name, "image", 160);
    if (!extname(filename) || !MEDIA_MIME[extname(filename).toLowerCase()]) filename += EXT_BY_MIME[decoded.mime];
    const dir = media();
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${createHash("sha256").update(decoded.buffer).digest("hex").slice(0, 16)}-${filename}`);
    if (!existsSync(target)) writeFileSync(target, decoded.buffer);
    gate.log({ op: "write", channel: "show-media-menu", path: target, size: decoded.buffer.length });
    return target;
  };

  /** `media.ts:160-192` sans téléchargement : `data:` ou fichier sous racine → destination de la boîte native. */
  const saveMedia = async (channel: string, src: unknown, name: unknown): Promise<boolean> => {
    if (typeof src !== "string" || !src) return false;
    if (isUrl(src)) {
      gate.log({ op: "deny", channel, path: src.slice(0, 200), reason: "URL http(s) : téléchargement non autorisé (Q12 d)" });
      return false;
    }
    let data: Buffer;
    if (src.startsWith("data:")) {
      const decoded = decodeDataUrl(src);
      if (!decoded) return false;
      data = decoded.buffer;
    } else {
      const real = allowed(channel, src, "file");
      if (!real) return false;
      if (statSync(real).size > MAX_MEDIA_BYTES) {
        gate.log({ op: "deny", channel, path: real, reason: "plus de 25 Mo" });
        return false;
      }
      data = readFileSync(real);
      gate.log({ op: "read", channel, path: real, size: data.length });
    }
    if (!ctx.shell.pickSavePath) return false;
    const chosen = await ctx.shell.pickSavePath(sanitizeSegment(name, "image", 160));
    if (!chosen) return false;
    let dest: string;
    try {
      dest = gate.userChosen(channel, chosen, false);
    } catch {
      return false;
    }
    writeFileSync(dest, data);
    gate.log({ op: "write", channel, path: dest, size: data.length });
    return true;
  };

  const stagingDir = (sessionId: unknown): string => stagingDirOf(ctx, sessionId);

  return {
    // register.ts:2984-2991 : boîte native ; le dossier choisi devient racine pour ce lancement (journalisé).
    "select-folder": async (): Promise<string | null> => {
      if (!ctx.shell.pickFolder) return null;
      const chosen = await ctx.shell.pickFolder();
      if (!chosen) return null;
      const r = gate.pick(chosen);
      if (r.ok) return r.path;
      ctx.shell.notify?.("Ce dossier ne peut pas servir de dossier de travail.", `${chosen}\n\nRaison : ${r.reason}.`);
      return null;
    },
    // register.ts:2994-3024 (chemin local) ; noms protégés masqués de la liste.
    "read-directory": (dirPath: unknown): { name: string; isDirectory: boolean }[] | null => {
      const real = allowed("read-directory", dirPath, "dir");
      if (!real) return null;
      try {
        const entries = readdirSync(real, { withFileTypes: true })
          .filter((e) => !isForbiddenName(e.name))
          .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
          .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
        gate.log({ op: "list", channel: "read-directory", path: real, size: entries.length });
        return entries;
      } catch {
        return null;
      }
    },
    // register.ts:3027-3046 : 100 Ko par défaut ; plafond Jarod 1 Mo ; seuls les octets rendus sont lus.
    "read-file": (filePath: unknown, maxBytes?: unknown): { content: string; truncated: boolean } | null => {
      const real = allowed("read-file", filePath, "file");
      if (!real) return null;
      const limit = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(Math.floor(maxBytes), READ_FILE_MAX) : READ_FILE_DEFAULT;
      try {
        const size = statSync(real).size;
        const buf = Buffer.alloc(Math.min(size, limit));
        const fd = openSync(real, "r");
        try {
          readSync(fd, buf, 0, buf.length, 0);
        } finally {
          closeSync(fd);
        }
        gate.log({ op: "read", channel: "read-file", path: real, size });
        return { content: buf.toString("utf-8"), truncated: size > limit };
      } catch {
        return null;
      }
    },
    "read-image-file": (filePath: unknown): string | null => imageDataUrl("read-image-file", filePath, IMAGE_MIME),
    "read-media-file": (filePath: unknown): string | null => imageDataUrl("read-media-file", filePath, MEDIA_MIME),
    // media.ts:147-153 : fichier ordinaire existant — ET sous racine (sinon false, sans distinction).
    "media-file-exists": (filePath: unknown): boolean => {
      const real = allowed("media-file-exists", filePath, "file");
      if (real) gate.log({ op: "exists", channel: "media-file-exists", path: real });
      return real !== null;
    },
    "save-media-file": (src: unknown, name: unknown): Promise<boolean> => saveMedia("save-media-file", src, name),
    // register.ts:1788-1823 : menu natif « Ouvrir » / « Enregistrer sous… » (libellés de la langue de l'écran).
    "show-media-menu": (src: unknown, name: unknown, labels: unknown): void => {
      if (typeof src !== "string" || !src || !ctx.shell.popupMenu) return;
      if (isUrl(src)) {
        gate.log({ op: "deny", channel: "show-media-menu", path: src.slice(0, 200), reason: "URL http(s) (Q12)" });
        return;
      }
      const l = labels && typeof labels === "object" ? (labels as { open?: unknown; saveAs?: unknown }) : {};
      const label = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.slice(0, 80) : dflt);
      const isData = src.startsWith("data:");
      let target: string | null = null;
      if (!isData) {
        target = allowed("show-media-menu", src, "file");
        if (target && !MEDIA_MIME[extname(target).toLowerCase()]) target = null;
      }
      ctx.shell.popupMenu([
        {
          label: label(l.open, "Ouvrir"),
          enabled: isData ? decodeDataUrl(src) !== null : target !== null,
          click: () => {
            const file = isData ? materialize(src, name) : target;
            if (!file) return;
            gate.log({ op: "open", channel: "show-media-menu", path: file });
            void ctx.shell.openPath(file);
          },
        },
        { label: label(l.saveAs, "Enregistrer sous…"), enabled: true, click: () => void saveMedia("show-media-menu", src, name) },
      ]);
    },
    // attachment-staging.ts:53-66 : seul dossier écrit ; nom et conversation assainis ; taille et quota bornés.
    "stage-attachment": (sessionId: unknown, filename: unknown, base64Bytes: unknown): string => {
      if (typeof base64Bytes !== "string") throw new Error("[oneai] stage-attachment : contenu base64 attendu");
      const data = Buffer.from(base64Bytes, "base64");
      if (data.length > MAX_MEDIA_BYTES) throw new Error("[oneai] pièce jointe refusée : plus de 25 Mo");
      const dir = stagingDir(sessionId);
      mkdirSync(dir, { recursive: true });
      const used = readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isFile() ? statSync(join(dir, e.name)).size : 0), 0);
      if (used + data.length > STAGING_QUOTA) throw new Error("[oneai] pièce jointe refusée : quota de 100 Mo atteint pour cette conversation");
      const base = sanitizeSegment(filename, "file");
      let target = join(dir, base);
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      for (let i = 1; existsSync(target) && i < 1000; i++) target = join(dir, `${stem}_${i}${ext}`);
      if (existsSync(target)) target = join(dir, `${stem}_${Date.now()}${ext}`);
      writeFileSync(target, data);
      gate.log({ op: "write", channel: "stage-attachment", path: target, size: data.length });
      return target;
    },
    // attachment-staging.ts:70-84 : ce dossier-là seulement.
    "clear-staged-attachments": (sessionId: unknown): void => clearStaging(ctx, gate, sessionId),
    // register.ts:3049-3057 + Q12 (c) : document de la liste blanche, sinon « Afficher dans l'explorateur ».
    "open-file-in-editor": async (filePath: unknown): Promise<boolean> => {
      const real = allowed("open-file-in-editor", filePath, "file");
      if (!real) return false;
      if (!DOCUMENT_EXTENSIONS.has(extname(real).toLowerCase())) {
        gate.log({ op: "reveal", channel: "open-file-in-editor", path: real, reason: "extension hors liste des documents" });
        ctx.shell.showItemInFolder?.(real);
        return false;
      }
      gate.log({ op: "open", channel: "open-file-in-editor", path: real });
      return (await ctx.shell.openPath(real)) === "";
    },
    // register.ts:3059-3070 : dossier sous racine, terminal sans commande.
    "open-terminal": async (dirPath: unknown): Promise<boolean> => {
      const real = allowed("open-terminal", dirPath, "dir");
      if (!real || !ctx.shell.openTerminal) return false;
      gate.log({ op: "terminal", channel: "open-terminal", path: real });
      return ctx.shell.openTerminal(real);
    },
  };
}
