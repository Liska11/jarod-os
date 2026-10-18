/**
 * Modèles locaux en mémoire (llama.cpp piloté par Jarod, LM Studio) : canaux PROPRES à Jarod `local-models-*`. Le volet « Local engine » liste
 * ce que chaque serveur a, ce qui est chargé, et offre « Charger » / « Décharger » ; l'interrupteur « Hotswap » (`localModels.hotswap`) garde un
 * seul modèle de chat local en mémoire et charge celui que le chat choisit (`LocalModelsService`, plugin-llm).
 *
 * Règles :
 * - l'écran ne nomme qu'un moteur de la liste fermée et un identifiant que CE moteur connaît (préréglage enregistré, clé listée par LM Studio) :
 *   aucun chemin, aucune adresse ne vient du renderer — l'adresse de LM Studio est celle du fournisseur ;
 * - décharger ne touche que ce que l'utilisateur désigne ; le hotswap ne décharge jamais un modèle d'embeddings ;
 * - un seul chargement à la fois (le service les enchaîne) ;
 * - la longueur de contexte d'un modèle LM Studio est un entier, borné par ce que le modèle accepte (`max_context_length`).
 */
import { LOCAL_BACKENDS, type LocalBackend, type LocalModelsService, type LocalModelsView } from "@jarod/plugin-llm";
import type { HandlerContext } from "./context.js";

const bad = (why: string): never => {
  throw new Error(`[oneai] modèles locaux : ${why}`);
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: intended, rejects input that contains control characters
const ID = /^[^\u0000-\u001f]{1,300}$/;

function backendOf(v: unknown): LocalBackend {
  return typeof v === "string" && (LOCAL_BACKENDS as readonly string[]).includes(v) ? (v as LocalBackend) : bad(`moteur attendu parmi ${LOCAL_BACKENDS.join(", ")}`);
}

function idOf(v: unknown): string {
  return typeof v === "string" && ID.test(v) ? v : bad("identifiant de modèle attendu");
}

/**
 * Chaque chargement / déchargement (volet, hotswap du chat, déchargements que fait le hotswap) → événement `local-models-activity` vers la
 * fenêtre : la notification « Chargement de … » puis « … chargé (N s) » ou l'erreur. Rebranché à chaque kernel ouvert.
 */
export function bindLocalModelsEvents(models: LocalModelsService | undefined, send: (channel: string, ...args: unknown[]) => void): () => void {
  return models ? models.onActivity((a) => send("local-models-activity", a)) : () => {};
}

export function createLocalModelsHandlers(ctx: HandlerContext) {
  const service = () => ctx.kernel().localEngine?.models ?? bad("indisponibles (plugin-llm désactivé)");

  return {
    "local-models-list": (): Promise<LocalModelsView> => service().list(),

    "local-models-load": (backend: unknown, id: unknown): Promise<LocalModelsView> => service().load(backendOf(backend), idOf(id)),

    "local-models-unload": (backend: unknown, id: unknown): Promise<LocalModelsView> => service().unload(backendOf(backend), idOf(id)),

    // Un réglage par appel : `{ hotswap }`, ou `{ contextLength: { model, tokens } }` (LM Studio ; `tokens: null` = celle de LM Studio).
    "local-models-configure": (patch: unknown): Promise<LocalModelsView> => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return bad("réglages attendus");
      const o = patch as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => k !== "hotswap" && k !== "contextLength");
      if (extra.length) return bad(`champ(s) non accepté(s) : ${extra.join(", ")}`);
      if (Object.keys(o).length !== 1) return bad("un seul réglage à la fois (« hotswap » ou « contextLength »)");
      if ("hotswap" in o) {
        if (typeof o.hotswap !== "boolean") return bad("« hotswap » : booléen attendu");
        return service().setHotswap(o.hotswap);
      }
      const c = o.contextLength as Record<string, unknown> | null;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => k !== "model" && k !== "tokens")) return bad("« contextLength » : { model, tokens } attendu");
      const tokens = c.tokens;
      if (tokens !== null && !(typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0 && tokens <= 16_777_216)) return bad("« contextLength.tokens » : entier positif ou null attendu");
      return service().setContextLength(idOf(c.model), tokens);
    },
  };
}
