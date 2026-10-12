// Ce que le shell de Herald sait demander et que Jarod ne fait pas (encore) : un état unique, lisible, au lieu d'un « method not found » ou d'un 404 muets.
// Le shell reconnaît ce texte (`apps/desktop/src/lib/unavailable.ts`) et l'affiche comme « non disponible » plutôt que comme une panne.

/** La phrase exacte que le shell cherche : ne pas la reformuler sans changer l'autre côté. */
export const NOT_AVAILABLE = "Not available in this version";

/** Les méthodes JSON-RPC connues et non portées : plan et facturation du fournisseur, mot d'éveil, capacités du client. */
export const UNAVAILABLE_RPC: ReadonlySet<string> = new Set([
  "usage.bars",
  "billing.state",
  "wake.start",
  "wake.stop",
  "wake.pause",
  "wake.resume",
  "wake.feed",
  "client.capabilities",
]);

/** Les routes REST connues et non portées : GPT-Live, OAuth des serveurs MCP, OAuth des fournisseurs (le catalogue MCP est servi, vide, et son installation dit quoi faire à la place). */
export function isUnavailableRest(method: string, path: string): boolean {
  if (path.startsWith("/api/audio/voice-live/")) return true;
  if (/^\/api\/mcp\/servers\/[^/]+\/auth$/.test(path)) return true;
  // `GET /api/providers/oauth` (la liste vide) est servie ; démarrer, interroger ou couper un flux ne l'est pas.
  if (path.startsWith("/api/providers/oauth/")) return true;
  return false;
}
