/**
 * Extrait à l'identique de packages/core/src/services/diagnostics.ts:42-60 (rév. 2e180305) :
 * `redactText` sert au journal android et à l'auto-amélioration ; diagnostics.ts (plugin-observability,
 * P4) le ré-exportera.
 */
/**
 * Settings are redacted by key name, but a credential can also arrive inside free text — a provider
 * error quoting the header it rejected, a command line someone pasted. Logs go through this.
 */
const SECRET_TEXT: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-[masqué]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox[masqué]"],
  // Un jeton de bot apparaît aussi collé à son préfixe, dans une URL d'API (`…/bot123456789:AA…/sendMessage`) : le `\b`
  // devant les chiffres ne tient plus après « bot », d'où cette seconde forme.
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b|\bbot\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[jeton masqué]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[jeton masqué]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[clé masquée]"],
  [/(bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi, "$1[masqué]"],
  [/((?:api[-_]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{12,}/gi, "$1[masqué]"],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_TEXT) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Règle À CLÉ EXPLICITE (décision du 2026-10-02, après l'essai sur le profil réel : `redactText` ne masque qu'à partir
 * de 12 caractères) : toute valeur affectée (`=` ou `:`) à un nom contenant password, passwd, pwd, secret, token,
 * apikey ou api_key est masquée à TOUTE longueur. Le seuil générique de 12 caractères de `redactText` ne change pas :
 * c'est une seconde passe, à appliquer là où le texte est EXPOSÉ (journal, réponse, fenêtre). Sur-masquage assumé
 * (ex. `max_tokens: 4096`). La valeur va jusqu'au premier blanc, guillemet, virgule, point-virgule ou `&` : un crochet
 * ou une accolade DANS la valeur n'en laisse jamais une partie en clair ; une valeur déjà masquée n'est pas remasquée.
 */
export const KEYED_SECRET = /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[-_]?key)[\w-]*["']?\s*[:=]\s*["']?)(?!\[masqué\])([^\s"',;&]+)/gi;

/** `redactText` puis la règle à clé explicite : à utiliser avant d'écrire ou de renvoyer un texte qui peut citer un secret. */
export function redactKeyedText(text: string): string {
  return redactText(text).replace(KEYED_SECRET, "$1[masqué]");
}
