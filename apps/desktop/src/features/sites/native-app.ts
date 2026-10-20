import { useCallback, useEffect, useState } from 'react'
import type { NativeAppId } from '../../../shared/web-sites.ts'
import { t } from '../../lib/i18n.ts'
import { notify } from '../../store/notifications.ts'

const clean = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Signal, VLC or Brave on this computer: installed or not, start it, install it with winget. */
export function useNativeApp(app: NativeAppId, name: string) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(() => {
    void window.jarodOS.nativeApps
      .installed(app)
      .then(setInstalled)
      .catch(() => setInstalled(false))
  }, [app])

  useEffect(check, [check])

  const launch = useCallback(
    (target?: string) => {
      setError(null)
      window.jarodOS.nativeApps.launch(app, target).catch((reason: unknown) => {
        setError(clean(reason))
        check()
      })
    },
    [app, check]
  )

  const install = useCallback(async () => {
    setInstalling(true)
    setError(null)

    try {
      const result = await window.jarodOS.nativeApps.install(app)

      if (result.ok) {
        notify({ title: t('sites.native.installed', { name }), level: 'success', surface: 'hermes' })
      } else {
        setError(result.error ?? t('sites.native.installFailed', { name }))
      }
    } catch (reason) {
      setError(clean(reason))
    } finally {
      setInstalling(false)
      check()
    }
  }, [app, name, check])

  return { installed, installing, error, launch, install, check }
}
