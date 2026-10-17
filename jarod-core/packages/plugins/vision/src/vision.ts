// Portage de packages/core/src/services/vision.ts (rév. 2e180305).
import type { Db } from "@jarod/plugin-storage";
import type { ProviderRouter } from "@jarod/plugin-llm";
import type { ChatTurn } from "@jarod/contracts";
import type { AttachmentService, LoadedAttachment } from "@jarod/plugin-rag";
import type { SettingsService } from "@jarod/plugin-storage";
import { type ImageDescriptionConfig } from "@jarod/contracts";
export type { ImageDescriptionConfig };

/**
 * Images for models that cannot see them. A text-only model (DeepSeek, most local models) receives
 * a screenshot as bytes it cannot read, and answers beside the point or errors. Here a model that
 * can see — named by the user, never guessed: describing an image sends it to that provider — writes
 * a precise description once, which then travels in place of the image.
 *
 * Descriptions are kept per attachment: history is replayed at every step, and paying for the same
 * description ten times per conversation would be absurd.
 */

// ImageDescriptionConfig : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

export const DEFAULT_IMAGE_DESCRIPTION: ImageDescriptionConfig = { mode: "auto", provider: "", model: "" };

/**
 * Whether a model reads images, from its name. Deliberately generous with known families and
 * strict otherwise: an unknown model gets a description, which costs one call, rather than bytes
 * it cannot read.
 */
export function supportsVision(provider: string, model: string): boolean {
  const m = (model.toLowerCase().split("/").pop() ?? "").replace(/:.*$/, "");
  if (provider === "anthropic" || m.startsWith("claude")) return true;
  if (/^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4o|o1|o3|o4)/.test(m)) return true;
  if (m.includes("gemini") || /^gemma-?3/.test(m)) return true;
  if (/^grok-(4|2-vision|vision)/.test(m)) return true;
  return /(vision|[-_.]vl\b|[-_]vl[-_]|llava|moondream|minicpm-v|pixtral|llama-?4|internvl|glm-4(\.\d)?v|kimi-vl|multimodal|mistral-(small-3\.[12]|medium)|qwen[\d.]*-?omni)/.test(
    m,
  );
}

const PROMPT =
  "Décris cette image pour quelqu'un qui ne peut pas la voir et doit pourtant travailler avec. Recopie mot pour mot tout le texte visible (messages d'erreur, code, libellés, chiffres). Décris la mise en page, les éléments d'interface et leur état, les schémas et graphiques (axes, valeurs), puis les personnes, objets et couleurs utiles. Sois précis et factuel, sans préambule ni interprétation inutile. Réponds en français.";

const DESCRIBE_TIMEOUT_MS = 120_000;

export class ImageDescriber {
  constructor(
    private readonly d: {
      db: Db;
      settings: SettingsService;
      providers: ProviderRouter;
      attachments: AttachmentService;
    },
    /** Délai d'UNE description : un fournisseur qui ne répond jamais ne doit pas suspendre le tour (l'image est alors dite « non décrite »). */
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  config(): ImageDescriptionConfig {
    return { ...DEFAULT_IMAGE_DESCRIPTION, ...this.d.settings.get("imageDescription") };
  }

  /** Whether images sent to this target must be replaced by their description. */
  needed(target: { provider: string; model: string }): boolean {
    const cfg = this.config();
    if (cfg.mode === "off" || !cfg.provider || !cfg.model) return false;
    return cfg.mode === "always" || !supportsVision(target.provider, target.model);
  }

  cached(attachmentId: string): string | undefined {
    return this.d.db.get<{ text: string }>("SELECT text FROM image_descriptions WHERE attachment_id = ?", attachmentId)
      ?.text;
  }

  /** The description of one image: from the cache, or asked of the describing model. */
  async describe(image: LoadedAttachment, signal?: AbortSignal): Promise<string> {
    const hit = this.cached(image.id);
    if (hit) return hit;
    const cfg = this.config();
    const data = image.data ?? this.d.attachments.load(image).data;
    if (!data) throw new Error("image illisible");
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DESCRIBE_TIMEOUT_MS);
    const result = await this.d.providers.client(cfg.provider).chat(
      {
        model: cfg.model,
        system: "",
        messages: [{ role: "user", content: PROMPT, attachments: [{ ...image, kind: "image", data }] }],
        tools: [],
        maxTokens: 2000,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
      {},
    );
    const text = result.text.trim();
    if (!text) throw new Error("le modèle de description n'a rien répondu");
    this.d.db.run(
      "INSERT INTO image_descriptions (attachment_id, model, text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(attachment_id) DO UPDATE SET model = excluded.model, text = excluded.text, created_at = excluded.created_at",
      image.id,
      `${cfg.provider}:${cfg.model}`,
      text,
      Date.now(),
    );
    return text;
  }

  /**
   * The turns with each image replaced by its description, as a text attachment every client
   * already knows how to send. An image that cannot be described says why, instead of failing the
   * whole turn. `onDescribe` is told before each new (uncached) description: it takes a few seconds.
   */
  async prepare(turns: ChatTurn[], signal?: AbortSignal, onDescribe?: (name: string) => void): Promise<ChatTurn[]> {
    const cfg = this.config();
    const out: ChatTurn[] = [];
    for (const t of turns) {
      if (!t.attachments?.some((a) => a.kind === "image")) {
        out.push(t);
        continue;
      }
      const attachments: LoadedAttachment[] = [];
      for (const a of t.attachments) {
        if (a.kind !== "image") {
          attachments.push(a);
          continue;
        }
        let text: string;
        try {
          if (!this.cached(a.id)) onDescribe?.(a.name);
          const description = await this.describe(a, signal);
          text = `Description automatique de l'image (par ${cfg.model}, tu ne vois pas l'image elle-même) :\n${description}`;
        } catch (e) {
          if (signal?.aborted) throw e;
          text = `[Image non décrite : ${(e as Error).message}]`;
        }
        const { data: _data, ...rest } = a;
        attachments.push({ ...rest, kind: "text", text });
      }
      out.push({ ...t, attachments });
    }
    return out;
  }
}
