import { DEFAULT_SETTINGS } from "@jarod/contracts";
import type { ToolDef } from "./registry.js";

/** Ce que les outils de réglages demandent à la base (chiffrée) du cœur : une fraction de `SettingsService`, donc testable avec un faux. */
export interface SettingsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  secretKeys(): string[];
}

/**
 * Les réglages que l'agent peut lire ET modifier : son aspect, son modèle, sa voix, ses limites de travail, sa mémoire. Une LISTE BLANCHE : un réglage
 * ajouté plus tard au schéma reste fermé à l'agent tant qu'on ne l'a pas décidé ici. Tout ce qui lui donnerait des droits (approbations, garde du shell,
 * accès aux fichiers, serveurs MCP), ouvrirait un canal vers l'extérieur (messageries, téléphone, API, webhooks, proxy, adresses des fournisseurs) ou
 * pointe vers un secret reste à l'utilisateur, dans Paramètres. Les clés API du coffre ne passent jamais par ici.
 */
export const AGENT_SETTINGS: ReadonlySet<string> = new Set([
  "language", "theme", "activeProvider", "activeModel", "fallbacks", "capabilityRouting", "persona", "thinking", "effort", "anthropicFallbacks",
  "memoryInject", "maxAgentSteps", "disabledSkills", "disabledTools", "agentMode", "autoTitle", "compactThreshold", "contextWindow",
  "sessionBudget", "imageDescription", "voice", "toolSearch", "learning", "curator", "browserVisible", "browserPersistent", "desktop",
]);

const MAX_SHOWN = 1_500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const same = (a: unknown, b: unknown): boolean => typeof a === typeof b && Array.isArray(a) === Array.isArray(b) && (a !== null) === (b !== null);

function show(v: unknown): string {
  const text = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}… (${text.length} caractères)` : text;
}

/** « voice.sttProvider » → la clé racine et le chemin qui suit. */
function split(path: string): { root: string; rest: string[] } {
  const [root = "", ...rest] = path.split(".");
  return { root, rest };
}

/**
 * Valide un réglage à écrire et rend la valeur racine complète à poser : une clé de la liste blanche, du même type que sa valeur par défaut ; un chemin
 * pointé (`voice.sttProvider`) ne remplace que cette feuille et garde le reste de l'objet. Lève avec la raison, dite telle quelle au modèle.
 */
export function planSetting(path: string, value: unknown, current: unknown): { root: string; next: unknown } {
  const { root, rest } = split(path.trim());
  if (!Object.hasOwn(DEFAULT_SETTINGS, root)) throw new Error(`Réglage inconnu : ${root || "(vide)"}. settings_read sans clé liste ceux que tu peux régler.`);
  if (!AGENT_SETTINGS.has(root)) {
    throw new Error(`« ${root} » est réservé à l'utilisateur (droits, accès ou secrets) : il le règle lui-même dans Paramètres.`);
  }
  const base = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[root];
  if (rest.length === 0) {
    if (!same(value, base)) throw new Error(`« ${root} » attend ${Array.isArray(base) ? "une liste" : isRecord(base) ? "un objet" : typeof base}.`);
    return { root, next: value };
  }
  if (rest.length > 1 || !isRecord(base)) throw new Error(`« ${path} » : seul « ${root}.clé » est possible, sur un réglage qui est un objet.`);
  const leaf = rest[0]!;
  // Un objet par défaut vide (capabilityRouting) est un dictionnaire : toute clé y est permise. Sinon la feuille doit exister.
  if (Object.keys(base).length > 0 && !Object.hasOwn(base, leaf)) {
    throw new Error(`« ${root} » n'a pas de « ${leaf} » (clés : ${Object.keys(base).join(", ")}).`);
  }
  if (Object.hasOwn(base, leaf) && !same(value, base[leaf])) throw new Error(`« ${path} » attend ${Array.isArray(base[leaf]) ? "une liste" : typeof base[leaf]}.`);
  return { root, next: { ...(isRecord(current) ? current : base), [leaf]: value } };
}

/**
 * L'agent se règle lui-même : il lit sa configuration dans la base chiffrée du cœur et change ce qui lui appartient. La lecture ne demande rien ; chaque
 * écriture demande l'accord de l'utilisateur avec l'ancienne et la nouvelle valeur sous les yeux.
 */
export function settingsTools(store: SettingsStore): ToolDef[] {
  const read = (path: string): unknown => {
    const { root, rest } = split(path);
    let v = store.get(root);
    for (const k of rest) v = isRecord(v) ? v[k] : undefined;
    return v;
  };
  return [
    {
      name: "settings_read",
      description:
        "Lit TA configuration (réglages, paramètres, config de Jarod) dans la base chiffrée. Sans clé : la liste de ce que tu peux régler avec les valeurs actuelles, et les NOMS des clés API enregistrées (jamais leurs valeurs). Avec `key` (ex. « voice », « voice.sttProvider ») : la valeur complète.",
      parameters: { type: "object", properties: { key: { type: "string" } } },
      dangerous: false,
      source: "builtin",
      async run(args) {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        if (key) {
          const { root } = split(key);
          if (!AGENT_SETTINGS.has(root)) return `« ${root} » est réservé à l'utilisateur (droits, accès ou secrets) : il le règle dans Paramètres.`;
          return `${key} = ${show(read(key))}`;
        }
        const lines = [...AGENT_SETTINGS].sort().map((k) => `- ${k} = ${show(store.get(k))}`);
        const secrets = store.secretKeys();
        return [
          "Réglages que tu peux changer (settings_write) :",
          ...lines,
          "",
          `Clés API enregistrées (noms seulement) : ${secrets.length ? secrets.join(", ") : "aucune"}.`,
          "Le reste (approbations, accès aux fichiers, garde du shell, serveurs MCP, messageries, appareils) se règle par l'utilisateur dans Paramètres.",
        ].join("\n");
      },
    },
    {
      name: "settings_write",
      description:
        "Change UN de tes réglages (modèle actif, fournisseur, persona, voix, étapes max, thème, langue…). `key` : le réglage (« activeModel ») ou une feuille d'un objet (« voice.sttProvider ») ; `value` : la nouvelle valeur, du même type. L'utilisateur voit l'ancienne et la nouvelle valeur et accepte. Lis d'abord avec settings_read. Les droits, accès fichiers, secrets et canaux externes te sont fermés.",
      parameters: { type: "object", properties: { key: { type: "string" }, value: {} }, required: ["key", "value"] },
      dangerous: true,
      source: "builtin",
      precheck(args) {
        const key = String(args.key ?? "");
        planSetting(key, args.value, store.get(split(key).root));
        return `Régler ${key} : ${show(read(key))} → ${show(args.value)}`;
      },
      async run(args) {
        const key = String(args.key ?? "");
        const { root, next } = planSetting(key, args.value, store.get(split(key).root));
        const before = show(read(key));
        store.set(root, next);
        return `${key} : ${before} → ${show(read(key))}. Pris en compte.`;
      },
    },
  ];
}
