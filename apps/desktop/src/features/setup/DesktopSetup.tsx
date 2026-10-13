import { IconAlertTriangle, IconCheck, IconCopy, IconCpu, IconInfoCircle, IconRefresh, IconSparkles, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { AuditReport, Check, CheckStatus } from '../../../shared/system-audit.ts'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'
import { Footer, Heading } from './parts.tsx'
import { TelegramStep } from './TelegramStep.tsx'

type Step = 'welcome' | 'audit' | 'telegram' | 'done'
const STEPS: Step[] = ['welcome', 'audit', 'telegram', 'done']

/**
 * First-run setup of Jarod-OS on Windows (HANDOFF.md, section 7): welcome, the system audit (hardware, prerequisites
 * with the command that fixes each, blocked while a critical one is missing), the Telegram bot, then done. The API keys
 * import goes between the Telegram step and the end.
 */
export function DesktopSetup({ onFinished }: { onFinished: () => void }) {
  useT()
  const [step, setStep] = useState<Step>('welcome')
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)] ?? 'done')

  const finish = async () => {
    await window.heraldOS.setup.finish({})
    onFinished()
  }

  return (
    <div className="absolute inset-0 z-(--z-boot) flex items-center justify-center bg-bg/85 backdrop-blur-md animate-fade-in" role="dialog" aria-label={t('setup.title')}>
      <div className="float flex max-h-[92vh] w-[min(640px,92vw)] flex-col gap-5 rounded-2xl p-7">
        <div className="flex items-center gap-3">
          <HeraldLogo height={22} />
          <span className="flex-1" />
          <div className="flex gap-1.5" aria-hidden>
            {STEPS.map(item => (
              <span key={item} className={cn('h-1.5 w-6 rounded-full bg-white/15', STEPS.indexOf(item) <= STEPS.indexOf(step) && 'bg-accent-strong')} />
            ))}
          </div>
        </div>

        {step === 'welcome' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconSparkles size={18} />} title={t('setup.welcome.title')} text={t('setup.welcome.text')} />
            <Footer onNext={next} label={t('setup.next')} />
          </div>
        )}
        {step === 'audit' && <AuditStep onDone={next} />}
        {step === 'telegram' && <TelegramStep onDone={next} />}
        {step === 'done' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconCheck size={18} />} title={t('setup.done.title')} text={t('setup.done.text')} />
            <Footer onNext={() => void finish()} label={t('setup.done.start')} />
          </div>
        )}
      </div>
    </div>
  )
}

const STATUS_ICON: Record<CheckStatus, React.ReactNode> = {
  ok: <IconCheck size={15} className="text-ok" />,
  missing: <IconX size={15} className="text-danger" />,
  outdated: <IconAlertTriangle size={15} className="text-warn" />,
  info: <IconInfoCircle size={15} className="text-fg-3" />
}

/** A check's label in the interface language, from its id (`gpu:<name>` and `npu:<name>` carry the device name). */
export function checkLabel(check: Check): string {
  const [kind] = check.id.split(':')
  if (kind === 'gpu') return t(check.label === 'Integrated GPU' ? 'setup.check.igpu' : 'setup.check.gpu')
  const key = `setup.check.${kind}` as MessageKey
  const text = t(key)
  return text === key ? check.label : text
}

function AuditStep({ onDone }: { onDone: () => void }) {
  const [report, setReport] = useState<AuditReport | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async (fresh: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setReport(await (fresh ? window.heraldOS.systemAudit.run() : window.heraldOS.systemAudit.get()))
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the saved (or running) audit is read once, when the step opens.
  useEffect(() => {
    void load(false)
  }, [])

  const hardware = report?.checks.filter(c => c.id === 'ram' || c.id === 'disk' || (c.status === 'info' && !c.fix)) ?? []
  const prerequisites = report?.checks.filter(c => !hardware.includes(c)) ?? []
  const toFix = prerequisites.filter(c => c.status === 'missing' || c.status === 'outdated').length

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Heading
        icon={<IconCpu size={18} />}
        title={t('setup.audit.title')}
        text={busy && !report ? t('setup.audit.running') : report?.blocked ? t('setup.audit.blocked') : toFix > 0 ? t('setup.audit.toFix', { count: toFix }) : t('setup.audit.allGood')}
      />
      {error && <p className="text-[12.5px] text-danger">{t('setup.audit.failed', { error })}</p>}
      {report && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <Section title={t('setup.audit.hardware')} checks={hardware} />
          <Section title={t('setup.audit.prerequisites')} checks={prerequisites} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <GlassButton variant="ghost" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Spinner /> : <IconRefresh size={15} />} {t('setup.audit.again')}
        </GlassButton>
        <Footer onNext={onDone} label={t('setup.next')} disabled={busy || !report || report.blocked} />
      </div>
    </div>
  )
}

function Section({ title, checks }: { title: string; checks: Check[] }) {
  if (checks.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{title}</h3>
      <ul className="flex flex-col gap-1">
        {checks.map(check => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
    </section>
  )
}

function CheckRow({ check }: { check: Check }) {
  const [copied, setCopied] = useState(false)
  const showFix = check.fix && check.status !== 'ok'

  return (
    <li className={cn('glass-input flex flex-col gap-1 rounded-lg px-3 py-2', check.critical && check.status !== 'ok' && 'border-danger/60')}>
      <div className="flex items-center gap-2 text-[13px]">
        <span role="img" aria-label={t(`setup.status.${check.status}` as MessageKey)}>
          {STATUS_ICON[check.status]}
        </span>
        <span className="font-medium text-fg">{checkLabel(check)}</span>
        {check.critical && check.status !== 'ok' && <span className="rounded bg-danger/20 px-1.5 text-[10.5px] text-danger">{t('setup.status.blocking')}</span>}
        <span className="min-w-0 flex-1 truncate text-right text-fg-3" title={check.detail}>
          {check.detail}
        </span>
      </div>
      {showFix && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-black/25 px-2 py-1 font-mono text-[11.5px] text-fg-2" title={check.fix}>
            {check.fix}
          </code>
          <button
            type="button"
            className="text-fg-3 hover:text-fg"
            aria-label={t('setup.audit.copy')}
            title={t('setup.audit.copy')}
            onClick={() => {
              void navigator.clipboard.writeText(check.fix ?? '').then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
        </div>
      )}
    </li>
  )
}
