import { useStore } from '@nanostores/react'
import { IconBrandSignal, IconDownload, IconExternalLink } from '@tabler/icons-react'
import { EmptyGlass, GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { useT } from '../../lib/i18n.ts'
import { $page } from '../../store/windows.ts'
import { $messagingApp } from './messaging.ts'
import { useNativeApp } from './native-app.ts'
import { SiteTab } from './SocialPage.tsx'

/** The Messaging page: Telegram and WhatsApp on the web, Signal through its desktop app (it has no web version). */
export function MessagingPage() {
  const app = useStore($messagingApp)
  const pageActive = useStore($page) === 'messaging'

  return (
    <div className="flex h-full flex-col">
      <SiteTab site="telegram" active={pageActive && app === 'telegram'} />
      <SiteTab site="whatsapp" active={pageActive && app === 'whatsapp'} />
      {app === 'signal' && <SignalPanel />}
    </div>
  )
}

function SignalPanel() {
  const { t } = useT()
  const signal = useNativeApp('signal', 'Signal')

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyGlass
        className="w-full max-w-lg"
        icon={<IconBrandSignal />}
        title="Signal"
        description={signal.error ?? (signal.installed === false ? t('sites.signal.missing') : t('sites.signal.hint'))}
        action={
          signal.installed === null ? (
            <Spinner />
          ) : signal.installed ? (
            <GlassButton variant="primary" onClick={() => signal.launch()}>
              <IconExternalLink />
              {t('sites.signal.open')}
            </GlassButton>
          ) : (
            <GlassButton variant="primary" disabled={signal.installing} onClick={() => void signal.install()}>
              {signal.installing ? <Spinner /> : <IconDownload />}
              {signal.installing ? t('sites.native.installing', { name: 'Signal' }) : t('sites.native.install', { name: 'Signal' })}
            </GlassButton>
          )
        }
      />
    </div>
  )
}
