/*
 * Speech settings of the Jarod engine: the data side. Mirrors `get-jarod-options` (`sttProviders`, `voices`) and the `voice` entry of `set-jarod-settings`.
 */

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
    return 'Which service turns your voice into text.'
  }

  const where = provider.local ? 'Runs on this PC: your voice stays here.' : 'Hosted: each recording is sent to it.'

  return provider.configured ? where : `${where} It needs an API key (Settings → Providers & keys).`
}

/** The speaking speed: 0.25 to 4, decimals allowed. */
export function rateProblem(text: string): string | null {
  const t = text.trim()

  if (!/^\d+(\.\d+)?$/.test(t)) {
    return 'A number like 1 or 1.25.'
  }

  const n = Number(t)

  return n >= 0.25 && n <= 4 ? null : 'From 0.25 to 4.'
}
