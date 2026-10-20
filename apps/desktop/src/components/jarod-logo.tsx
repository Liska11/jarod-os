// Imported (not a public URL) so Vite rewrites it relative to `base` for the packaged `file://` renderer.
import markUrl from '../assets/brand/jarod-core-mark.webp'
import { cn } from '../lib/cn.ts'

/**
 * The Jarod-OS mark: the glowing core, its edges fading to transparency so it blends into any background, with a soft blue halo
 * so it stands out. Square; sized by height.
 */
export function JarodLogo({ height = 14, className }: { height?: number; className?: string }) {
  const glow = Math.max(4, Math.round(height * 0.18))

  return (
    <img
      src={markUrl}
      alt="Jarod-OS"
      height={height}
      width={height}
      style={{ height, width: height, filter: `drop-shadow(0 0 ${glow}px rgba(64, 128, 255, 0.45))` }}
      draggable={false}
      className={cn('shrink-0 select-none', className)}
    />
  )
}
