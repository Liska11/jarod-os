// Imported (not a `/brand/...` public URL) so Vite rewrites it relative to `base` for the packaged `file://` renderer.
import robotUrl from '../assets/brand/app-robot.png'
import { cn } from '../lib/cn.ts'

/** The assistant's mark beside its replies: the app's little hooded robot (the app icon), round. Decorative. */
export function HermesMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <img
      src={robotUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size }}
      className={cn('shrink-0 select-none rounded-full object-cover shadow-[0_1px_6px_rgba(0,10,60,.35)]', className)}
    />
  )
}
