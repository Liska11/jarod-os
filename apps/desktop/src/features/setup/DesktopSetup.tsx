import { IconAlertTriangle, IconCheck, IconCopy, IconCpu, IconDownload, IconInfoCircle, IconRefresh, IconSparkles, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { type AuditReport, type Check, type CheckStatus, INSTALLABLE_PREREQUISITES, type SystemFacts } from '../../../shared/system-audit.ts'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { $locale, type MessageKey, t, useT } from '../../lib/i18n.ts'
import { Footer, Heading } from './parts.tsx'
import { KeysStep } from './KeysStep.tsx'
import { TelegramStep } from './TelegramStep.tsx'

type Step = 'welcome' | 'audit' | 'telegram' | 'keys' | 'done'
const STEPS: Step[] = ['welcome', 'audit', 'telegram', 'keys', 'done']

/**
 * First-run setup of Jarod-OS on Windows (HANDOFF.md, section 7): welcome, the system audit (hardware, prerequisites
 * with the command that fixes each, blocked while a critical one is missing), the Telegram bot, the API keys import,
 * then done.
 */
/** `onDemand`: opened again after first run (command `setup.open`); it can be closed, and finishing marks nothing. */
export function DesktopSetup({ onFinished, onDemand = false }: { onFinished: () => void; onDemand?: boolean }) {
  useT()
  const [step, setStep] = useState<Step>('welcome')
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)] ?? 'done')

  const finish = async () => {
    if (!onDemand) await window.heraldOS.setup.finish({})
    onFinished()
  }

  return (
    <div className="absolute inset-0 z-(--z-boot) flex items-center justify-center bg-bg/85 backdrop-blur-md animate-fade-in" role="dialog" aria-label={t('setup.title')}>
      <div className="float flex max-h-[92vh] w-[min(640px,92vw)] flex-col gap-5 rounded-2xl p-7">
        <div className="flex items-center gap-3">
          <HeraldLogo height={56} />
          <span className="flex-1" />
          <div className="flex gap-1.5" aria-hidden>
            {STEPS.map(item => (
              <span key={item} className={cn('h-1.5 w-6 rounded-full bg-white/15', STEPS.indexOf(item) <= STEPS.indexOf(step) && 'bg-accent-strong')} />
            ))}
          </div>
          {onDemand && (
            <button type="button" onClick={onFinished} className="text-fg-3 hover:text-fg" aria-label={t('setup.close')} title={t('setup.close')}>
              <IconX size={16} />
            </button>
          )}
        </div>

        {step === 'welcome' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconSparkles size={18} />} title={t('setup.welcome.title')} text={t('setup.welcome.text')} />
            <Footer onNext={next} label={t('setup.next')} />
          </div>
        )}
        {step === 'audit' && <AuditStep onDone={next} />}
        {step === 'telegram' && <TelegramStep onDone={next} />}
        {step === 'keys' && <KeysStep onDone={next} />}
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

const gb = (mb: number) => new Intl.NumberFormat($locale.get(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(mb / 1024)
const yesNo = (value: boolean | null) => t(value === null ? 'setup.detail.unknown' : value ? 'setup.detail.yes' : 'setup.detail.no')
const TOOLS = new Set(['node', 'npm', 'pnpm', 'git', 'python', 'ollama', 'docker'])
const MINIMUM: Record<string, string> = { node: '22.12', python: '3.10' }

/** A check's detail in the interface language, rebuilt from the audit's facts; main's English text when there is no rule. */
export function checkDetail(check: Check, facts: SystemFacts): string {
  const [kind, device = ''] = check.id.split(':')
  switch (kind) {
    case 'cpu':
      return t('setup.detail.cpu', { model: facts.cpu.model, cores: facts.cpu.cores || '?', threads: facts.cpu.threads, avx2: yesNo(facts.cpu.avx2), avx512: yesNo(facts.cpu.avx512) })
    case 'ram':
      return t(check.status === 'ok' ? 'setup.detail.ram' : 'setup.detail.ramLow', { gb: gb(facts.ramMB) })
    case 'disk':
      return facts.freeDiskMB === null ? check.detail : t(check.status === 'ok' ? 'setup.detail.disk' : 'setup.detail.diskLow', { gb: gb(facts.freeDiskMB) })
    case 'gpu': {
      const gpu = facts.gpus.find(g => g.name === device)
      if (!gpu) return device ? check.detail : t('setup.detail.noGpu')
      if (gpu.integrated) return gpu.vramMB === null ? t('setup.detail.igpu', { name: gpu.name }) : t('setup.detail.igpuUpTo', { name: gpu.name, gb: gb(gpu.vramMB) })
      return gpu.vramMB === null ? gpu.name : t('setup.detail.vram', { name: gpu.name, gb: gb(gpu.vramMB) })
    }
    case 'npu':
      return check.status === 'ok' ? device : t('setup.detail.npuDown', { name: device })
    case 'vulkan':
    case 'wsl':
      return check.status === 'ok' ? t('setup.detail.present') : t(kind === 'wsl' ? 'setup.detail.wslMissing' : 'setup.detail.vulkanMissing')
    case 'cuda':
      return check.status === 'ok' ? check.detail : t('setup.detail.cudaMissing')
    case 'openvino':
      return t('setup.detail.openvino')
    case 'rocm':
      return t(facts.platform === 'win32' ? 'setup.detail.rocmWindows' : 'setup.detail.rocmLinux')
    default:
      if (TOOLS.has(kind)) {
        const version = facts.software[kind]
        if (!version) return t('setup.detail.notInstalled')
        return check.status === 'outdated' ? t('setup.detail.outdated', { version, min: MINIMUM[kind] ?? '' }) : version
      }
      return check.detail
  }
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

  // Installing what the audit found missing (Windows): one at a time, then audit again so the screen shows the new state.
  const [installing, setInstalling] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, InstallOutcome>>({})
  const installable = report ? prerequisites.filter(check => canInstall(check, report.facts)) : []

  const install = async (check: Check): Promise<boolean> => {
    setInstalling(check.id)
    try {
      const outcome = await window.heraldOS.systemAudit.install(check.id, check.status === 'outdated')
      setOutcomes(current => ({ ...current, [check.id]: outcome }))
      return outcome.ok
    } catch (failure) {
      setOutcomes(current => ({ ...current, [check.id]: { ok: false, error: (failure as Error).message } }))
      return false
    } finally {
      setInstalling(null)
    }
  }

  const installAndRecheck = async (checks: Check[]) => {
    let any = false
    for (const check of checks) any = (await install(check)) || any
    if (any) await load(true)
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Heading
        icon={<IconCpu size={18} />}
        title={t('setup.audit.title')}
        text={busy && !report ? t('setup.audit.running') : report?.blocked ? t('setup.audit.blocked') : toFix > 0 ? t('setup.audit.toFix', { count: toFix }) : t('setup.audit.allGood')}
      />
      {error && <p className="text-[12.5px] text-danger">{t('setup.audit.failed', { error })}</p>}
      {installable.length > 0 && <p className="text-[12px] text-fg-3">{t('setup.audit.installNote')}</p>}
      {report && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <Section title={t('setup.audit.hardware')} checks={hardware} facts={report.facts} />
          <Section
            title={t('setup.audit.prerequisites')}
            checks={prerequisites}
            facts={report.facts}
            install={{ installing, outcomes, run: check => void installAndRecheck([check]) }}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GlassButton variant="ghost" onClick={() => void load(true)} disabled={busy || installing !== null}>
            {busy ? <Spinner /> : <IconRefresh size={15} />} {t('setup.audit.again')}
          </GlassButton>
          {installable.length > 1 && (
            <GlassButton onClick={() => void installAndRecheck(installable)} disabled={busy || installing !== null}>
              {installing ? <Spinner /> : <IconDownload size={15} />} {t('setup.audit.installAll', { count: installable.length })}
            </GlassButton>
          )}
        </div>
        <Footer onNext={onDone} label={t('setup.next')} disabled={busy || installing !== null || !report || report.blocked} />
      </div>
    </div>
  )
}

interface InstallOutcome {
  ok: boolean
  restart?: boolean
  already?: boolean
  error?: string
}

interface InstallControls {
  installing: string | null
  outcomes: Record<string, InstallOutcome>
  run: (check: Check) => void
}

/** Missing or outdated, on Windows, and one of the tools the app knows how to install. */
export function canInstall(check: Check, facts: SystemFacts): boolean {
  return facts.platform === 'win32' && (check.status === 'missing' || check.status === 'outdated') && (INSTALLABLE_PREREQUISITES as readonly string[]).includes(check.id)
}

function Section({ title, checks, facts, install }: { title: string; checks: Check[]; facts: SystemFacts; install?: InstallControls }) {
  if (checks.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{title}</h3>
      <ul className="flex flex-col gap-1">
        {checks.map(check => (
          <CheckRow key={check.id} check={check} detail={checkDetail(check, facts)} install={install && canInstall(check, facts) ? install : undefined} />
        ))}
      </ul>
    </section>
  )
}

function InstallLine({ check, install }: { check: Check; install: InstallControls }) {
  const outcome = install.outcomes[check.id]
  const running = install.installing === check.id

  return (
    <div className="flex items-center gap-2 text-[12px]">
      <GlassButton size="sm" onClick={() => install.run(check)} disabled={install.installing !== null}>
        {running ? <Spinner /> : <IconDownload size={14} />}
        {running ? t('setup.audit.installing') : check.status === 'outdated' ? t('setup.audit.update') : t('setup.audit.install')}
      </GlassButton>
      {outcome && !running && (
        <span className={cn('min-w-0 flex-1 truncate', outcome.ok ? 'text-ok' : 'text-danger')} title={outcome.error}>
          {outcome.ok ? (outcome.restart ? t('setup.audit.restartNeeded') : outcome.already ? t('setup.audit.alreadyInstalled') : t('setup.audit.installed')) : t('setup.audit.installFailed', { error: outcome.error ?? '' })}
        </span>
      )}
    </div>
  )
}

function CheckRow({ check, detail, install }: { check: Check; detail: string; install?: InstallControls }) {
  const [copied, setCopied] = useState(false)
  const showFix = check.fix && check.status !== 'ok'

  return (
    <li className={cn('glass-input flex flex-col gap-1 rounded-lg px-3 py-2', check.critical && check.status !== 'ok' && 'border-danger/60')}>
      <div className="flex items-center gap-2 text-[13px]">
        <span role="img" aria-label={t(`setup.status.${check.status}` as MessageKey)}>
          {STATUS_ICON[check.status]}
        </span>
        <span className="shrink-0 font-medium text-fg">{checkLabel(check)}</span>
        {check.critical && check.status !== 'ok' && <span className="rounded bg-danger/20 px-1.5 text-[10.5px] text-danger">{t('setup.status.blocking')}</span>}
        <span className="min-w-0 flex-1 truncate text-right text-fg-3" title={detail}>
          {detail}
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
      {install && <InstallLine check={check} install={install} />}
    </li>
  )
}
