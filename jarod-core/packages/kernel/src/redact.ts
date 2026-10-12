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
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[jeton masqué]"],
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
