/** Seconds left before `expiresAt` (never below 0), rounded up so "0:00" only shows when it is over. */
export const secondsLeft = (expiresAt: number, now: number = Date.now()): number => Math.max(0, Math.ceil((expiresAt - now) / 1000))

/** "4:07", "0:09", "1:02:05" for a long wait. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The share of the wait still ahead, 0..1, for a progress ring; 1 when the length is unknown. */
export function fractionLeft(expiresAt: number, startedAt: number, now: number = Date.now()): number {
  const total = expiresAt - startedAt
  if (total <= 0) return 1
  return Math.min(1, Math.max(0, (expiresAt - now) / total))
}
