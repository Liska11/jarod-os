import { IconArrowRight } from '@tabler/icons-react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'

/* The first-run setup's shared pieces: a step's heading and its "next" button. */

export function Heading({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-fg">
        <span className="icon-tile size-8 rounded-lg">{icon}</span>
        <h2 className="text-[19px] font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="text-[13px] leading-relaxed text-fg-3">{text}</p>
    </div>
  )
}

export function Footer({ onNext, label, busy, disabled }: { onNext: () => void; label: string; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="flex justify-end">
      <GlassButton variant="primary" onClick={onNext} disabled={busy || disabled}>
        {busy ? <Spinner /> : null} {label} <IconArrowRight size={15} />
      </GlassButton>
    </div>
  )
}
