/** The integrated apps of the right-hand pane and the words people use for them (kept free of UI imports so it can be tested). */
export const PANE_IDS = ['browser', 'tiktok', 'instagram', 'player', 'moviebox', 'telegram', 'whatsapp', 'signal', 'vlc'] as const

const NAMES: Readonly<Record<string, string>> = {
  navigateur: 'browser',
  browser: 'browser',
  web: 'browser',
  brave: 'browser',
  internet: 'browser',
  lecteur: 'player',
  player: 'player',
  video: 'player',
  vidéo: 'player'
}

/** "TikTok", "tiktok", "Navigateur", "Brave" → the pane app's id, or null. */
export function paneAppId(name: string): string | null {
  const key = name.trim().toLowerCase()
  const id = NAMES[key] ?? key

  return (PANE_IDS as readonly string[]).includes(id) ? id : null
}
