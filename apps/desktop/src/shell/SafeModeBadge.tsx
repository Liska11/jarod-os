import { useStore } from '@nanostores/react'
import { IconLifebuoy } from '@tabler/icons-react'
import { $env } from '../store/backend.ts'

/** Shown for as long as the shell runs in safe mode, with the way back to a normal start. */
export function SafeModeBadge() {
  const env = useStore($env)

  if (!env?.safeMode) {
    return null
  }

  return (
    <div className="pointer-events-auto absolute top-10 left-1/2 z-(--z-menubar) flex -translate-x-1/2 items-center gap-2 rounded-full border border-warn/40 bg-bg/85 px-3 py-1 text-[12px] text-fg-2 shadow-lg backdrop-blur" role="status">
      <IconLifebuoy size={14} className="text-warn" aria-hidden />
      <span>Safe mode: plugins, hooks and automations are off.</span>
      <button type="button" className="font-medium text-fg underline-offset-2 hover:underline" onClick={() => void window.heraldOS.window.relaunch(false)}>
        Restart normally
      </button>
    </div>
  )
}
