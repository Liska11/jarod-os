// Comparaison d'un secret présenté par un client avec celui attendu.
//
// Un `!==` sur un jeton s'arrête au premier octet différent : le temps de réponse dit alors combien
// d'octets sont devinés, et un jeton se retrouve octet par octet (attaque temporelle classique sur un
// service local). Ici les deux valeurs sont d'abord condensées en SHA-256 — longueur fixe, donc
// `timingSafeEqual` ne peut pas non plus se plaindre d'une différence de taille et ne court-circuite
// jamais. Le condensat ne sert qu'à la comparaison : il n'est jamais écrit ni journalisé.
import { createHash, timingSafeEqual } from "node:crypto";

/** Vrai seulement si `supplied` est exactement `expected` (temps de comparaison indépendant de la valeur). */
export function sameSecret(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || supplied.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
