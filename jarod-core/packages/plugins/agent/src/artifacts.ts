/**
 * Cockpit, lot 5 : les ARTEFACTS — ce que l'agent a produit et que l'utilisateur doit pouvoir retrouver : diagrammes (source .html
 * modifiable + exports), vidéos rendues, rapports d'analyse. Un artefact RÉFÉRENCE un fichier (jamais copié) avec son empreinte : un
 * fichier modifié ou disparu depuis l'enregistrement se voit (`check`). Les fichiers sont confinés au dossier de travail de l'appel.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Db } from "@jarod/plugin-storage";
import { childEnv } from "@jarod/kernel/child-env";

export type ArtifactKind = "diagram" | "video" | "analysis" | "report" | "image" | "file";
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["diagram", "video", "analysis", "report", "image", "file"];

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".drawio": "application/xml",
  ".reladraw": "text/plain",
  ".gzf": "application/octet-stream",
};
export const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

export interface Artifact {
  id: string;
  sessionId: string | null;
  kind: ArtifactKind;
  title: string;
  path: string;
  sourcePath: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  /** Qui l'a produit : un outil (`write_file`, `diagram_export`, `video_render`…) ou `agent`. */
  origin: string;
  meta: Record<string, unknown>;
  createdAt: number;
}

interface Row {
  id: string;
  session_id: string | null;
  kind: string;
  title: string;
  path: string;
  source_path: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  origin: string;
  meta: string;
  created_at: number;
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Un chemin relatif au dossier de travail (ou absolu dedans) → absolu ; refuse d'en sortir. */
export function inWorkspace(workspace: string | null, p: unknown): string {
  if (!workspace) throw new Error("Aucun dossier de travail : choisissez-en un pour enregistrer un artefact.");
  if (typeof p !== "string" || !p.trim()) throw new Error("Chemin requis.");
  const abs = resolve(workspace, p);
  const rel = relative(resolve(workspace), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} est hors du dossier de travail.`);
  return abs;
}

export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Enregistre un fichier existant comme artefact ; le même chemin avec le même contenu n'est pas enregistré deux fois. */
  register(o: { sessionId: string | null; kind: ArtifactKind; title: string; path: string; sourcePath?: string | null; origin: string; meta?: Record<string, unknown> }): Artifact {
    if (!ARTIFACT_KINDS.includes(o.kind)) throw new Error(`Type d'artefact inconnu : ${o.kind}`);
    if (!existsSync(o.path) || !statSync(o.path).isFile()) throw new Error(`${o.path} n'existe pas.`);
    if (o.sourcePath && !existsSync(o.sourcePath)) throw new Error(`Source introuvable : ${o.sourcePath}`);
    const sha256 = sha256File(o.path);
    const same = this.db.get<Row>("SELECT * FROM artifacts WHERE path = ? AND sha256 = ?", o.path, sha256);
    if (same) return toArtifact(same);
    const a: Artifact = {
      id: randomUUID(),
      sessionId: o.sessionId,
      kind: o.kind,
      title: o.title.trim().slice(0, 200) || basename(o.path),
      path: o.path,
      sourcePath: o.sourcePath ?? null,
      mime: mimeOf(o.path),
      bytes: statSync(o.path).size,
      sha256,
      origin: o.origin,
      meta: o.meta ?? {},
      createdAt: this.now(),
    };
    this.db.run(
      "INSERT INTO artifacts (id, session_id, kind, title, path, source_path, mime, bytes, sha256, origin, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      a.id,
      a.sessionId,
      a.kind,
      a.title,
      a.path,
      a.sourcePath,
      a.mime,
      a.bytes,
      a.sha256,
      a.origin,
      JSON.stringify(a.meta),
      a.createdAt,
    );
    return a;
  }

  get(id: string): Artifact | undefined {
    const r = this.db.get<Row>("SELECT * FROM artifacts WHERE id = ?", id);
    return r ? toArtifact(r) : undefined;
  }

  list(o: { kind?: ArtifactKind; sessionId?: string; limit?: number } = {}): Artifact[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (o.kind) where.push("kind = ?"), params.push(o.kind);
    if (o.sessionId) where.push("session_id = ?"), params.push(o.sessionId);
    return this.db
      .all<Row>(`SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, ...params, o.limit ?? 200)
      .map(toArtifact);
  }

  /** L'état du fichier MAINTENANT : intact, modifié depuis l'enregistrement, ou disparu. */
  check(id: string): "intact" | "modified" | "missing" | "unknown" {
    const a = this.get(id);
    if (!a) return "unknown";
    if (!existsSync(a.path)) return "missing";
    return sha256File(a.path) === a.sha256 ? "intact" : "modified";
  }

  /** Retire l'artefact de la liste ; le fichier, lui, reste à sa place (il est à l'utilisateur). */
  forget(id: string): boolean {
    return this.db.run("DELETE FROM artifacts WHERE id = ?", id).changes > 0;
  }
}

function toArtifact(r: Row): Artifact {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(r.meta) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { id: r.id, sessionId: r.session_id, kind: r.kind as ArtifactKind, title: r.title, path: r.path, sourcePath: r.source_path, mime: r.mime, bytes: r.bytes, sha256: r.sha256, origin: r.origin, meta, createdAt: r.created_at };
}

/**
 * Le SVG d'un diagramme HTML de diagram-design : le PREMIER élément `<svg>` complet, tel quel (les habillages éditoriaux autour sont
 * laissés, comme le fait l'export d'origine). Lève s'il n'y en a pas.
 */
export function extractSvg(html: string): string {
  const start = html.search(/<svg[\s>]/i);
  if (start < 0) throw new Error("Aucun élément <svg> dans ce fichier.");
  let depth = 0;
  const re = /<svg[\s>]|<\/svg\s*>/gi;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].toLowerCase().startsWith("</") ? -1 : 1;
    if (depth === 0) {
      let svg = html.slice(start, m.index + m[0].length);
      if (!/xmlns=/.test(svg.slice(0, 300))) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
    }
  }
  throw new Error("Élément <svg> non fermé.");
}

/**
 * G8 (lot C, 2026-10-21) — reladraw 0.16.0 (Apache-2.0, aucune dépendance ; engines/reladraw, `npm ci --ignore-scripts` sur
 * engines.lock/node/reladraw, intégrité sha512 vérifiée) : un texte où l'on dit OÙ vont les éléments (« right of », « below »…), mis en
 * page et rendu en SVG par le moteur. Le CLI : JAROD_RELADRAW, sinon JAROD_ENGINES_DIR\reladraw\node_modules\reladraw\dist\cli.js.
 */
export function reladrawCli(env: Record<string, string | undefined> = process.env): string | null {
  const c = [env.JAROD_RELADRAW, env.JAROD_ENGINES_DIR && join(env.JAROD_ENGINES_DIR, "reladraw", "node_modules", "reladraw", "dist", "cli.js")].filter((x): x is string => Boolean(x));
  return c.find((p) => existsSync(p)) ?? null;
}

/**
 * Rend une source reladraw en SVG, dans un processus Node À PART sous le modèle de permissions : il ne lit que le moteur et la source, n'écrit
 * que dans un dossier temporaire, ne lance aucun programme (mesuré : une écriture ailleurs est refusée). Délai de 30 s. L'erreur de reladraw
 * (ligne et raison d'un défaut de syntaxe) est rendue telle quelle : le modèle peut corriger sa source.
 */
export async function renderReladraw(cli: string, src: string, signal?: AbortSignal): Promise<string> {
  const engine = dirname(dirname(cli));
  const work = mkdtempSync(join(tmpdir(), "jarod-reladraw-"));
  const out = join(work, "out.svg");
  try {
    const args = ["--permission", `--allow-fs-read=${join(engine, "*")}`, `--allow-fs-read=${src}`, `--allow-fs-write=${join(work, "*")}`, cli, src, "-o", out];
    const err = await new Promise<string | null>((done) =>
      execFile(process.execPath, args, { windowsHide: true, timeout: 30_000, env: childEnv("engine"), ...(signal ? { signal } : {}) }, (e, _stdout, stderr) =>
        done(e ? (String(stderr).trim() || (e as Error).message).slice(0, 2000) : null),
      ),
    );
    if (err) throw new Error(`reladraw : ${err}`);
    const svg = readFileSync(out, "utf8").trim();
    if (!/^<svg[\s>]/.test(svg) || !/<\/svg>$/.test(svg)) throw new Error("reladraw n'a pas rendu un SVG complet.");
    return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Les outils de l'agent : enregistrer et lister des artefacts (lecture d'un fichier du dossier de travail), exporter un diagramme en SVG. */
export function artifactTools(store: ArtifactStore, deps: { reladraw?: () => string | null } = {}) {
  const reladraw = deps.reladraw ?? (() => reladrawCli());
  return [
    {
      name: "artifact_register",
      description:
        "Enregistre un fichier du dossier de travail comme ARTEFACT (diagramme, vidéo, analyse, rapport, image) pour qu'il apparaisse dans Réglages › Artefacts, avec son empreinte et sa source modifiable éventuelle.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          kind: { type: "string", enum: [...ARTIFACT_KINDS] },
          title: { type: "string" },
          source: { type: "string", description: "Le fichier source modifiable (ex. le .html d'un diagramme exporté)." },
        },
        required: ["path", "kind", "title"],
      },
      source: "builtin" as const,
      targetOf: (args: Record<string, unknown>) => (typeof args.path === "string" ? args.path : undefined),
      async run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null }) {
        const path = inWorkspace(ctx.workspace, args.path);
        const source = typeof args.source === "string" && args.source ? inWorkspace(ctx.workspace, args.source) : null;
        const a = store.register({ sessionId: ctx.sessionId, kind: String(args.kind) as ArtifactKind, title: String(args.title ?? ""), path, sourcePath: source, origin: "agent" });
        return `Artefact enregistré : ${a.title} (${a.kind}, ${a.bytes} octets, sha256 ${a.sha256.slice(0, 16)}) — id ${a.id}`;
      },
    },
    {
      name: "artifact_list",
      description: "Les artefacts enregistrés (les plus récents d'abord), avec leur état : intact, modifié depuis, ou disparu.",
      parameters: { type: "object", properties: { kind: { type: "string", enum: [...ARTIFACT_KINDS] } } },
      source: "builtin" as const,
      async run(args: Record<string, unknown>) {
        const list = store.list({ ...(typeof args.kind === "string" ? { kind: args.kind as ArtifactKind } : {}), limit: 30 });
        if (!list.length) return "Aucun artefact enregistré.";
        return list.map((a) => `${a.id} · ${a.kind} · ${a.title} · ${a.path} · ${store.check(a.id)}`).join("\n");
      },
    },
    {
      name: "diagram_export",
      description:
        "Exporte en SVG un diagramme du dossier de travail : un .html (diagram-design, SVG écrit à la main) ou une source .reladraw (texte où l'on place les éléments les uns par rapport aux autres — `node a \"Texte\"`, `node b \"…\" right of a`, `edge a -> b \"légende\"` — mis en page par le moteur reladraw). Écrit <nom>.svg à côté (ou `out`), garde la source modifiable et enregistre l'export comme artefact. Une erreur de syntaxe reladraw est rendue avec sa ligne. Le PNG n'est pas disponible.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, out: { type: "string" }, title: { type: "string" } },
        required: ["path"],
      },
      dangerous: true,
      source: "builtin" as const,
      targetOf: (args: Record<string, unknown>) => (typeof args.path === "string" ? args.path : undefined),
      async run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }) {
        const src = inWorkspace(ctx.workspace, args.path);
        const isReladraw = /\.reladraw$/i.test(src);
        if (!isReladraw && !/\.html?$/i.test(src)) throw new Error("Le diagramme doit être un fichier .html ou .reladraw.");
        const out = typeof args.out === "string" && args.out ? inWorkspace(ctx.workspace, args.out) : join(dirname(src), `${basename(src, extname(src))}.svg`);
        if (!/\.svg$/i.test(out)) throw new Error("La sortie doit être un fichier .svg.");
        let svg: string;
        if (isReladraw) {
          const cli = reladraw();
          if (!cli) throw new Error("Moteur reladraw introuvable (JAROD_RELADRAW ou JAROD_ENGINES_DIR, voir engines.lock/README.md).");
          if (!existsSync(src)) throw new Error(`${relative(ctx.workspace!, src)} n'existe pas.`);
          svg = await renderReladraw(cli, src, ctx.signal);
        } else svg = extractSvg(readFileSync(src, "utf8"));
        writeFileSync(out, svg, "utf8");
        const a = store.register({ sessionId: ctx.sessionId, kind: "diagram", title: String(args.title ?? basename(out)), path: out, sourcePath: src, origin: "diagram_export" });
        return JSON.stringify({ svg: relative(ctx.workspace!, out), bytes: a.bytes, artifact: a.id, source: relative(ctx.workspace!, src) });
      },
      // Preuve : le .svg relu commence par une déclaration XML et contient un élément <svg> fermé, à l'empreinte enregistrée.
      async verify(_args: Record<string, unknown>, out: string, ctx: { workspace: string | null }) {
        const o = JSON.parse(out) as { svg: string; artifact: string };
        const file = inWorkspace(ctx.workspace, o.svg);
        if (!existsSync(file)) return { status: "failed" as const, evidence: `${o.svg} n'existe pas` };
        const text = readFileSync(file, "utf8");
        const ok = /^<\?xml[^>]*>\s*<svg[\s>]/.test(text) && /<\/svg>\s*$/.test(text);
        const intact = store.check(o.artifact) === "intact";
        return ok && intact ? { status: "verified" as const, evidence: `${o.svg} relu : SVG complet, ${text.length} caractères, artefact intact` } : { status: "failed" as const, evidence: `${o.svg} relu : ${ok ? "artefact modifié" : "SVG incomplet"}` };
      },
    },
  ];
}
