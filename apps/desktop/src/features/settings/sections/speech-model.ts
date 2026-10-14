/*
 * Speech settings of the Jarod engine: the data side. Mirrors `get-jarod-options` (`sttProviders`, `voices`) and the `voice` entry of `set-jarod-settings`.
 */

import { t } from '../../../lib/i18n.ts'

export interface SttProviderOption {
  id: string
  name: string
  local: boolean
  configured: boolean
  defaultModel: string
}

/** What choosing this transcription service means for your recordings. */
export function speechSummary(provider: SttProviderOption | undefined): string {
  if (!provider) {
    return t('speech.summary.none')
  }

  const where = provider.local ? t('speech.summary.local') : t('speech.summary.hosted')

  return provider.configured ? where : `${where}${t('speech.summary.needsKey')}`
}

/** The speaking speed: 0.25 to 4, decimals allowed. */
export function rateProblem(text: string): string | null {
  const value = text.trim()

  if (!/^\d+(\.\d+)?$/.test(value)) {
    return t('speech.rateNumber')
  }

  const n = Number(value)

  return n >= 0.25 && n <= 4 ? null : t('speech.rateRange')
}
