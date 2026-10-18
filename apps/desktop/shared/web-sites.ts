/*
 * Sites that live in their own page of Jarod-OS (the Browser, Social and Messaging pages). Each one is a native web view main owns
 * (electron/ipc/web.ts openSite) with its own persistent partition, so a sign-in survives restarts and never mixes with
 * another site's. A site's view stays on its own hosts: a link elsewhere opens in the Browser page instead.
 */

export type SiteId = 'browser' | 'tiktok' | 'instagram' | 'telegram' | 'whatsapp'

export type SitePermission = 'notifications' | 'media' | 'clipboard' | 'downloads'

export interface SiteDef {
  id: SiteId
  name: string
  home: string
  /** Hosts the view may navigate to (a host or any of its subdomains); `null`: anywhere on the web (the browser). */
  hosts: readonly string[] | null
  /** What the site may do beyond showing pages; camera and microphone are asked once per launch. */
  permissions: readonly SitePermission[]
}

/** Sign-in pages a site may open in a popup (they need `window.opener`), whatever the site. */
export const SIGN_IN_HOSTS: readonly string[] = ['accounts.google.com', 'appleid.apple.com', 'facebook.com', 'login.live.com']

export const SITES: Readonly<Record<SiteId, SiteDef>> = {
  browser: { id: 'browser', name: 'Browser', home: 'https://search.brave.com/', hosts: null, permissions: ['clipboard', 'downloads', 'media', 'notifications'] },
  tiktok: { id: 'tiktok', name: 'TikTok', home: 'https://www.tiktok.com/', hosts: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com'], permissions: ['clipboard'] },
  instagram: { id: 'instagram', name: 'Instagram', home: 'https://www.instagram.com/', hosts: ['instagram.com', 'facebook.com', 'fbcdn.net', 'cdninstagram.com'], permissions: ['clipboard', 'notifications'] },
  telegram: { id: 'telegram', name: 'Telegram', home: 'https://web.telegram.org/a/', hosts: ['telegram.org', 't.me'], permissions: ['clipboard', 'notifications', 'media'] },
  whatsapp: { id: 'whatsapp', name: 'WhatsApp', home: 'https://web.whatsapp.com/', hosts: ['whatsapp.com', 'whatsapp.net'], permissions: ['clipboard', 'notifications', 'media'] }
}

/** The Social page's tabs; the messaging apps have their own section in the sidebar (Signal: the desktop app). */
export const SOCIAL_SITES: readonly SiteId[] = ['tiktok', 'instagram']

export type MessagingApp = 'telegram' | 'whatsapp' | 'signal'

export const MESSAGING_APPS: readonly MessagingApp[] = ['telegram', 'whatsapp', 'signal']

export function isSiteId(value: unknown): value is SiteId {
  return typeof value === 'string' && Object.hasOwn(SITES, value)
}

export function sitePartition(id: SiteId): string {
  return `persist:jarod-site-${id}`
}

/** `host` is `domain` or one of its subdomains. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')

  return h === domain || h.endsWith(`.${domain}`)
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.hostname : null
  } catch {
    return null
  }
}

/** The site's view may show this page itself (top-level navigation). */
export function siteAllows(site: SiteDef, url: string): boolean {
  const host = hostOf(url)

  if (!host) {
    return false
  }

  return site.hosts === null || site.hosts.some(domain => hostMatches(host, domain))
}

/** The site's view may show this page: its own pages, or a sign-in page (in the view or in a popup). */
export function siteMayOpen(site: SiteDef, url: string): boolean {
  const host = hostOf(url)

  return Boolean(host) && (siteAllows(site, url) || SIGN_IN_HOSTS.some(domain => hostMatches(host as string, domain)))
}

/**
 * Electron's user agent names Electron and the app; WhatsApp Web and others then refuse the browser as unsupported.
 * Sites see the Chrome it really is.
 */
export function chromeUserAgent(userAgent: string): string {
  return userAgent.replace(/\s(?!(?:Mozilla|AppleWebKit|Chrome|Safari)\/)[A-Za-z][\w.-]*\/\S+/g, '')
}

const SEARCH = 'https://search.brave.com/search?q='

/**
 * What the browser's address bar means: a URL (with or without its scheme) opens as is, anything else is searched.
 * Returns null for schemes a page never opens (file:, javascript:, …).
 */
export function addressToUrl(input: string): string | null {
  const text = input.trim()

  if (!text) {
    return null
  }

  if (/^https?:\/\//i.test(text)) {
    return hostOf(text) ? text : null
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s/:]+:\d+(\/|$)/.test(text)) {
    return null
  }

  // "example.com", "localhost:3000/x": no spaces, a dot or a port before any path.
  if (!/\s/.test(text) && /^[^/?#]+(\.[a-z]{2,}|:\d+)(?=$|[/?#:])/i.test(text)) {
    return `https://${text}`
  }

  return `${SEARCH}${encodeURIComponent(text)}`
}

/** Desktop apps the pages hand over to (Signal has no web version; VLC plays what Chromium cannot; Brave itself). */
export type NativeAppId = 'signal' | 'vlc' | 'brave'

export function isNativeAppId(value: unknown): value is NativeAppId {
  return value === 'signal' || value === 'vlc' || value === 'brave'
}
