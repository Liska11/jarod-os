import { useStore } from '@nanostores/react'
import { IconArrowRight, IconCheck, IconGift, IconLock, IconUser, IconWifi } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { useT } from '../../lib/i18n.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../store/hermes-auth.ts'
import { $setupRequested } from '../../store/setup.ts'
import { StatusPanel } from '../status/StatusPanel.tsx'
import { DesktopSetup } from './DesktopSetup.tsx'
import { Footer, Heading } from './parts.tsx'

type Step = 'welcome' | 'account' | 'wifi' | 'hermes' | 'done'

/**
 * First-boot setup on the Jarod-OS image: who the computer is for, their name and password,
 * Wi-Fi, and Hermes's sign-in. Setting it up for someone else skips the account and leaves setup
 * waiting for them at the next start.
 */
export function FirstRunSetup() {
  const { t } = useT()
  const [due, setDue] = useState(false)
  const [mode, setMode] = useState<'image' | 'desktop'>('image')
  const [step, setStep] = useState<Step>('welcome')
  const [forSomeoneElse, setForSomeoneElse] = useState(false)
  const auth = useStore($hermesAuth)
  const requested = useStore($setupRequested)

  useEffect(() => {
    void window.heraldOS.setup
      ?.state()
      .then(state => {
        setMode(state.mode)
        setDue(state.needed)
      })
      .catch(() => undefined)
  }, [])

  // Asked for on demand (command `setup.open`): the wizard again, on any platform.
  if (requested) {
    return <DesktopSetup onDemand onFinished={() => $setupRequested.set(false)} />
  }

  if (!due) {
    return null
  }

  if (mode === 'desktop') {
    return <DesktopSetup onFinished={() => setDue(false)} />
  }

  // Signing in happens on Hermes's own card; setup steps aside until it is done.
  if (step === 'hermes' && auth.needsLogin) {
    return null
  }

  const finish = async () => {
    await window.heraldOS.setup.finish({ later: forSomeoneElse })
    setDue(false)
  }

  const steps: Step[] = forSomeoneElse ? ['welcome', 'wifi', 'done'] : ['welcome', 'account', 'wifi', 'hermes', 'done']
  const next = () => setStep(steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)] ?? 'done')

  return (
    <div className="absolute inset-0 z-(--z-boot) flex items-center justify-center bg-bg/85 backdrop-blur-md animate-fade-in" role="dialog" aria-label={t('setup.title')}>
      <div className="float flex w-[min(560px,92vw)] flex-col gap-5 rounded-2xl p-7">
        <div className="flex items-center gap-3">
          <HeraldLogo height={22} />
          <span className="flex-1" />
          <div className="flex gap-1.5" aria-hidden>
            {steps.map(item => (
              <span key={item} className={cn('h-1.5 w-6 rounded-full bg-white/15', steps.indexOf(item) <= steps.indexOf(step) && 'bg-accent-strong')} />
            ))}
          </div>
        </div>

        {step === 'welcome' && (
          <Welcome
            onChoose={someoneElse => {
              setForSomeoneElse(someoneElse)
              setStep(someoneElse ? 'wifi' : 'account')
            }}
          />
        )}
        {step === 'account' && <Account onDone={next} />}
        {step === 'wifi' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconWifi size={18} />} title={t('firstrun.wifi.title')} text={t('firstrun.wifi.text')} />
            <div className="max-h-[320px] overflow-y-auto rounded-xl">
              <StatusPanel panel="wifi" />
            </div>
            <Footer onNext={next} label={t('setup.next')} />
          </div>
        )}
        {step === 'hermes' && <HermesStep onDone={next} />}
        {step === 'done' && (
          <div className="flex flex-col gap-4">
            <Heading
              icon={forSomeoneElse ? <IconGift size={18} /> : <IconCheck size={18} />}
              title={forSomeoneElse ? t('firstrun.done.handOver') : t('setup.done.title')}
              text={forSomeoneElse ? t('firstrun.done.handOverText') : t('firstrun.done.text')}
            />
            <Footer onNext={() => void finish()} label={forSomeoneElse ? t('firstrun.done.handOverButton') : t('setup.done.start')} />
          </div>
        )}
      </div>
    </div>
  )
}

function Welcome({ onChoose }: { onChoose: (someoneElse: boolean) => void }) {
  const { t } = useT()

  return (
    <div className="flex flex-col gap-4">
      <Heading icon={<IconUser size={18} />} title={t('setup.welcome.title')} text={t('firstrun.welcome.text')} />
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => onChoose(false)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">{t('firstrun.forMe')}</span>
          <span className="text-[12px] text-fg-3">{t('firstrun.forMe.hint')}</span>
        </button>
        <button type="button" onClick={() => onChoose(true)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">{t('firstrun.forSomeone')}</span>
          <span className="text-[12px] text-fg-3">{t('firstrun.forSomeone.hint')}</span>
        </button>
      </div>
    </div>
  )
}

function Account({ onDone }: { onDone: () => void }) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && password !== again

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      await window.heraldOS.setup.name(name)
      const result = await window.heraldOS.setup.password(password)

      if (result.ok) {
        onDone()
      } else {
        setError(result.error ?? t('firstrun.passwordNotSet'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <Heading icon={<IconLock size={18} />} title={t('firstrun.account.title')} text={t('firstrun.account.text')} />
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {t('firstrun.name')}
        <input value={name} onChange={event => setName(event.target.value)} autoFocus autoComplete="name" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {t('firstrun.password')}
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {t('firstrun.passwordAgain')}
        <input type="password" value={again} onChange={event => setAgain(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      {(error || mismatch) && <p className="text-[12.5px] text-danger">{mismatch ? t('firstrun.mismatch') : error}</p>}
      <Footer onNext={() => void save()} label={t('setup.next')} busy={busy} disabled={!name.trim() || password.length < 8 || password !== again} />
    </form>
  )
}

function HermesStep({ onDone }: { onDone: () => void }) {
  const { t } = useT()
  const auth = useStore($hermesAuth)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void refreshHermesAuth().finally(() => setChecking(false))
  }, [])

  const signedIn = auth.checked && !auth.needsLogin && Boolean(auth.activeProvider)

  return (
    <div className="flex flex-col gap-4">
      <Heading
        icon={<IconUser size={18} />}
        title={t('firstrun.hermes.title')}
        text={signedIn ? (auth.activeProvider ? t('firstrun.hermes.signedInNamed', { provider: auth.activeProvider }) : t('firstrun.hermes.signedIn')) : t('firstrun.hermes.text')}
      />
      <div className="flex justify-end gap-2">
        {!signedIn && (
          <GlassButton variant="ghost" onClick={onDone}>
            {t('setup.later')}
          </GlassButton>
        )}
        {signedIn ? (
          <Footer onNext={onDone} label={t('setup.next')} />
        ) : (
          <GlassButton variant="primary" onClick={() => requestHermesLogin('setup')} disabled={checking}>
            {checking ? <Spinner /> : null} {t('firstrun.hermes.signIn')} <IconArrowRight size={15} />
          </GlassButton>
        )}
      </div>
    </div>
  )
}
