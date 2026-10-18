// Portage de packages/core/src/services/huggingface.ts (rév. 2e180305).
import { type Stats, lstatSync, renameSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  encodeFilePath,
  encodeRepoPath,
  ensureDirUnder,
  fileNameProblem,
  repoIdProblem,
  resolveUnder,
  validateFileName,
  validateRepoId,
} from "./hf-names.js";
import { type HttpRangeSource, httpRangeSource } from "./gguf-range.js";
import { HF_BASE_URL, HfApiError, followHfRedirects, isHfUrlAllowed, parseRetryAfter } from "./hf-fetch.js";
import { type HfCandidate, type HfEntry, type HfRepoFile, candidateFromSibling, candidateFromTreeEntry, entryDownloadFiles, groupGgufFiles, linkNext, parseFiche } from "./hf-repo.js";
import { HfDownloadError, type HfProgress, type HfRemoval, removeJournaled, streamToPart } from "./hf-transfer.js";

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
  tags: string[];
}

export interface HfFile {
  name: string;
  /** Le service ne l'annonce pas toujours : null veut dire « inconnu », pas « zéro ». */
  bytes: number | null;
}

/** Marge d'espace disque exigée EN PLUS de la somme des tailles (SPECS-P5-MODELS.md § 3.2 point 1). */
export const HF_DISK_MARGIN_BYTES = 1024 * 1024 * 1024;
/** Réponse JSON de métadonnées : 5 Mio au plus (§ 5). */
export const HF_JSON_MAX_BYTES = 5 * 1024 * 1024;
/** Pages `tree` suivies au plus par lecture de dépôt. */
export const HF_MAX_TREE_PAGES = 20;

/** Un nom écarté (identifiant de dépôt ou nom de fichier venant de l'API) : jamais montré, signalé avec sa raison. */
export type HfSkipped = (name: unknown, reason: string) => void;

/** La fiche d'un dépôt, prête pour l'écran : révision épinglée, statut « gated », licence, et les modèles (fragments regroupés). */
export interface HfRepoInfo {
  repo: string;
  /** Commit courant de la fiche : c'est LA révision à épingler pour tout transfert (`resolve/<sha>/…`). */
  sha: string;
  /** `false` ou la valeur annoncée (« manual » observé) : tout ce qui n'est pas `false` s'affiche « gated ». */
  gated: false | string;
  license: string | null;
  entries: HfEntry[];
  /** Vrai quand le plafond de 500 entrées a coupé la liste. */
  truncated: boolean;
  /** D'où viennent les tailles et empreintes : `blobs` (une requête) ou `tree` (repli, une taille manquait). */
  source: "blobs" | "tree";
}

const defaultFreeBytes = (dir: string): number => {
  const stat = statfsSync(dir);
  return Number(stat.bavail) * Number(stat.bsize);
};

/** Le plus proche dossier EXISTANT de `dir` (la destination peut ne pas exister encore : elle est créée après le contrôle d'espace). */
function nearestExisting(dir: string): string {
  let probe = resolve(dir);
  while (statOrNull(probe) === null && dirname(probe) !== probe) probe = dirname(probe);
  return probe;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new HfApiError("NETWORK", `lecture interrompue : ${(error as Error).message}`);
    }
    if (chunk.done) break;
    n += chunk.value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new HfApiError("TOO_LARGE", `réponse de plus de ${max} octets`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Chercher et télécharger un modèle GGUF.
 *
 * Jarod-one se dit local-first et ne savait pas obtenir un modèle : Ollama tire les siens, mais rien
 * ne pouvait récupérer un GGUF pour llama-server. Le catalogue nommait des dépôts, et l'utilisateur
 * devait se débrouiller avec un navigateur.
 *
 * Deux règles. L'écriture va dans un fichier `.part` renommé seulement à la fin : un téléchargement
 * interrompu ne laisse pas un fichier tronqué qui aurait l'air d'un modèle complet — et à
 * l'interruption, le `.part` est supprimé. Et la taille annoncée est celle du service ou rien du
 * tout : un zéro inventé ferait paraître un fichier absent plus petit qu'il ne l'est.
 */
export class HuggingFaceService {
  private readonly base: string;
  private readonly trusted: readonly string[];

  /**
   * `baseUrl` : l'hôte de l'API (défaut `https://huggingface.co`). Réservé au code : le serveur factice des tests le passe ; aucun réglage, canal IPC ni
   * variable d'environnement ne l'alimente ici (la variable de test et sa triple garde sont le chantier 4 de SPECS-P5-MODELS.md).
   */
  constructor(
    private readonly d: {
      fetchImpl?: typeof fetch;
      token?: string;
      baseUrl?: string;
      /** Reçoit CHAQUE suppression faite par le service (chemin, taille, motif). Défaut : une ligne `[hf]` dans la console. */
      journal?: (e: HfRemoval) => void;
      /** Renommage final (tests : échec injecté). Défaut : `fs.renameSync`. */
      rename?: typeof renameSync;
      /** Origines de CDN supplémentaires admises — RÉSERVÉ au code (tests : un second serveur factice) ; aucun réglage ni canal IPC ne l'alimente. */
      extraTrustedOrigins?: readonly string[];
      /** Octets libres sur un dossier existant (tests : valeur imposée). Défaut : `statfs`. Une lecture qui échoue = espace indéterminable = refus. */
      freeBytes?: (dir: string) => number | Promise<number>;
    } = {},
  ) {
    const url = new URL(d.baseUrl ?? HF_BASE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`HUGGINGFACE_FAILED: adresse de base invalide (${url.protocol})`);
    this.base = url.origin;
    this.trusted = [url.origin, ...(d.extraTrustedOrigins ?? [])];
  }

  private get fetchImpl(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }

  /** En-têtes d'une requête vers `url` : le jeton (s'il existe) ne part QU'à l'origine de base, jamais à un CDN ni à un autre hôte. */
  private headersFor(url: URL, extra: Record<string, string> = {}): Record<string, string> {
    const headers = { ...extra };
    if (this.d.token && url.origin === this.base) headers.Authorization = `Bearer ${this.d.token}`;
    return headers;
  }

  /**
   * Une source d'octets `Range` sur UN fichier du dépôt, à la révision ÉPINGLÉE (jamais `main`) : même transport, même jeton (à l'origine de base seulement), mêmes
   * hôtes que le reste du service. `expectedSize` : taille publiée par l'API, recoupée avec `X-Linked-Size` et `Content-Range`. Lecture de métadonnées : aucun octet écrit.
   */
  rangeSource(o: { repo: string; revision: string; file: string; expectedSize?: number; signal?: AbortSignal; timeoutMs?: number }): HttpRangeSource {
    validateRepoId(o.repo);
    validateFileName(o.file);
    return httpRangeSource({
      url: `${this.base}/${encodeRepoPath(o.repo)}/resolve/${o.revision}/${encodeFilePath(o.file)}`,
      baseUrl: this.base,
      ...(this.d.extraTrustedOrigins ? { extraTrustedOrigins: this.d.extraTrustedOrigins } : {}),
      ...(o.expectedSize === undefined ? {} : { expectedSize: o.expectedSize }),
      ...(this.d.token ? { token: this.d.token } : {}),
      fetchImpl: this.fetchImpl,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    });
  }

  /** GET JSON de métadonnées : redirections manuelles, 429 défensif (jamais relancé), 5 Mio au plus, corps JSON exigé. */
  private async apiJson(url: URL, what: string, signal?: AbortSignal): Promise<{ json: unknown; headers: Headers }> {
    let res: Response;
    try {
      res = await followHfRedirects({
        url,
        trusted: this.trusted,
        fetchImpl: this.fetchImpl,
        signal,
        headersFor: (u) => this.headersFor(u, { Accept: "application/json" }),
        fail: (code, message, status) => new HfApiError(code, message, status === undefined ? {} : { status }),
      });
    } catch (error) {
      if (error instanceof HfApiError) throw error;
      throw new HfApiError("NETWORK", `requête impossible : ${(error as Error).message}`);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      throw new HfApiError("RATE_LIMITED", "Hugging Face limite le débit", { status: 429, retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")) });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new HfApiError("HTTP", `${what} (${res.status})`, { status: res.status });
    }
    const text = await readCapped(res, HF_JSON_MAX_BYTES);
    try {
      return { json: JSON.parse(text), headers: res.headers };
    } catch {
      throw new HfApiError("BAD_RESPONSE", "la réponse n'est pas du JSON");
    }
  }

  /** Cherche des dépôts GGUF. Le filtre est dans la requête, pas appliqué après coup. */
  async search(query: string, limit = 20, opts: { onSkipped?: HfSkipped } = {}): Promise<HfModel[]> {
    const url = `${this.base}/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=${Math.min(Math.max(limit, 1), 100)}`;
    const { json } = await this.apiJson(new URL(url), "recherche refusée");
    const rows = json as {
      id?: string;
      downloads?: number;
      likes?: number;
      tags?: string[];
    }[];
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row.id)
      .filter((row) => {
        // Un identifiant venu de l'API est une entrée non fiable : un identifiant invalide n'est jamais montré, donc jamais ouvert.
        const problem = repoIdProblem(row.id);
        if (problem) opts.onSkipped?.(row.id, problem);
        return problem === null;
      })
      .map((row) => ({
        id: String(row.id),
        downloads: Number(row.downloads ?? 0),
        likes: Number(row.likes ?? 0),
        tags: Array.isArray(row.tags) ? row.tags : [],
      }));
  }

  /** Les fichiers GGUF d'un dépôt. Les deviner par convention raterait les dépôts qui font autrement. */
  async files(repo: string, opts: { onSkipped?: HfSkipped } = {}): Promise<HfFile[]> {
    validateRepoId(repo); // avant toute requête
    const { json } = await this.apiJson(new URL(`${this.base}/api/models/${encodeRepoPath(repo)}`), `dépôt ${repo} illisible`);
    const detail = json as { siblings?: { rfilename?: string; size?: number }[] };
    return (detail.siblings ?? [])
      .filter((sibling) => (sibling.rfilename ?? "").toLowerCase().endsWith(".gguf"))
      .filter((sibling) => {
        const problem = fileNameProblem(sibling.rfilename);
        if (problem) opts.onSkipped?.(sibling.rfilename, problem.reason);
        return problem === null;
      })
      .map((sibling) => ({
        name: String(sibling.rfilename),
        bytes: typeof sibling.size === "number" && sibling.size > 0 ? sibling.size : null,
      }));
  }

  /**
   * La fiche d'un dépôt pour l'écran (SPECS-P5-MODELS.md § 3.4 et § 3.9) : UNE requête `?blobs=true` (tailles et SHA-256 publiés), repli sur `tree` à la révision
   * ÉPINGLÉE quand une taille manque, fragments regroupés en une entrée. Le résumé `gguf` de la fiche n'est jamais lu (le verdict vient de l'en-tête du fichier).
   */
  async repoInfo(repo: string, opts: { onSkipped?: HfSkipped; signal?: AbortSignal } = {}): Promise<HfRepoInfo> {
    validateRepoId(repo);
    const url = new URL(`${this.base}/api/models/${encodeRepoPath(repo)}`);
    url.searchParams.set("blobs", "true");
    const { json } = await this.apiJson(url, `dépôt ${repo} illisible`, opts.signal);
    const fiche = parseFiche(json);
    let candidates = fiche.siblings.map(candidateFromSibling).filter((c): c is HfCandidate => c !== null);
    let source: "blobs" | "tree" = "blobs";
    if (candidates.some((c) => c.problem === null && c.size === null)) {
      candidates = await this.readTree(repo, fiche.sha, opts.signal);
      source = "tree";
    }
    const files: HfRepoFile[] = [];
    for (const c of candidates) {
      if (c.problem !== null) opts.onSkipped?.(c.name, c.problem);
      else if (c.size === null) opts.onSkipped?.(c.name, "taille non publiée par Hugging Face : le téléchargement ne pourrait pas être vérifié");
      else files.push({ name: c.name, size: c.size, sha256: c.sha256 });
    }
    const { entries, truncated } = groupGgufFiles(files);
    return { repo, sha: fiche.sha, gated: fiche.gated, license: fiche.license, entries, truncated, source };
  }

  /** `tree?recursive=true` à la révision épinglée ; pages suivies par l'en-tête `Link … rel="next"` (hôte vérifié), 20 pages au plus. */
  private async readTree(repo: string, sha: string, signal?: AbortSignal): Promise<HfCandidate[]> {
    let url: URL | null = new URL(`${this.base}/api/models/${encodeRepoPath(repo)}/tree/${sha}`);
    url.searchParams.set("recursive", "true");
    url.searchParams.set("limit", "1000");
    const out: HfCandidate[] = [];
    for (let page = 0; url; page++) {
      if (page >= HF_MAX_TREE_PAGES) throw new HfApiError("TOO_MANY_PAGES", `plus de ${HF_MAX_TREE_PAGES} pages de fichiers pour ${repo}`);
      const { json, headers } = await this.apiJson(url, `liste des fichiers de ${repo} illisible`, signal);
      if (!Array.isArray(json)) throw new HfApiError("BAD_RESPONSE", "une page de fichiers n'est pas un tableau");
      for (const raw of json) {
        const c = candidateFromTreeEntry(raw);
        if (c) out.push(c);
      }
      const next = linkNext(headers.get("link"), url);
      if (next && !isHfUrlAllowed(next, this.trusted)) throw new HfApiError("HOST_REFUSED", `page suivante sur un hôte non admis : ${next.host}`);
      url = next;
    }
    return out;
  }

  /** Télécharge TOUTES les parties d'une entrée (un modèle découpé = un jeu complet) ; une entrée incomplète est rejetée AVANT toute requête. */
  async downloadEntry(opts: {
    repo: string;
    revision: string;
    entry: HfEntry;
    destDir: string;
    signal?: AbortSignal;
    onProgress?: (p: HfProgress) => void;
  }): Promise<HfDownloaded[]> {
    const files = entryDownloadFiles(opts.entry);
    return this.downloadSet({ repo: opts.repo, revision: opts.revision, files, destDir: opts.destDir, signal: opts.signal, onProgress: opts.onProgress });
  }

  /**
   * Télécharge UN fichier : `downloadSet` d'un jeu d'un seul fichier. `expected` vient de la fiche de l'API à la révision `revision` (jamais de l'`ETag` du CDN).
   */
  async download(opts: {
    repo: string;
    /** Commit épinglé (40 hexadécimaux) : jamais `main`. */
    revision: string;
    file: string;
    destDir: string;
    expected: { size: number; sha256: string | null };
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
  }): Promise<{ path: string; bytes: number; sha256: string; verified: HfVerified }> {
    const onProgress = opts.onProgress;
    const [done] = await this.downloadSet({
      repo: opts.repo,
      revision: opts.revision,
      destDir: opts.destDir,
      files: [{ name: opts.file, size: opts.expected?.size, sha256: opts.expected?.sha256 }] as never,
      signal: opts.signal,
      onProgress: onProgress ? (p) => p.stage === "download" && onProgress(p.received, p.total) : undefined,
    });
    return { path: done!.path, bytes: done!.bytes, sha256: done!.sha256, verified: done!.verified };
  }

  /**
   * Les contrôles d'un téléchargement qui ne demandent AUCUNE requête et n'écrivent RIEN : noms, révision et valeurs attendues valides ; aucune cible déjà présente
   * (Q5 : jamais d'écrasement) ; espace libre ≥ somme des tailles + marge (indéterminable = refus). `downloadSet` les rejoue en tête ; l'appelant qui veut refuser AVANT
   * d'afficher une boîte de confirmation les appelle d'abord. Rend les fichiers normalisés, leurs cibles et l'espace mesuré.
   */
  async preflight(opts: Pick<HfDownloadSetOptions, "repo" | "revision" | "files" | "destDir" | "signal">): Promise<{
    files: { name: string; size: number; sha256: string | null }[];
    targets: string[];
    sum: number;
    required: number;
    free: number;
  }> {
    // 1. Validation, sans aucune requête ni écriture.
    validateRepoId(opts.repo);
    if (!Array.isArray(opts.files) || opts.files.length === 0) throw new HfDownloadError("INVALID_EXPECTED", "aucun fichier à télécharger");
    for (const f of opts.files) validateFileName(f?.name);
    if (typeof opts.revision !== "string" || !PINNED.test(opts.revision)) {
      throw new HfDownloadError("INVALID_REVISION", "la révision doit être un commit épinglé de 40 hexadécimaux minuscules (jamais main)");
    }
    const files = opts.files.map((f) => {
      if (!Number.isSafeInteger(f.size) || f.size <= 0) throw new HfDownloadError("INVALID_EXPECTED", `${f.name} : taille attendue invalide (${String(f.size)})`);
      if (f.sha256 !== null && !(typeof f.sha256 === "string" && SHA256.test(f.sha256))) {
        throw new HfDownloadError("INVALID_EXPECTED", `${f.name} : empreinte SHA-256 attendue invalide`);
      }
      return { name: f.name, size: f.size, sha256: f.sha256 === null ? null : f.sha256.toLowerCase() };
    });
    const seen = new Set<string>();
    for (const f of files) {
      const key = f.name.toLowerCase();
      if (seen.has(key)) throw new HfDownloadError("DUPLICATE_TARGET", `${f.name} : deux noms désignent le même fichier`);
      seen.add(key);
    }
    const targets = files.map((f) => resolveUnder(opts.destDir, f.name));
    if (opts.signal?.aborted) throw new HfDownloadError("CANCELLED", "téléchargement annulé");

    // 2. Une cible présente refuse TOUT le jeu (Q5) : rien n'est écrasé, supprimé ni créé.
    const conflicts: { name: string; localBytes: number | null; announcedBytes: number }[] = [];
    files.forEach((f, i) => {
      const local = statOrNull(targets[i]!);
      if (local) conflicts.push({ name: f.name, localBytes: local.isFile() ? local.size : null, announcedBytes: f.size });
    });
    if (conflicts.length > 0) {
      const lines = conflicts.map((c) =>
        c.localBytes !== null && c.localBytes !== c.announcedBytes
          ? `${c.name} : déjà présent — fichier local de ${c.localBytes} octets, la fiche annonce ${c.announcedBytes} octets`
          : `${c.name} : déjà présent`,
      );
      throw new HfDownloadError("ALREADY_PRESENT", `${lines.join(" ; ")} (rien n'est écrasé ni supprimé : supprimez le fichier vous-même pour le remplacer)`, { conflicts });
    }

    // 2 bis. Espace libre : somme des tailles + marge, vérifié AVANT le premier octet ET avant de créer quoi que ce soit.
    const sum = files.reduce((n, f) => n + f.size, 0);
    const required = sum + HF_DISK_MARGIN_BYTES;
    const probe = nearestExisting(opts.destDir);
    let free = Number.NaN;
    try {
      free = await (this.d.freeBytes ?? defaultFreeBytes)(probe);
    } catch {
      free = Number.NaN;
    }
    if (!Number.isFinite(free) || free < 0) {
      throw new HfDownloadError("INSUFFICIENT_SPACE", `espace libre indéterminable sur ${probe} : il faut ${required} octets (tailles ${sum} + marge ${HF_DISK_MARGIN_BYTES})`);
    }
    if (free < required) {
      throw new HfDownloadError("INSUFFICIENT_SPACE", `espace libre insuffisant sur ${probe} : ${free} octets libres, il faut ${required} octets (tailles ${sum} + marge ${HF_DISK_MARGIN_BYTES})`);
    }

    return { files, targets, sum, required, free };
  }

  /**
   * Télécharge un jeu de fichiers (un modèle découpé = plusieurs fragments) à la révision épinglée, taille ET SHA-256 vérifiés (SPECS-P5-MODELS.md § 3.2).
   *
   *  - rien n'est demandé ni écrit tant que les noms, la révision et les valeurs attendues ne sont pas valides ;
   *  - une cible DÉJÀ PRÉSENTE refuse tout le jeu : jamais d'écrasement, jamais de suppression d'un fichier de l'utilisateur ;
   *  - chaque fichier va dans `<cible>.part`, créé en exclusif ; un `.part` orphelin du MÊME nom est supprimé (journalisé), aucun autre fichier ;
   *  - AUCUN renommage tant que tous les fichiers du jeu ne sont pas vérifiés : un jeu incomplet ne ressemble jamais à un modèle ;
   *  - annulation, erreur, rejet ou échec d'un renommage : tous les `.part` de l'opération sont supprimés, les cibles déjà renommées retirées (retour arrière) ;
   *    CHAQUE suppression est journalisée (chemin, taille, motif).
   */
  async downloadSet(opts: HfDownloadSetOptions): Promise<HfDownloaded[]> {
    // 1 à 2 bis. Validation, cible absente, espace libre : voir `preflight` (aucune requête, rien d'écrit).
    const { files, targets } = await this.preflight(opts);

    // 3. Dossiers (chemin réel vérifié), puis `.part` orphelins de CETTE opération — le seul cas où le service supprime quelque chose avant de transférer.
    targets.forEach((t) => { ensureDirUnder(opts.destDir, t); });
    const journal = this.d.journal ?? defaultJournal;
    const orphans = targets.map((t) => `${t}.part`).filter((p) => statOrNull(p) !== null);
    for (const p of orphans) {
      if (!statOrNull(p)!.isFile()) throw new HfDownloadError("PART_EXISTS", `${p} existe et n'est pas un fichier : rien n'est supprimé`);
    }
    for (const p of orphans) removeJournaled(p, "orphelin d'une opération interrompue (même nom que la cible de cette opération)", journal);

    // 4. Transfert de chaque fichier vers son `.part`, vérification ; RIEN n'est renommé avant la fin.
    const created: string[] = [];
    const renamed: string[] = [];
    let current: string | undefined;
    const results: HfDownloaded[] = [];
    const rename = this.d.rename ?? renameSync;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const part = `${targets[i]!}.part`;
        current = part;
        const url = new URL(`${this.base}/${encodeRepoPath(opts.repo)}/resolve/${opts.revision}/${encodeFilePath(f.name)}`);
        const done = await streamToPart({
          url,
          trusted: this.trusted,
          headersFor: (u) => this.headersFor(u, { "Accept-Encoding": "identity" }),
          fetchImpl: this.fetchImpl,
          signal: opts.signal,
          partPath: part,
          expected: { size: f.size, sha256: f.sha256 },
          onCreated: (p) => created.push(p),
          onProgress: (received, stage) => opts.onProgress?.({ file: f.name, index: i, count: files.length, received, total: f.size, stage }),
        });
        results.push({ name: f.name, path: targets[i]!, bytes: done.bytes, sha256: done.sha256, verified: f.sha256 === null ? "size-only" : "sha256" });
      }
      current = undefined;
      // 5. Tout le jeu est vérifié : renommage (même volume), une dernière vérification « cible absente » avant chacun.
      for (let i = 0; i < files.length; i++) {
        const target = targets[i]!;
        if (statOrNull(target)) throw new HfDownloadError("ALREADY_PRESENT", `${files[i]!.name} : une cible est apparue pendant le transfert, rien n'est écrasé`);
        try {
          rename(`${target}.part`, target);
        } catch (error) {
          throw new HfDownloadError("RENAME_FAILED", `renommage de ${files[i]!.name} impossible : ${(error as Error).message}`);
        }
        renamed.push(target);
        opts.onProgress?.({ file: files[i]!.name, index: i, count: files.length, received: files[i]!.size, total: files[i]!.size, stage: "finalize" });
      }
      return results;
    } catch (error) {
      const cause = causeOf(error);
      for (const part of created) {
        removeJournaled(part, part === current ? cause : `abandon de l'opération (${cause})`, journal);
      }
      for (const target of renamed) {
        removeJournaled(target, `retour arrière : un renommage a échoué (${cause}), un jeu incomplet ne doit pas ressembler à un modèle`, journal);
      }
      throw error;
    }
  }
}

const PINNED = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/** `verified` : « sha256 » = octets ET empreinte publiée vérifiés ; « size-only » = empreinte non publiée, seule la taille l'a été. */
export type HfVerified = "sha256" | "size-only";

export interface HfDownloadSetOptions {
  repo: string;
  /** Commit épinglé (40 hexadécimaux minuscules) : jamais `main`. */
  revision: string;
  /** Pour chaque fichier : le chemin dans le dépôt, la taille et l'empreinte PUBLIÉES par l'API à `revision` (`sha256: null` = non publiée). */
  files: { name: string; size: number; sha256: string | null }[];
  destDir: string;
  signal?: AbortSignal;
  onProgress?: (p: HfProgress) => void;
}

export interface HfDownloaded {
  name: string;
  path: string;
  bytes: number;
  /** SHA-256 calculé sur les octets reçus (comparé à l'empreinte publiée seulement quand elle l'est : voir `verified`). */
  sha256: string;
  verified: HfVerified;
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

const defaultJournal = (e: HfRemoval) => console.log(`[hf] suppression de ${e.path} (${e.bytes} octets) : ${e.reason}`);

function causeOf(error: unknown): string {
  const code = error instanceof HfDownloadError ? error.code : undefined;
  if (code === "CANCELLED") return "annulation";
  if (code === "SIZE_MISMATCH") return "taille non conforme";
  if (code === "HASH_MISMATCH") return "SHA-256 non conforme";
  if (code === "RENAME_FAILED") return "échec d'un renommage";
  return `erreur de transfert : ${code ?? (error as Error).message}`;
}
