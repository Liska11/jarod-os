import { IconChevronRight, IconShieldCheck } from '@tabler/icons-react'
import { GlassCard } from '../../components/ui/glass.tsx'
import { useT } from '../../lib/i18n.ts'
import { rest } from '../../lib/rest.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { showPage } from '../../store/windows.ts'
import { IconTile, Shimmer } from './shared.tsx'

interface MemoryStatus {
  builtin_files?: { memory?: number; user?: number; [key: string]: unknown }
  [key: string]: unknown
}

/** One-line memory health: the backend reports how many built-in memory entries it holds. */
export function MemoryCard() {
  const memory = useBackendData(() => rest.get<MemoryStatus>('/api/memory'))
  const count = memory.data?.builtin_files?.memory
  const known = typeof count === 'number' && count > 0
  const { t, tn } = useT()
  const label = memory.loading && !memory.data ? null : known ? t('memory.upToDate') : t('memory.paused')
  const detail = known ? tn('memory.count', count) : memory.error ? t('memory.unreachable') : t('memory.empty')

  return (
    <GlassCard as="button" interactive onClick={() => showPage('memory')} className="flex w-full items-center gap-3 p-3">
      <IconTile size={34}>
        <IconShieldCheck />
      </IconTile>
      <div className="min-w-0 flex-1">
        {label ? (
          <>
            <div className="truncate text-[13px] font-medium text-fg">{label}</div>
            <div className="truncate text-[11.5px] text-fg-3">{detail}</div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Shimmer className="h-3 w-28 rounded" />
            <Shimmer className="h-2.5 w-20 rounded" />
          </div>
        )}
      </div>
      <IconChevronRight size={15} className="shrink-0 text-fg-4" aria-hidden="true" />
    </GlassCard>
  )
}
