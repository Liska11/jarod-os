// Imported (not a public URL) so Vite rewrites it relative to `base` for the packaged `file://` renderer.
import heraldMarkUrl from '../assets/brand/herald-mark.png'
import { cn } from '../lib/cn.ts'

/** The Jarod-OS mark (the glowing core), a square dark tile with rounded corners; sized by height. */
export function HeraldLogo({ height = 14, className }: { height?: number; className?: string }) {
  return <img src={heraldMarkUrl} alt="Jarod-OS" height={height} style={{ height, width: height, borderRadius: Math.round(height * 0.22) }} draggable={false} className={cn('shrink-0 select-none object-cover', className)} />
}
