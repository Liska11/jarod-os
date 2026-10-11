// Imported (not a public URL) so Vite rewrites it relative to `base` for the packaged `file://` renderer.
import heraldMarkUrl from '../assets/brand/herald-mark.png'
import { cn } from '../lib/cn.ts'

/** The Herald winged H, shared with the Herald mobile app. White on transparency; sized by height. */
export function HeraldLogo({ height = 14, className }: { height?: number; className?: string }) {
  return <img src={heraldMarkUrl} alt="Jarod-OS" height={height} style={{ height, width: 'auto' }} draggable={false} className={cn('shrink-0 select-none', className)} />
}
