/**
 * Hugging Face : canaux PROPRES à Jarod `hf-*` du MAIN (SPECS-P5-MODELS.md § 3.10 (d)–(i)). Chercher, lire la fiche d'un dépôt, estimer « tient-il ? » depuis l'en-tête
 * GGUF (`Range`), télécharger. Règles :
 *
 * - le renderer n'a AUCUN accès réseau : tout part d'ici, sur un geste explicite, rien au montage ;
 * - AUCUN chemin, taille, empreinte, URL ni base ne vient du renderer : il envoie un dépôt, une révision et des CLÉS d'entrées lues par ce processus (fiche mémorisée) ;
 * - schémas stricts : tout champ inconnu est refusé, chaque valeur est bornée ;
 * - `hf-download` : verrou « un seul à la fois » PRIS D'ABORD, dossier des modèles choisi dans la boîte native et revérifié, fiche relue à la révision épinglée (le dépôt
 *   a changé = refus), contrôles sans réseau (cible présente, espace libre) AVANT la boîte, confirmation native avant tout octet de transfert, intégrité vérifiée par le service ;
 * - le jeton (clé du fournisseur `huggingface`) n'apparaît dans AUCUN message, résultat, événement ni journal ;
 * - une erreur destinée à l'écran commence par `HF_<CODE> : ` (seul le message traverse l'IPC).
 */
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  GGUF_MAX_READ_BYTES,
  GGUF_WINDOW_BYTES,
  type FitReport,
  type HfEntry,
  HfApiError,
  HfDownloadError,
  HfFitCache,
  HfNameError,
  type HfRepoInfo,
  HuggingFaceService,
  cachedFitReport,
  checkFit,
  entryDownloadFiles,
  renderFit,
  secretKeyFor,
  validateRepoId,
} from "@jarod/plugin-llm";
import { engineBudget } from "../engine-budget.js";
import { validateModelsDir } from "../models-dir.js";
import type { HandlerContext } from "./context.js";

/** Budget cumulé de corps lus par action « Check all » (SPECS-P5-MODELS.md § 3.6) et plafond d'UNE lecture d'en-tête. */
export const HF_FIT_BUDGET_BYTES = 64 * 1024 * 1024;
export const HF_FIT_READ_CAP_BYTES = GGUF_MAX_READ_BYTES;
const FIT_CONCURRENCY = 3;
const SEARCH_LIMIT = 30;
const SNAPSHOTS_MAX = 16;
const PROGRESS_MS = 250;
const GIB = 1024 ** 3;
const CACHE_TYPES = ["f16", "q8_0", "q4_0"] as const;
const SHA = /^[0-9a-f]{40}$/;
const LABEL: Record<string, string> = {
  fits: "Fits",
  "does-not-fit": "Does not fit",
  estimated: "Estimated (no memory budget known)",
  "beyond-native-context": "Beyond native context",
  "not-estimated": "Not estimated",
};

const fail = (code: string, text: string): never => {
  throw new Error(`HF_${code}: ${text}`);
};

function strict(input: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("BAD_INPUT", `${label} : objet attendu`);
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) return fail("BAD_INPUT", `${label} : champ(s) non accepté(s) : ${extra.join(", ")}`);
  return o;
}

function noArgs(args: unknown[], label: string): void {
  if (args.some((a) => a !== undefined)) fail("BAD_INPUT", `${label} : aucun argument attendu`);
}

function repoArg(v: unknown): string {
  try {
    return validateRepoId(v);
  } catch (e) {
    return fail("BAD_INPUT", `dépôt invalide : ${e instanceof HfNameError ? e.reason : "identifiant attendu"}`);
  }
}

function shaArg(v: unknown): string {
  return typeof v === "string" && SHA.test(v) ? v : fail("BAD_INPUT", "révision (sha) : 40 hexadécimaux minuscules attendus");
}

function keysArg(v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) return fail("BAD_INPUT", `« keys » : de 1 à ${max} clés attendues`);
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== "string" || k.length < 1 || k.length > 300) return fail("BAD_INPUT", "« keys » : des clés texte de 1 à 300 caractères attendues");
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function contextArg(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 512 && v <= 2_097_152 ? v : fail("BAD_INPUT", "« contextTokens » : entier entre 512 et 2097152 attendu");
}

function cacheArg(v: unknown): (typeof CACHE_TYPES)[number] {
  return typeof v === "string" && (CACHE_TYPES as readonly string[]).includes(v) ? (v as (typeof CACHE_TYPES)[number]) : fail("BAD_INPUT", `« cacheType » : un type de cache parmi ${CACHE_TYPES.join(", ")}`);
}

const gib = (n: number): string => (n / GIB).toFixed(2);
const clean = (message: string): string => message.replace(/^[A-Z_]+: /, "");

function rateText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "Hugging Face limite le débit : réessayez plus tard.";
  if (seconds > 3600) return "Hugging Face limite le débit : réessayez dans plus d'une heure.";
  return `Hugging Face limite le débit : réessayez dans ${Math.max(1, seconds)} s.`;
}

const GATED_TEXT = "ce dépôt exige une autorisation sur huggingface.co (dépôt « gated ») : demandez l'accès sur le site, puis réessayez";

interface FitView {
  key: string;
  state: "checked" | "not-checked" | "not-read";
  report?: FitReport;
  cached?: boolean;
  code?: string;
  reason?: string;
  retryAfterSeconds?: number | null;
}

/**
 * Le dossier par défaut de la boîte native (propre à une machine : SPECS-P5-MODELS.md § 4, § 10 « dossier par défaut ») n'est PRÉSÉLECTIONNÉ que s'il existe et que c'est un dossier.
 * Sinon (absent, fichier, illisible) la boîte s'ouvre sans présélection : jamais une erreur pour l'utilisateur, jamais un chemin d'une autre machine.
 */
function presetFolder(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

export function createHuggingFaceHandlers(ctx: HandlerContext) {
  const wiring = ctx.huggingface ?? {};
  const snapshots = new Map<string, HfRepoInfo>();
  const caches = new Map<string, HfFitCache>();
  let busy: AbortController | null = null;

  const readToken = (): string | undefined => {
    try {
      return ctx.kernel().agent.settings.getSecret(secretKeyFor("huggingface")) || undefined;
    } catch {
      return undefined;
    }
  };

  const service = (token: string | undefined) =>
    new HuggingFaceService({
      ...(wiring.baseUrl ? { baseUrl: wiring.baseUrl } : {}),
      ...(wiring.fetchImpl ? { fetchImpl: wiring.fetchImpl } : {}),
      ...(wiring.extraTrustedOrigins ? { extraTrustedOrigins: wiring.extraTrustedOrigins } : {}),
      ...(wiring.freeBytes ? { freeBytes: wiring.freeBytes } : {}),
      ...(token ? { token } : {}),
    });

  /** Rend une exception du service en erreur d'écran : code `HF_…`, jamais le jeton. */
  const userError = (e: unknown, token?: string): Error => {
    let message: string;
    if (e instanceof Error && /^HF_[A-Z_]+: /.test(e.message)) message = e.message;
    else if (e instanceof HfNameError) message = `HF_BAD_INPUT: ${e.reason}`;
    else if (e instanceof HfApiError || e instanceof HfDownloadError) {
      const status = e.status;
      if (e.code === "RATE_LIMITED") message = `HF_RATE_LIMITED: ${rateText(e.retryAfterSeconds)}`;
      else if (e.code === "HTTP" && (status === 401 || status === 403)) message = `HF_GATED: ${GATED_TEXT}.`;
      else if (e.code === "HTTP" && status === 404) message = "HF_NOT_FOUND: dépôt ou fichier introuvable sur huggingface.co.";
      else message = `HF_${e.code}: ${clean(e.message)}`;
    } else message = `HF_UNEXPECTED: ${clean(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    if (token) message = message.split(token).join("***");
    return new Error(message);
  };

  const kernelDirs = () => {
    const k = ctx.kernel();
    return { dataRoot: k.dataRoot, profileDir: join(k.dataRoot, "profiles", k.profile) };
  };

  const cacheFor = (): HfFitCache => {
    const path = join(kernelDirs().profileDir, "hf-fit-cache.json");
    let cache = caches.get(path);
    if (!cache) {
      cache = new HfFitCache({ path });
      caches.set(path, cache);
    }
    return cache;
  };

  const remember = (info: HfRepoInfo): void => {
    snapshots.delete(info.repo);
    snapshots.set(info.repo, info);
    while (snapshots.size > SNAPSHOTS_MAX) snapshots.delete(snapshots.keys().next().value as string);
  };

  const storedModelsDir = (): string | null => {
    const cfg = ctx.kernel().agent.settings.get("localEngine") as { modelsDir?: unknown } | undefined;
    return typeof cfg?.modelsDir === "string" && cfg.modelsDir !== "" ? cfg.modelsDir : null;
  };

  const memoryBudget = async (): Promise<number | null> => {
    const port = ctx.kernel().localEngine;
    if (!port) return null;
    try {
      return engineBudget(await port.hardware()).bytes;
    } catch {
      return null;
    }
  };

  const viewOf = (info: HfRepoInfo, cache: HfFitCache) => ({
    repo: info.repo,
    sha: info.sha,
    gated: info.gated,
    license: info.license,
    truncated: info.truncated,
    source: info.source,
    entries: info.entries.map((e) => {
      const head = e.files[0];
      return {
        key: e.key,
        files: e.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
        totalBytes: e.totalBytes,
        shardCount: e.shardCount,
        complete: e.complete,
        missing: e.missing,
        projector: /mmproj/i.test(basename(head?.name ?? e.key)),
        analyzed: e.complete && head !== undefined && cache.has({ repo: info.repo, sha: info.sha, file: head.name, size: head.size }),
      };
    }),
  });

  /** « Check all » : 3 lectures simultanées au plus, budget de corps cumulé réservé AVANT chaque lecture, arrêt à la PREMIÈRE 429. */
  async function runFit(args: { repo: string; sha: string; entries: HfEntry[]; contextTokens: number; cacheType: (typeof CACHE_TYPES)[number]; force: boolean; token: string | undefined }) {
    const svc = service(args.token);
    const cache = cacheFor();
    const gpuBytes = await memoryBudget();
    const options = { contextTokens: args.contextTokens, cacheType: args.cacheType, parallelSlots: 1, gpuBytes };
    const budget = wiring.fitBudgetBytes ?? HF_FIT_BUDGET_BYTES;
    const readCap = wiring.fitReadCapBytes ?? HF_FIT_READ_CAP_BYTES;
    const minGrant = Math.min(readCap, GGUF_WINDOW_BYTES);
    const results = new Map<string, FitView>();
    const queue = [...args.entries];
    const waiting: (() => void)[] = [];
    let reserved = 0;
    let transferred = 0;
    let requests = 0;
    const st: { stopped: "RATE_LIMITED" | null; rateLimited: { retryAfterSeconds: number | null } | null; budgetExhausted: boolean } = { stopped: null, rateLimited: null, budgetExhausted: false };

    const acquire = async (): Promise<number | null> => {
      for (;;) {
        if (st.stopped) return null;
        const grant = Math.min(readCap, budget - transferred - reserved);
        if (grant >= minGrant) {
          reserved += grant;
          return grant;
        }
        if (reserved === 0) {
          st.budgetExhausted = true;
          return null;
        }
        await new Promise<void>((r) => waiting.push(r));
      }
    };
    const wake = () => waiting.splice(0).forEach((r) => r());

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !st.stopped) {
        const entry = queue.shift()!;
        const head = entry.files[0];
        const known = !args.force && entry.complete && head !== undefined && cache.has({ repo: args.repo, sha: args.sha, file: head.name, size: head.size });
        const grant = known || !entry.complete ? 0 : await acquire();
        if (grant === null) {
          results.set(entry.key, { key: entry.key, state: "not-read", reason: st.stopped ?? "BUDGET" });
          continue;
        }
        try {
          const out = await checkFit({ service: svc, cache, repo: args.repo, sha: args.sha, entry, options, force: args.force, ...(grant > 0 ? { maxBytes: grant } : {}) });
          requests += out.requests;
          transferred += out.transferredBytes;
          if (out.state === "checked") results.set(entry.key, { key: entry.key, state: "checked", report: out.report, cached: out.cached });
          else {
            results.set(entry.key, { key: entry.key, state: "not-checked", code: out.code, reason: clean(out.reason), ...(out.code === "RATE_LIMITED" ? { retryAfterSeconds: out.retryAfterSeconds ?? null } : {}) });
            if (out.code === "RATE_LIMITED") {
              st.stopped = "RATE_LIMITED";
              st.rateLimited = { retryAfterSeconds: out.retryAfterSeconds ?? null };
            }
          }
        } finally {
          reserved -= grant;
          wake();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FIT_CONCURRENCY, Math.max(1, args.entries.length)) }, worker));
    for (const entry of queue) results.set(entry.key, { key: entry.key, state: "not-read", reason: st.stopped ?? "BUDGET" });
    return { results: args.entries.map((e) => results.get(e.key)!), requests, transferredBytes: transferred, rateLimited: st.rateLimited, budgetExhausted: st.budgetExhausted };
  }

  const verdictLines = async (info: HfRepoInfo, entries: HfEntry[], contextTokens: number, cacheType: (typeof CACHE_TYPES)[number]): Promise<string[]> => {
    const gpuBytes = await memoryBudget();
    const cache = cacheFor();
    const lines: string[] = [];
    for (const entry of entries) {
      const report = cachedFitReport(cache, info.repo, info.sha, entry, { contextTokens, cacheType, parallelSlots: 1, gpuBytes });
      if (!report) {
        lines.push(`${entry.key} : non analysé (lancez « Check fit » pour l'estimation)`);
        continue;
      }
      lines.push(`${entry.key} : ${LABEL[report.fit.status] ?? report.fit.status}`);
      for (const l of renderFit(report.fit).split("\n")) lines.push(`  ${l}`);
      if (gpuBytes !== null) lines.push(`  mémoire disponible (budget) : ${gib(gpuBytes)} Gio`);
    }
    return lines;
  };

  return {
    /** Recherche de modèles GGUF : texte envoyé à huggingface.co, 30 résultats au plus. */
    "hf-search": async (input: unknown) => {
      const o = strict(input, ["query"], "hf-search");
      const q = o.query;
      // eslint-disable-next-line no-control-regex -- une requête n'a aucun caractère de contrôle
      if (typeof q !== "string" || q.trim().length < 1 || q.length > 100 || /[\u0000-\u001f]/.test(q)) return fail("BAD_INPUT", "« query » : texte de 1 à 100 caractères, sans caractère de contrôle (requête)");
      const token = readToken();
      try {
        const rows = await service(token).search(q, SEARCH_LIMIT);
        return rows.slice(0, SEARCH_LIMIT).map((m) => ({ id: m.id, downloads: m.downloads, likes: m.likes }));
      } catch (e) {
        throw userError(e, token);
      }
    },

    /** La fiche d'un dépôt à la révision épinglée : modèles (fragments regroupés), licence, « gated ». Mémorisée pour `hf-fit`. */
    "hf-repo": async (input: unknown) => {
      const o = strict(input, ["repo"], "hf-repo");
      const repo = repoArg(o.repo);
      const token = readToken();
      try {
        const info = await service(token).repoInfo(repo);
        remember(info);
        return viewOf(info, cacheFor());
      } catch (e) {
        throw userError(e, token);
      }
    },

    /** « Check fit » / « Check all » : l'estimation de mémoire depuis l'en-tête GGUF (cache d'abord). Une indication, jamais un blocage. */
    "hf-fit": async (input: unknown) => {
      const o = strict(input, ["repo", "sha", "keys", "contextTokens", "cacheType", "force"], "hf-fit");
      const repo = repoArg(o.repo);
      const sha = shaArg(o.sha);
      const keys = keysArg(o.keys, 100);
      const contextTokens = contextArg(o.contextTokens);
      const cacheType = cacheArg(o.cacheType);
      if (o.force !== undefined && typeof o.force !== "boolean") fail("BAD_INPUT", "« force » : booléen attendu");
      const snapshot = snapshots.get(repo);
      if (!snapshot || snapshot.sha !== sha) return fail("STALE_LIST", "liste périmée ou jamais lue : rouvrez le dépôt");
      const entries = keys.map((k) => snapshot.entries.find((e) => e.key === k) ?? fail("STALE_LIST", `entrée inconnue dans la liste : ${k}`));
      const token = readToken();
      try {
        return await runFit({ repo, sha, entries, contextTokens, cacheType, force: o.force === true, token });
      } catch (e) {
        throw userError(e, token);
      }
    },

    /** Télécharge les entrées choisies : verrou, dossier, fiche relue, contrôles, boîte native, transfert vérifié. */
    "hf-download": async (input: unknown) => {
      const o = strict(input, ["repo", "sha", "keys", "contextTokens", "cacheType"], "hf-download");
      const repo = repoArg(o.repo);
      const sha = shaArg(o.sha);
      const keys = keysArg(o.keys, 8);
      const contextTokens = o.contextTokens === undefined ? 8192 : contextArg(o.contextTokens);
      const cacheType = o.cacheType === undefined ? "f16" : cacheArg(o.cacheType);
      if (busy) return fail("BUSY", "un téléchargement est déjà en cours : attendez sa fin ou annulez-le");
      const controller = new AbortController();
      busy = controller;
      const token = readToken();
      try {
        const stored = storedModelsDir();
        if (!stored) return fail("NO_MODELS_DIR", "aucun dossier des modèles choisi : choisissez-le d'abord");
        const checked = validateModelsDir(stored, kernelDirs());
        if (!checked.ok) return fail("BAD_MODELS_DIR", checked.reason);
        const svc = service(token);
        const info = await svc.repoInfo(repo, { signal: controller.signal });
        remember(info);
        if (info.sha !== sha) return fail("REPO_CHANGED", `le dépôt a changé depuis la liste (révision ${sha.slice(0, 7)} → ${info.sha.slice(0, 7)}) : relisez la liste puis confirmez de nouveau`);
        const entries = keys.map((k) => info.entries.find((e) => e.key === k) ?? fail("STALE_LIST", `entrée inconnue dans le dépôt : ${k}`));
        for (const e of entries) if (!e.complete) fail("NOT_DOWNLOADABLE", `${e.key} : fragment(s) manquant(s) dans le dépôt (${e.missing.join(", ")}), jeu non téléchargeable`);
        const seen = new Set<string>();
        const files = entries.flatMap((e) => entryDownloadFiles(e)).filter((f) => !seen.has(f.name) && seen.add(f.name));
        const destDir = join(checked.dir, repo.replace("/", "__"));
        const pre = await svc.preflight({ repo, revision: info.sha, files, destDir, signal: controller.signal });
        const verdicts = await verdictLines(info, entries, contextTokens, cacheType);

        if (!ctx.shell.confirm) return fail("DECLINED", "confirmation native indisponible, refusé");
        const lines: string[] = [
          `Dépôt : ${repo}`,
          `Révision : ${info.sha}`,
          `Licence : ${info.license ?? "non indiquée"}`,
          ...(info.gated !== false ? [`Dépôt « gated » : ${info.gated}`] : []),
          "",
          "Fichiers :",
          ...pre.files.map((f) => `- ${f.name} — ${f.size} octets (${gib(f.size)} Gio) — ${f.sha256 ? `SHA-256 ${f.sha256}` : "empreinte non publiée : seule la taille est vérifiée"}`),
          `Total : ${pre.sum} octets (${gib(pre.sum)} Gio)`,
          `Dossier de destination : ${destDir}`,
          `Espace libre : ${pre.free} octets (${gib(pre.free)} Gio)`,
          "",
          "Tient-il ? (indication, jamais un blocage) :",
          ...verdicts,
          "",
          "Annulable. Aucun fichier n'est utilisable avant la fin de la vérification.",
        ];
        const ok = await ctx.shell.confirm(`Télécharger ${pre.files.length} fichier(s) depuis huggingface.co ?`, lines.join("\n"), "Télécharger");
        if (!ok) return fail("DECLINED", "refusé par l'utilisateur");
        if (controller.signal.aborted) return fail("CANCELLED", "téléchargement annulé");

        const now = wiring.now ?? Date.now;
        const interval = wiring.progressIntervalMs ?? PROGRESS_MS;
        let lastAt = Number.NEGATIVE_INFINITY;
        let lastStage = "";
        const done = await svc.downloadSet({
          repo,
          revision: info.sha,
          files,
          destDir,
          signal: controller.signal,
          onProgress: (p) => {
            const t = now();
            if (p.stage !== lastStage || p.received >= p.total || t - lastAt >= interval) {
              lastAt = t;
              lastStage = p.stage;
              ctx.shell.send("hf-progress", { file: p.file, index: p.index, count: p.count, received: p.received, total: p.total, stage: p.stage });
            }
          },
        });
        return { destDir, files: done.map((d) => ({ name: d.name, path: d.path, bytes: d.bytes, sha256: d.sha256, verified: d.verified })) };
      } catch (e) {
        // Annulé par l'utilisateur à n'importe quelle étape (lecture de la fiche, transfert) : c'est une annulation, pas une panne de réseau.
        if (controller.signal.aborted) throw new Error("HF_CANCELLED: téléchargement annulé");
        throw userError(e, token);
      } finally {
        if (busy === controller) busy = null;
      }
    },

    "hf-download-cancel": (...args: unknown[]): boolean => {
      noArgs(args, "hf-download-cancel");
      busy?.abort();
      return busy !== null;
    },

    "hf-models-dir": (...args: unknown[]): { dir: string | null } => {
      noArgs(args, "hf-models-dir");
      return { dir: storedModelsDir() };
    },

    /** Boîte « Choisir un dossier » NATIVE : le dossier des modèles, une fois. Refusé s'il est dans le profil ou sous la racine des données. */
    "hf-pick-models-dir": async (...args: unknown[]): Promise<{ dir: string } | null> => {
      noArgs(args, "hf-pick-models-dir");
      if (!ctx.shell.pickDestinationFolder) return fail("NO_DIALOG", "boîte « Choisir un dossier » native indisponible, refusé");
      // Phase 4 (audit v4) : la présélection vient du RÉGLAGE du profil (`localEngine.modelsDir`, « choisi
      // UNE fois » dans cette même boîte) — plus d'un chemin d'une machine codé en dur dans le main livré
      // (`S:\Stack-Hermes\IA\models`, absent de toute autre installation). `wiring.defaultModelsDir` reste
      // prioritaire : c'est le canal des tests, et `presetFolder` écarte de toute façon un chemin inexistant.
      const fromProfile = ctx.kernel().agent.settings.get("localEngine")?.modelsDir;
      const preset = presetFolder(wiring.defaultModelsDir ?? fromProfile);
      const picked = await ctx.shell.pickDestinationFolder("Dossier des modèles Hugging Face", preset);
      if (!picked) return null;
      const checked = validateModelsDir(picked, kernelDirs());
      if (!checked.ok) return fail("BAD_MODELS_DIR", checked.reason);
      const engine = ctx.kernel().localEngine?.engine;
      if (!engine) return fail("NO_MODELS_DIR", "moteur local indisponible : le dossier ne peut pas être enregistré");
      const dir = resolve(picked);
      engine.setModelsDir(dir);
      return { dir };
    },
  };
}
