import { $env } from '../store/backend.ts'

/** The platform a user agent string belongs to, or `unknown` (a test runner, an unusual shell). */
export function platformOfAgent(agent: string): NodeJS.Platform | 'unknown' {
  if (/Windows/i.test(agent)) {
    return 'win32'
  }

  if (/Macintosh|Mac OS X/i.test(agent)) {
    return 'darwin'
  }

  return /Linux|X11/i.test(agent) ? 'linux' : 'unknown'
}

/**
 * Host platform of the shell: what main reported, else what the window's own user agent says (it knows the OS before main answers). Never a guess of
 * macOS: until one of the two speaks the labels are the generic ones.
 */
export function hostPlatform(): NodeJS.Platform | 'unknown' {
  return ($env.get()?.platform as NodeJS.Platform | undefined) ?? platformOfAgent(typeof navigator === 'undefined' ? '' : navigator.userAgent)
}

/** Name of the host file manager, for "Reveal in …" affordances. */
export function fileManagerName(): string {
  switch (hostPlatform()) {
    case 'darwin':
      return 'Finder'
    case 'win32':
      return 'Explorer'
    default:
      return 'Files'
  }
}

/** "Mac" on macOS, "computer" elsewhere, for copy such as "Everything on this Mac". */
export function deviceNoun(): string {
  return hostPlatform() === 'darwin' ? 'Mac' : 'computer'
}

export function revealLabel(): string {
  return hostPlatform() === 'darwin' ? 'Reveal in Finder' : `Show in ${fileManagerName()}`
}

/** A shell shortcut as the keyboard spells it: `⌘⇧A` on macOS, `Ctrl+Shift+A` elsewhere (the shell takes either). */
export function shortcutLabel(key: string, { shift = false } = {}): string {
  return hostPlatform() === 'darwin' ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/** What starts a voice conversation: the session's Super+V on Linux, the configured global hotkey elsewhere. */
export function voiceKeyLabel(hotkey: string): string | undefined {
  return hostPlatform() === 'linux' ? 'Super+V' : hotkey.trim() || undefined
}
