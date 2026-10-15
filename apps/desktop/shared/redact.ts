/**
 * Même liste que `jarod-core/packages/kernel/src/redact.ts` (source unique du noyau) : le shell ne peut pas
 * l'importer (`apps/desktop` n'a aucune dépendance `@jarod/*`), et une erreur d'agent, un HTTP refusé ou une
 * ligne de journal ne doit pas afficher un secret — ni dans la fenêtre, ni dans `herald-os.log`.
 * Toute modification du noyau doit être répercutée ici (les tests des deux côtés portent les mêmes vecteurs).
 */
const SECRET_TEXT: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[masqué]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox[masqué]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[jeton masqué]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[jeton masqué]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[clé masquée]'],
  [/(bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi, '$1[masqué]'],
  [/((?:api[-_]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{12,}/gi, '$1[masqué]']
]

/**
 * Règle À CLÉ EXPLICITE, copiée de `jarod-core/packages/cli/src/mcp-server.ts` (décision du 2026-10-02) : le
 * seuil générique de 12 caractères ci-dessus laisse passer un jeton court (`?token=abc123`), alors qu'un nom
 * de réglage qui dit password/passwd/pwd/secret/token/api_key désigne une valeur à masquer à TOUTE longueur.
 * Le seuil du noyau ne change pas ; sur-masquage assumé (`max_tokens: 4096`), et la règle est idempotente.
 */
const KEYED_SECRET =
  /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[-_]?key)[\w-]*["']?\s*[:=]\s*["']?)(?!\[masqué\])([^\s"',;&]+)/gi

export function redactText(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_TEXT) {
    out = out.replace(pattern, replacement)
  }

  return out.replace(KEYED_SECRET, '$1[masqué]')
}

/** Une ligne de journal ou un message affiché : au-delà, ce n'est plus un message mais une pile déguisée. */
export const MAX_ERROR_TEXT = 400

/**
 * Masque, ramène sur une ligne, et borne. Utilisé par le journal, les erreurs du gestionnaire de moteur et les
 * messages montrés à l'écran : une erreur de provider peut citer l'en-tête refusé ou une URL signée.
 */
export function redactLine(text: string, max = MAX_ERROR_TEXT): string {
  const one = redactText(text)
    .replace(/\s+/g, ' ')
    .trim()

  return one.length > max ? `${one.slice(0, max)}…` : one
}
