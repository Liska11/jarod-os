/**
 * Transfert d'UN fichier de modèle vers son `.part` (SPECS-P5-MODELS.md § 3.2 et § 3.9 (c)) : octets comptés, SHA-256 calculé au fil de l'eau, abandon dès que
 * le flux dépasse la taille publiée, `.part` créé en EXCLUSIF. Cette fonction n'écrit que le `.part` et ne supprime rien : l'orchestration (renommage après
 * vérification de TOUT le jeu, suppression journalisée) est dans `HuggingFaceService.downloadSet`.
 */
import { createHash } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { HF_MAX_REDIRECTS, followHfRedirects, linkedSizeProblem, parseRetryAfter } from "./hf-fetch.js";

export type HfDownloadErrorCode =
  | "INVALID_REVISION"
  | "INVALID_EXPECTED"
  | "DUPLICATE_TARGET"
  | "ALREADY_PRESENT"
  | "PART_EXISTS"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "HTTP"
  | "RATE_LIMITED"
  | "HOST_REFUSED"
  | "TOO_MANY_REDIRECTS"
  | "INSUFFICIENT_SPACE"
  | "INCOMPLETE_SET"
  | "CANCELLED"
  | "NETWORK"
  | "WRITE_FAILED"
  | "RENAME_FAILED"
  /** `X-Linked-Size` du premier saut ≠ taille de l'API : refusé avant le premier octet de corps (chantier 5a). */
  | "LINKED_SIZE_MISMATCH";

export class HfDownloadError extends Error {
  constructor(
    readonly code: HfDownloadErrorCode,
    message: string,
    readonly details: {
      received?: number;
      expected?: number;
      status?: number;
      retryAfterSeconds?: number | null;
      conflicts?: { name: string; localBytes: number | null; announcedBytes: number }[];
    } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "HfDownloadError";
  }
  /** Octets reçus au moment du rejet (`SIZE_MISMATCH`). */
  get received(): number | undefined {
    return this.details.received;
  }
  /** Taille publiée attendue (`SIZE_MISMATCH`). */
  get expected(): number | undefined {
    return this.details.expected;
  }
  get status(): number | undefined {
    return this.details.status;
  }
  /** Pour `RATE_LIMITED` : secondes à attendre d'après `Retry-After` (secondes ou date HTTP), `null` si absent ou illisible. */
  get retryAfterSeconds(): number | null | undefined {
    return this.details.retryAfterSeconds;
  }
}

/** Une suppression faite par le service : chemin, taille, motif (SPECS-P5-MODELS.md § 3.2, point 5 : CHAQUE suppression est journalisée). */
export interface HfRemoval {
  path: string;
  bytes: number;
  reason: string;
}

export interface HfProgress {
  file: string;
  /** Rang du fichier dans l'opération (0, 1, …) et nombre de fichiers. */
  index: number;
  count: number;
  received: number;
  total: number;
  stage: "download" | "verify" | "finalize";
}

/** Supprime un fichier NOTRE (un `.part`, ou une cible renommée par cette opération) et journalise : chemin, taille, motif. Absent = rien à faire, rien à dire. */
export function removeJournaled(path: string, reason: string, journal: (e: HfRemoval) => void): void {
  let bytes: number;
  try {
    bytes = lstatSync(path).size;
  } catch {
    return;
  }
  try {
    rmSync(path, { force: true });
    journal({ path, bytes, reason });
  } catch (error) {
    journal({ path, bytes, reason: `ÉCHEC de la suppression (${(error as Error).message}) : ${reason}` });
  }
}

export interface StreamToPartOptions {
  url: URL;
  /** Origines de confiance (l'origine de base, et en test un second serveur factice) ; tout autre hôte doit être `huggingface.co` / `hf.co` en https. */
  trusted: readonly string[];
  /** En-têtes de CHAQUE saut : le jeton ne part qu'à l'origine de base. */
  headersFor: (url: URL) => Record<string, string>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  partPath: string;
  /** Taille publiée et empreinte publiée (`null` : non publiée, seule la taille est vérifiée). */
  expected: { size: number; sha256: string | null };
  /** Appelé dès que le `.part` EXISTE (créé par cette opération) : seul un `.part` annoncé ici sera supprimé par l'appelant. */
  onCreated: (partPath: string) => void;
  onProgress: (received: number, stage: "download" | "verify") => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function streamToPart(o: StreamToPartOptions): Promise<{ bytes: number; sha256: string }> {
  const cancelled = () => o.signal?.aborted === true;
  const cancelError = () => new HfDownloadError("CANCELLED", "téléchargement annulé");
  if (cancelled()) throw cancelError();

  // Un contrôleur interne : l'annulation de l'appelant ET l'abandon sur dépassement coupent la même connexion.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let response: Response;
    try {
      // Redirections MANUELLES (3 au plus, hôte vérifié à chaque saut, jeton retiré hors de l'origine de base) : chaque saut passe par `fetchImpl`.
      response = await followHfRedirects({
        url: o.url,
        trusted: o.trusted,
        maxRedirects: HF_MAX_REDIRECTS,
        fetchImpl: o.fetchImpl,
        signal: ctl.signal,
        headersFor: o.headersFor,
        onRedirect: (res) => {
          const problem = linkedSizeProblem(res, o.expected.size);
          if (problem) throw new HfDownloadError("LINKED_SIZE_MISMATCH", problem, { received: 0, expected: o.expected.size });
        },
        fail: (code, text, status) => new HfDownloadError(code, text, status === undefined ? {} : { status }),
      });
    } catch (error) {
      if (error instanceof HfDownloadError) throw error;
      throw cancelled() ? cancelError() : new HfDownloadError("NETWORK", `requête impossible : ${message(error)}`);
    }
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      throw new HfDownloadError("RATE_LIMITED", "Hugging Face limite le débit", { status: 429, retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) });
    }
    // Une réponse partielle (206) à une requête sans `Range` n'est pas le fichier : refusée.
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new HfDownloadError("HTTP", `téléchargement refusé (${response.status})`, { status: response.status });
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(o.partPath, "wx"); // EXCLUSIF : jamais par-dessus un fichier existant
    } catch (error) {
      void response.body.cancel().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HfDownloadError("PART_EXISTS", `${o.partPath} existe déjà : il n'est ni écrasé ni supprimé`);
      throw new HfDownloadError("WRITE_FAILED", `création de ${o.partPath} impossible : ${message(error)}`);
    }
    o.onCreated(o.partPath);

    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw cancelled() ? cancelError() : new HfDownloadError("NETWORK", `transfert interrompu : ${message(error)}`);
        }
        if (chunk.done) break;
        const value = chunk.value;
        received += value.length;
        if (received > o.expected.size) {
          // Plus long que la taille publiée : abandon IMMÉDIAT, on ne lit pas le reste.
          ctl.abort();
          throw new HfDownloadError("SIZE_MISMATCH", `le flux dépasse la taille publiée (${o.expected.size} octets)`, { received, expected: o.expected.size });
        }
        hash.update(value);
        try {
          await handle.write(value);
        } catch (error) {
          ctl.abort();
          throw new HfDownloadError("WRITE_FAILED", `écriture de ${o.partPath} impossible : ${message(error)}`);
        }
        o.onProgress(received, "download");
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }

    o.onProgress(received, "verify");
    if (received !== o.expected.size) {
      throw new HfDownloadError("SIZE_MISMATCH", `${received} octets reçus, la fiche annonce ${o.expected.size}`, { received, expected: o.expected.size });
    }
    const digest = hash.digest("hex");
    if (o.expected.sha256 !== null && digest !== o.expected.sha256) {
      throw new HfDownloadError("HASH_MISMATCH", `SHA-256 reçu ${digest}, publié ${o.expected.sha256}`);
    }
    return { bytes: received, sha256: digest };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
  }
}
