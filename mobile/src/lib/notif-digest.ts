/** One showing notification, as the phone's reader hands it over (native, `JarodNotificationsPlugin.java`). */
export interface NotifItem {
  app: string
  title: string
  text: string
  /** Epoch milliseconds. */
  when: number
}

/** "à l’instant", "il y a 5 min", "il y a 3 h", "il y a 2 j". */
export function ago(when: number, now: number): string {
  const min = Math.max(0, Math.floor((now - when) / 60_000))
  if (min < 1) return 'à l’instant'
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `il y a ${h} h`
  return `il y a ${Math.floor(h / 24)} j`
}

/**
 * The draft the chat gets when the owner taps "Mes notifications": a plain list they read, edit and
 * send themselves. Nothing leaves the phone before that. Empty when there is nothing to say.
 */
export function digestText(items: NotifItem[], now: number): string {
  if (!items.length) return ''
  const lines = items.map(i => {
    const what = [i.title, i.text].filter(Boolean).join(' : ')
    return `- ${i.app} (${ago(i.when, now)}) : ${what || 'sans texte'}`
  })
  return `Voici mes notifications en cours. Résume-moi ce qui compte :\n${lines.join('\n')}`
}

/** Ticks or unticks one app in the list of allowed packages (a new array, no duplicates, order kept). */
export function toggled(allowed: string[], pkg: string, on: boolean): string[] {
  const rest = allowed.filter(p => p !== pkg)
  return on ? [...rest, pkg] : rest
}
