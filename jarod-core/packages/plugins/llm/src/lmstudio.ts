/**
 * LM Studio's own REST API (v1, LM Studio 0.4+): the models it has on disk, which are loaded, and the gestures to load and unload them. Read on
 * the running server of this machine (2026-10-06): `GET /api/v1/models` → `{ models: [{ type, key, display_name, size_bytes, loaded_instances:
 * [{ id, config: { context_length, … } }], max_context_length, … }] }` ; `POST /api/v1/models/load { model, context_length? }` → `{ instance_id,
 * status: "loaded" }` ;
 * `POST /api/v1/models/unload { instance_id }`.
 *
 * The address is the LM Studio provider's (catalogue + override), its OpenAI `/v1` suffix removed; its key, when the user gave one (LM Studio's
 * « Require authentication »), goes as a Bearer token to that same address and nowhere else.
 */

export interface LmStudioModel {
  /** The identifier LM Studio loads and the chat names (`jean-1.0-27b@iq4_xs`). */
  key: string;
  name: string;
  /** `llm`, `vlm` or `embedding`: embeddings are never unloaded by a hotswap. */
  type: string;
  sizeBytes: number | null;
  maxContext: number | null;
  /** Ids of the loaded instances (empty: not loaded). */
  instances: string[];
  /** The context length the first loaded instance was loaded with (`loaded_instances[0].config.context_length`); null: not loaded or not said. */
  loadedContext: number | null;
}

interface RawModel {
  type?: unknown;
  key?: unknown;
  display_name?: unknown;
  size_bytes?: unknown;
  max_context_length?: unknown;
  loaded_instances?: { id?: unknown; config?: { context_length?: unknown } }[];
}

const LIST_TIMEOUT_MS = 5_000;
const UNLOAD_TIMEOUT_MS = 60_000;
/** Loading a large model from disk takes minutes on a slow drive. */
const LOAD_TIMEOUT_MS = 10 * 60_000;

export const isChatModel = (m: Pick<LmStudioModel, "type">): boolean => m.type !== "embedding";

export class LmStudioClient {
  constructor(
    private readonly d: {
      /** The provider's current address (`http://localhost:1234/v1`) and key: read at every call, the user may change them. */
      endpoint: () => { baseUrl: string; key?: string };
      fetchImpl?: typeof fetch;
    },
  ) {}

  private root(): string {
    const base = this.d.endpoint().baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error(`Adresse de LM Studio invalide : ${base || "(vide)"}`);
    return base.replace(/\/v1$/i, "");
  }

  private async call(path: string, init: { body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    const key = this.d.endpoint().key;
    const signals = [AbortSignal.timeout(init.timeoutMs), ...(init.signal ? [init.signal] : [])];
    const res = await (this.d.fetchImpl ?? fetch)(`${this.root()}${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const err = (JSON.parse(text) as { error?: { message?: unknown } | string }).error;
        message = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : message;
      } catch {}
      throw new Error(`LM Studio a refusé ${path} (HTTP ${res.status})${message ? ` : ${message}` : ""}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`LM Studio : réponse illisible pour ${path}`);
    }
  }

  async list(signal?: AbortSignal): Promise<LmStudioModel[]> {
    const body = (await this.call("/api/v1/models", { timeoutMs: LIST_TIMEOUT_MS, ...(signal ? { signal } : {}) })) as { models?: RawModel[] };
    if (!Array.isArray(body.models)) throw new Error("LM Studio : liste de modèles absente (API REST v1 requise : LM Studio 0.4 ou plus récent)");
    return body.models.flatMap((m) => {
      if (typeof m.key !== "string" || !m.key) return [];
      const loaded = (Array.isArray(m.loaded_instances) ? m.loaded_instances : []).filter((i) => typeof i?.id === "string");
      const ctx = loaded[0]?.config?.context_length;
      return [
        {
          key: m.key,
          name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.key,
          type: typeof m.type === "string" ? m.type : "llm",
          sizeBytes: typeof m.size_bytes === "number" ? m.size_bytes : null,
          maxContext: typeof m.max_context_length === "number" ? m.max_context_length : null,
          instances: loaded.map((i) => i.id as string),
          loadedContext: typeof ctx === "number" ? ctx : null,
        },
      ];
    });
  }

  /** `contextLength`: sent as `context_length` (documented field of `POST /api/v1/models/load`); absent, LM Studio picks its own. */
  async load(model: string, signal?: AbortSignal, contextLength?: number): Promise<string> {
    const request = { model, ...(contextLength ? { context_length: contextLength } : {}) };
    const body = (await this.call("/api/v1/models/load", { body: request, timeoutMs: LOAD_TIMEOUT_MS, ...(signal ? { signal } : {}) })) as { instance_id?: unknown };
    return typeof body.instance_id === "string" ? body.instance_id : model;
  }

  async unload(instanceId: string): Promise<void> {
    await this.call("/api/v1/models/unload", { body: { instance_id: instanceId }, timeoutMs: UNLOAD_TIMEOUT_MS });
  }
}
