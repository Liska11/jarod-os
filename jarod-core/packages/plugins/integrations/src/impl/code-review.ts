/**
 * G16 — revue de code locale par OpenCodeReview (alibaba/open-code-review), deux voies :
 *
 *  1. PLAN (`planReview`, outil `code_review_plan`) : `ocr delegate preview|rule`, SANS modèle. Rend les fichiers à relire et les règles
 *     qui s'y appliquent ; c'est l'agent de Jarod qui relit, avec SES fournisseurs autorisés et SA porte d'outils. Aucun réseau.
 *  2. REVUE (`runReview`) : `ocr review` contre un point d'accès de modèle. Bouclage seulement par défaut ; un point d'accès distant exige
 *     un accord EXPLICITE (`consentRemote`), puisque le code part alors hors de la machine.
 *
 * Garanties : dépôt git explicite, portée validée (jamais un argument qui commence par « - »), profil d'OpenCodeReview redirigé dans un
 * dossier temporaire supprimé ensuite (rien dans le profil de l'utilisateur), jeton du modèle passé par l'environnement de l'enfant
 * seulement (jamais en argument, jamais dans un journal), aucune écriture dans le dépôt. Les résultats ne sont JAMAIS appliqués :
 * chaque constat porte le fichier, la ligne retrouvée par Jarod, l'extrait cité (preuve) et un niveau de confiance — `located` dit si
 * l'extrait a été retrouvé dans le fichier tel qu'il est sur le disque.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export type ReviewScope = { kind: "workspace" } | { kind: "commit"; ref: string } | { kind: "range"; from: string; to: string };

export interface ReviewEndpoint {
  url: string;
  model: string;
  protocol: "openai" | "anthropic";
  /** Lu dans le coffre par l'appelant ; transmis à l'enfant par l'environnement seulement. */
  token?: string;
}

export interface ReviewPlan {
  mode: string;
  files: { path: string; status: string; insertions: number; deletions: number }[];
  excluded: number;
  rules: { source: string; pattern: string; files: string[]; rule: string }[];
}

export interface ReviewFinding {
  file: string;
  /** Ligne (1-based) où l'extrait cité a été retrouvé ; absente si introuvable. */
  line?: number;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | string;
  message: string;
  /** L'extrait cité par le modèle : la preuve, à vérifier. */
  evidence: string;
  suggestion?: string;
  /** `located` : extrait retrouvé dans le fichier ; `unlocated` : introuvable (constat à traiter avec prudence). */
  confidence: "located" | "unlocated";
}

export interface ReviewResult {
  status: "ok" | "failed" | "partial";
  endpoint: "local" | "remote";
  findings: ReviewFinding[];
  summary: { filesReviewed: number; comments: number; totalTokens: number };
  message: string;
}

const REF = /^(?!-)[\w./~^@{}-]{1,200}$/;
const ENV_KEEP = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TEMP", "TMP"];

/** Où trouver `ocr` : JAROD_OCR, sinon JAROD_ENGINES_DIR/opencodereview/ocr.exe. */
export function ocrBinary(env: Record<string, string | undefined> = process.env): string | null {
  const c = [env.JAROD_OCR, env.JAROD_ENGINES_DIR && join(env.JAROD_ENGINES_DIR, "opencodereview", "ocr.exe")].filter((x): x is string => Boolean(x));
  return c.find((p) => existsSync(p)) ?? null;
}

export function scopeArgs(scope: ReviewScope): string[] {
  if (scope.kind === "workspace") return [];
  if (scope.kind === "commit") {
    if (!REF.test(scope.ref)) throw new AdapterRefused("G16", `référence invalide : ${scope.ref}`);
    return ["--commit", scope.ref];
  }
  if (!REF.test(scope.from) || !REF.test(scope.to)) throw new AdapterRefused("G16", "références invalides");
  return ["--from", scope.from, "--to", scope.to];
}

/** Bouclage = local ; autre hôte = distant, permis seulement avec accord explicite. Jamais d'identifiants dans l'URL. */
export function endpointLocality(url: string, consentRemote: boolean): "local" | "remote" {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AdapterRefused("G16", "adresse du modèle invalide");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new AdapterRefused("G16", "seuls http et https sont permis");
  if (u.username || u.password) throw new AdapterRefused("G16", "identifiants interdits dans l'adresse : le jeton passe par le coffre");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!local && !consentRemote) throw new AdapterRefused("G16", `le point d'accès ${u.host} est distant : le code quitterait la machine ; accord explicite requis`);
  return local ? "local" : "remote";
}

function checkRepo(repo: string): string {
  const r = resolve(repo);
  if (!existsSync(join(r, ".git"))) throw new AdapterRefused("G16", `pas un dépôt git : ${r}`);
  return r;
}

function run(bin: string, args: string[], o: { env: Record<string, string>; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    execFile(bin, args, { cwd: o.cwd, env: o.env, windowsHide: true, timeout: o.timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(o.signal ? { signal: o.signal } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (e?.name === "AbortError") return fail(new AdapterRefused("G16", "revue annulée"));
      if (e?.killed) return fail(new AdapterUnavailable("G16", "revue arrêtée : délai dépassé"));
      if (e && typeof e.code === "string") return fail(new AdapterUnavailable("G16", `lancement impossible (${e.code})`));
      done({ code: e ? Number(e.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function sandboxEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return { ...env, USERPROFILE: home, HOME: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), XDG_CONFIG_HOME: join(home, "config"), DO_NOT_TRACK: "1", ...extra };
}

/** Voie 1 : le plan de revue, sans modèle ni réseau. */
export async function planReview(o: { bin: string; repo: string; scope: ReviewScope; exclude?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ReviewPlan> {
  const repo = checkRepo(o.repo);
  const home = mkdtempSync(join(tmpdir(), "jarod-ocr-"));
  try {
    const common = ["--repo", repo, "--format", "json", "--color", "never", ...scopeArgs(o.scope), ...(o.exclude ? ["--exclude", o.exclude] : [])];
    const opts = { env: sandboxEnv(home), cwd: repo, timeoutMs: o.timeoutMs ?? 60_000, ...(o.signal ? { signal: o.signal } : {}) };
    const p = await run(o.bin, ["delegate", "preview", ...common], opts);
    if (p.code !== 0) throw new AdapterUnavailable("G16", `aperçu impossible : ${p.stderr.slice(0, 600)}`);
    const preview = JSON.parse(p.stdout) as { mode: string; reviewable_files?: ReviewPlan["files"]; excluded_count?: number };
    const files = preview.reviewable_files ?? [];
    let rules: ReviewPlan["rules"] = [];
    if (files.length) {
      const r = await run(o.bin, ["delegate", "rule", ...files.map((f) => f.path), ...common], opts);
      if (r.code !== 0) throw new AdapterUnavailable("G16", `règles impossibles : ${r.stderr.slice(0, 600)}`);
      rules = ((JSON.parse(r.stdout) as { groups?: ReviewPlan["rules"] }).groups ?? []).map((g) => ({ source: g.source, pattern: g.pattern, files: g.files, rule: g.rule }));
    }
    return { mode: preview.mode, files, excluded: preview.excluded_count ?? 0, rules };
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Ligne (1-based) de la première ligne non vide de l'extrait dans le fichier ; `undefined` si introuvable. */
export function locate(repo: string, file: string, evidence: string): number | undefined {
  const abs = resolve(repo, file);
  const rel = relative(repo, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  let text: string;
  try {
    if (statSync(abs).size > 4 * 1024 * 1024) return undefined;
    text = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const first = evidence
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return undefined;
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === first || l.includes(first));
  return i >= 0 ? i + 1 : undefined;
}

interface OcrJson {
  status?: string;
  message?: string;
  summary?: { files_reviewed?: number; comments?: number; total_tokens?: number };
  comments?: { path?: string; category?: string; severity?: string; content?: string; existing_code?: string; suggestion_code?: string }[];
}

export function parseReview(repo: string, raw: OcrJson, endpoint: "local" | "remote"): ReviewResult {
  const findings: ReviewFinding[] = (raw.comments ?? []).map((c) => {
    const file = String(c.path ?? "");
    const evidence = String(c.existing_code ?? "");
    const line = file && evidence ? locate(repo, file, evidence) : undefined;
    return {
      file,
      ...(line ? { line } : {}),
      category: String(c.category ?? "other"),
      severity: String(c.severity ?? "low"),
      message: String(c.content ?? ""),
      evidence,
      ...(c.suggestion_code ? { suggestion: String(c.suggestion_code) } : {}),
      confidence: line ? "located" : "unlocated",
    };
  });
  const status = raw.status === "success" || raw.status === "ok" ? "ok" : raw.status === "partial" ? "partial" : raw.status === "failed" ? "failed" : findings.length ? "ok" : "failed";
  return {
    status,
    endpoint,
    findings,
    summary: { filesReviewed: raw.summary?.files_reviewed ?? 0, comments: raw.summary?.comments ?? findings.length, totalTokens: raw.summary?.total_tokens ?? 0 },
    message: String(raw.message ?? ""),
  };
}

/** Voie 2 : la revue complète par OpenCodeReview, contre un point d'accès (local par défaut). Ne modifie rien. */
export async function runReview(o: {
  bin: string;
  repo: string;
  scope: ReviewScope;
  endpoint: ReviewEndpoint;
  consentRemote?: boolean;
  exclude?: string;
  maxTokensBudget?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const repo = checkRepo(o.repo);
  const locality = endpointLocality(o.endpoint.url, o.consentRemote === true);
  if (!/^[\w.:/@-]{1,120}$/.test(o.endpoint.model)) throw new AdapterRefused("G16", "nom de modèle invalide");
  const home = mkdtempSync(join(tmpdir(), "jarod-ocr-"));
  try {
    const out = join(home, "review.json");
    const minutes = Math.max(1, Math.ceil((o.timeoutMs ?? 15 * 60_000) / 60_000));
    const args = ["review", "--repo", repo, "--format", "json", "--audience", "agent", "--color", "never", "-o", out, "--timeout", String(minutes), ...scopeArgs(o.scope)];
    if (o.exclude) args.push("--exclude", o.exclude);
    if (o.maxTokensBudget) args.push("--max-tokens-budget", String(Math.floor(o.maxTokensBudget)));
    const env = sandboxEnv(home, {
      OCR_LLM_URL: o.endpoint.url,
      OCR_LLM_MODEL: o.endpoint.model,
      OCR_USE_ANTHROPIC: o.endpoint.protocol === "anthropic" ? "true" : "false",
      ...(o.endpoint.token ? { OCR_LLM_TOKEN: o.endpoint.token } : {}),
    });
    const r = await run(o.bin, args, { env, cwd: repo, timeoutMs: (o.timeoutMs ?? 15 * 60_000) + 30_000, ...(o.signal ? { signal: o.signal } : {}) });
    const text = existsSync(out) ? readFileSync(out, "utf8") : r.stdout;
    let raw: OcrJson;
    try {
      raw = JSON.parse(text) as OcrJson;
    } catch {
      const why = (r.stderr || r.stdout).split(o.endpoint.token ?? "\u0000").join("[jeton]").slice(0, 600);
      throw new AdapterUnavailable("G16", `revue sans résultat lisible (code ${r.code}) : ${why}`);
    }
    return parseReview(repo, raw, locality);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
export interface CodeReviewPlanToolDef {
  name: "code_review_plan";
  description: string;
  parameters: Record<string, unknown>;
  dangerous: false;
  source: "builtin";
  run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }): Promise<string>;
}

/**
 * L'outil de l'agent : le PLAN de revue (fichiers et règles) d'un dépôt du dossier de travail. Lecture seule, sans modèle ni réseau ; la
 * relecture elle-même est faite par l'agent avec ses outils de lecture, et aucun correctif n'est appliqué sans demande et sans tests.
 */
export function codeReviewPlanTool(bin: () => string | null): CodeReviewPlanToolDef {
  return {
    name: "code_review_plan",
    description:
      "Prépare une revue de code locale (OpenCodeReview, mode délégation, sans modèle ni réseau) : fichiers modifiés d'un dépôt git du dossier de travail et règles de revue applicables. Portée : workspace (changements en cours), commit ou range. Rend un plan ; la relecture se fait ensuite avec read_file, et aucun correctif n'est appliqué automatiquement.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "dossier du dépôt, relatif au dossier de travail (défaut : le dossier de travail)" },
        scope: { type: "string", enum: ["workspace", "commit", "range"] },
        ref: { type: "string", description: "commit (scope=commit)" },
        from: { type: "string", description: "référence de départ (scope=range)" },
        to: { type: "string", description: "référence d'arrivée (scope=range)" },
      },
      required: ["scope"],
    },
    dangerous: false,
    source: "builtin",
    async run(args, ctx) {
      const b = bin();
      if (!b) return "Indisponible : OpenCodeReview (ocr.exe) introuvable — régler JAROD_OCR ou JAROD_ENGINES_DIR (voir engines.lock/README.md).";
      if (!ctx.workspace) return "Indisponible : aucun dossier de travail.";
      const repo = resolve(ctx.workspace, typeof args.repo === "string" && args.repo ? args.repo : ".");
      const rel = relative(ctx.workspace, repo);
      if (rel.startsWith("..") || isAbsolute(rel)) return "Refusé : le dépôt doit être dans le dossier de travail.";
      const kind = String(args.scope);
      const scope: ReviewScope =
        kind === "commit" ? { kind, ref: String(args.ref ?? "") } : kind === "range" ? { kind, from: String(args.from ?? ""), to: String(args.to ?? "") } : { kind: "workspace" };
      try {
        const plan = await planReview({ bin: b, repo, scope, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (!plan.files.length) return `Aucun fichier à relire (mode ${plan.mode}).`;
        return [
          `Plan de revue (${plan.mode}) : ${plan.files.length} fichier(s), ${plan.excluded} exclu(s).`,
          ...plan.files.map((f) => `- ${f.path} [${f.status}] +${f.insertions}/-${f.deletions}`),
          "",
          ...plan.rules.map((g) => `## Règles ${g.source} — ${g.pattern} (${g.files.join(", ")})\n${g.rule}`),
          "",
          "Relire ces fichiers avec read_file ; chaque constat cite le fichier, la ligne et l'extrait. Ne rien corriger sans demande, et faire passer les tests avant tout correctif.",
        ].join("\n");
      } catch (e) {
        return `Échec : ${(e as Error).message}`;
      }
    },
  };
}
