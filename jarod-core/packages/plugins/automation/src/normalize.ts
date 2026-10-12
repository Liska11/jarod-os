/**
 * Normalise `automationTickMs` (porté de V2 bundled-plugins.ts).
 * Bornes : [1000, 3_600_000] ms, défaut 30_000.
 */
export function normalizeAutomationTickMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1_000) return 30_000;
  if (n > 3_600_000) return 3_600_000;
  return Math.floor(n);
}