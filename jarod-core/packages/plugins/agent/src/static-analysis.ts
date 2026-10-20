/**
 * Cockpit, lot 6 — REA et Ghidra : ANALYSE STATIQUE de fichiers que l'utilisateur est autorisé à analyser. Deux outils typés de la
 * porte unique (accord, annulation, délai, preuve), pour des fichiers CONFINÉS au dossier de travail.
 *
 * Règle dure du prompt maître, tenue ici par le code : la CIBLE N'EST JAMAIS EXÉCUTÉE. Ghidra l'IMPORTE et l'auto-analyse (il ne la
 * lance pas) ; REA n'est appelé que par une LISTE BLANCHE de sous-commandes strictement statiques (analyse, décompilation, comparaison,
 * correspondance d'adresse) — tout ce qui capture, débogue ou s'attache à un processus vivant (`capture-*`, `debug-with-*`,
 * `cutter-command`, `*-scenario`) est hors de la liste et donc refusé. En plus, l'empreinte de la cible est relue après coup : si elle a
 * changé, l'analyse est déclarée en échec (une analyse statique ne modifie pas son entrée).
 *
 * Aucun argument libre du modèle : les chemins sont confinés, la sous-commande vient de la liste blanche, les options sont fixes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { type ArtifactStore, inWorkspace } from "./artifacts.js";
import { findProgram, type Runner, realRunner } from "./video.js";

const REA_TIMEOUT_MS = 10 * 60_000;
const GHIDRA_TIMEOUT_MS = 20 * 60_000;
const MAX_ANALYSIS_CHARS = 4 * 1024 * 1024;

/**
 * Les sous-commandes REA STATIQUES permises, et combien de chemins (positionnels) elles prennent. `addr` : un argument d'adresse ou de
 * procédure vient après le chemin. Fail-closed : une action absente d'ici est refusée, jamais transmise à REA.
 */
export const REA_STATIC: Record<string, { paths: 1 | 2; addr?: boolean }> = {
  analyze: { paths: 1 },
  decompile: { paths: 1, addr: true },
  "analyze-javascript-application": { paths: 1 },
  "address-to-file-offset": { paths: 1, addr: true },
  compare: { paths: 2 },
  "compare-application-versions": { paths: 2 },
  "compare-javascript-export-shapes": { paths: 2 },
  "compare-managed-members": { paths: 2 },
  "compare-source-to-bundle": { paths: 2 },
  "compare-wasm-interfaces": { paths: 2 },
};

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** La racine d'une installation Ghidra (analyzeHeadless présent), ou null. */
export function detectGhidra(env: NodeJS.ProcessEnv = process.env): string | null {
  const cands = [env.GHIDRA_INSTALL_DIR, env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "ghidra", "current"), env.ProgramFiles && join(env.ProgramFiles, "Ghidra")];
  for (const c of cands) if (c && (existsSync(join(c, "support", "analyzeHeadless.bat")) || existsSync(join(c, "support", "analyzeHeadless")))) return c;
  return null;
}
const headlessOf = (root: string): string => join(root, "support", process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless");

export interface StaticDeps {
  artifacts: ArtifactStore;
  run?: Runner;
  which?: (name: string) => string | null;
  ghidraRoot?: () => string | null;
  /** La version majeure de Java (≥ 21 exigé par Ghidra), ou null. */
  javaMajor?: () => Promise<number | null>;
}

export function staticAnalysisTools(d: StaticDeps) {
  const run = d.run ?? realRunner;
  const which = d.which ?? ((n: string) => findProgram(n));
  const ghidraRoot = d.ghidraRoot ?? (() => detectGhidra());
  const javaMajor =
    d.javaMajor ??
    (async () => {
      const file = which("java");
      if (!file) return null;
      const r = await run(file, ["-version"], { cwd: process.cwd(), timeoutMs: 8000 });
      const m = /version "(\d+)/.exec(`${r.stdout}\n${r.stderr}`);
      return m ? Number(m[1]) : null;
    });

  /** Écrit le résultat d'analyse dans le dossier de travail et l'enregistre comme artefact « analysis » ; exige la cible inchangée. */
  const finish = (ctx: { sessionId: string; workspace: string | null }, target: string, before: string, outPath: string, text: string, origin: string, meta: Record<string, unknown>) => {
    if (sha256File(target) !== before) throw new Error("La cible a changé pendant l'analyse — arrêté. Une analyse statique ne doit pas modifier son entrée.");
    writeFileSync(outPath, text.slice(0, MAX_ANALYSIS_CHARS), "utf8");
    const a = d.artifacts.register({ sessionId: ctx.sessionId, kind: "analysis", title: relative(ctx.workspace!, outPath), path: outPath, sourcePath: target, origin, meta: { ...meta, targetSha256: before } });
    return JSON.stringify({ analysis: relative(ctx.workspace!, outPath), artifact: a.id, chars: Math.min(text.length, MAX_ANALYSIS_CHARS), targetUnchanged: true });
  };

  const verify = async (_args: Record<string, unknown>, out: string, ctx: { workspace: string | null }) => {
    const o = JSON.parse(out) as { analysis: string; artifact: string };
    const file = inWorkspace(ctx.workspace, o.analysis);
    if (!existsSync(file) || statSync(file).size === 0) return { status: "failed" as const, evidence: `${o.analysis} absent ou vide` };
    return d.artifacts.get(o.artifact) && statSync(file).size > 0
      ? { status: "verified" as const, evidence: `${o.analysis} écrit (${statSync(file).size} octets), cible inchangée` }
      : { status: "failed" as const, evidence: `${o.analysis} : artefact absent` };
  };

  return [
    {
      name: "rea_static",
      description:
        "Analyse STATIQUE d'un fichier du dossier de travail avec REA, sans l'exécuter : vue d'ensemble (analyze), décompilation (decompile), ou comparaison (compare…). Pour des fichiers que vous êtes autorisé à analyser. Accord demandé ; le résultat est écrit et enregistré comme artefact.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: Object.keys(REA_STATIC) },
          path: { type: "string", description: "Fichier à analyser, dans le dossier de travail." },
          path2: { type: "string", description: "Deuxième fichier, pour les actions compare…." },
          address: { type: "string", description: "Procédure ou adresse (decompile, address-to-file-offset)." },
          format: { type: "string", enum: ["md", "json"] },
        },
        required: ["action", "path"],
      },
      dangerous: true,
      source: "builtin" as const,
      targetOf: (args: Record<string, unknown>) => (typeof args.path === "string" ? args.path : undefined),
      precheck(args: Record<string, unknown>, ctx: { workspace: string | null }) {
        const action = String(args.action ?? "");
        const spec = REA_STATIC[action];
        if (!spec) throw new Error(`Commande REA non autorisée : « ${action} » n'est pas une analyse statique (seules les lectures de fichiers le sont).`);
        const path = inWorkspace(ctx.workspace, args.path);
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${String(args.path)} n'existe pas.`);
        let label = relative(ctx.workspace!, path);
        if (spec.paths === 2) {
          const p2 = inWorkspace(ctx.workspace, args.path2);
          if (!existsSync(p2)) throw new Error("path2 est requis pour une comparaison, et doit exister.");
          label += ` vs ${relative(ctx.workspace!, p2)}`;
        }
        if (!which("rea")) throw new Error("REA n'est pas installé (commande rea introuvable) : rien n'est lancé.");
        return `Analyser statiquement ${label} avec REA (${action}) — la cible n'est jamais exécutée`;
      },
      async run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }) {
        const action = String(args.action);
        const spec = REA_STATIC[action];
        const rea = which("rea");
        if (!spec || !rea) throw new Error("Analyse impossible : action non autorisée ou REA absent.");
        const path = inWorkspace(ctx.workspace, args.path);
        const format = args.format === "json" ? "json" : "md";
        const argv = [action, path];
        if (spec.paths === 2) argv.push(inWorkspace(ctx.workspace, args.path2));
        if (spec.addr && typeof args.address === "string" && args.address.trim()) argv.push(args.address.trim());
        argv.push("--format", format);
        const before = sha256File(path);
        const r = await run(rea, argv, { cwd: ctx.workspace ?? process.cwd(), timeoutMs: REA_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (r.aborted) throw new Error("Analyse annulée.");
        if (r.timedOut) throw new Error("Analyse arrêtée : délai dépassé.");
        if (r.code !== 0) throw new Error(`rea ${action} a échoué (code ${String(r.code)}) : ${(r.stderr || r.stdout).trim().slice(-1500)}`);
        const out = join(ctx.workspace!, `${basename(path)}.rea-${action}.${format === "json" ? "json" : "md"}`);
        return finish(ctx, path, before, out, r.stdout || r.stderr, "rea_static", { action });
      },
      verify,
    },
    {
      name: "ghidra_analyze",
      description:
        "Analyse STATIQUE d'un fichier du dossier de travail avec Ghidra en mode headless : il IMPORTE et auto-analyse le fichier SANS l'exécuter, et le rapport d'analyse (format, architecture, résultats) est écrit et enregistré comme artefact. Pour des fichiers que vous êtes autorisé à analyser. Accord demandé.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Fichier à analyser, dans le dossier de travail." },
          timeout_seconds: { type: "integer", description: "Délai d'analyse par fichier (30 à 600, défaut 120)." },
        },
        required: ["path"],
      },
      dangerous: true,
      source: "builtin" as const,
      targetOf: (args: Record<string, unknown>) => (typeof args.path === "string" ? args.path : undefined),
      async precheck(args: Record<string, unknown>, ctx: { workspace: string | null }) {
        const path = inWorkspace(ctx.workspace, args.path);
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${String(args.path)} n'existe pas.`);
        if (!ghidraRoot()) throw new Error("Ghidra introuvable (GHIDRA_INSTALL_DIR ou scoop) : rien n'est lancé.");
        const major = await javaMajor();
        if (major === null || major < 21) throw new Error(`Ghidra exige un JDK 21 ; trouvé : ${major === null ? "aucun Java" : `Java ${major}`}.`);
        return `Analyser statiquement ${relative(ctx.workspace!, path)} avec Ghidra (import headless, la cible n'est jamais exécutée)`;
      },
      async run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }) {
        const path = inWorkspace(ctx.workspace, args.path);
        const root = ghidraRoot();
        if (!root) throw new Error("Ghidra introuvable.");
        const sec = Math.min(600, Math.max(30, typeof args.timeout_seconds === "number" ? Math.floor(args.timeout_seconds) : 120));
        const project = mkdtempSync(join(tmpdir(), "jarod-ghidra-"));
        const before = sha256File(path);
        try {
          // `-import` importe et auto-analyse le fichier SANS l'exécuter ; `-deleteProject` ne garde rien ; aucun postScript, aucun code tiers n'est lancé.
          const argv = [project, "jarod", "-import", path, "-analysisTimeoutPerFile", String(sec), "-deleteProject"];
          const r = await run(headlessOf(root), argv, { cwd: ctx.workspace ?? process.cwd(), timeoutMs: GHIDRA_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          if (r.aborted) throw new Error("Analyse annulée.");
          if (r.timedOut) throw new Error("Analyse arrêtée : délai dépassé.");
          const log = `${r.stdout}\n${r.stderr}`.trim();
          if (r.code !== 0 && !/INFO|REPORT/.test(log)) throw new Error(`analyzeHeadless a échoué (code ${String(r.code)}) : ${log.slice(-1500)}`);
          const out = join(ctx.workspace!, `${basename(path)}.ghidra.txt`);
          return finish(ctx, path, before, out, log, "ghidra_analyze", { analysisTimeoutPerFile: sec });
        } finally {
          try {
            rmSync(project, { recursive: true, force: true });
          } catch {
            /* le dossier de projet jetable part au prochain nettoyage */
          }
        }
      },
      verify,
    },
  ];
}
