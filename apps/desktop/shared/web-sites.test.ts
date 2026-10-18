import { describe, expect, it } from 'vitest'
import { addressToUrl, chromeUserAgent, hostMatches, isSiteId, SITES, siteAllows, siteMayOpen } from './web-sites.ts'

describe('site hosts', () => {
  it('matches a domain and its subdomains, not look-alikes', () => {
    expect(hostMatches('web.whatsapp.com', 'whatsapp.com')).toBe(true)
    expect(hostMatches('whatsapp.com', 'whatsapp.com')).toBe(true)
    expect(hostMatches('evilwhatsapp.com', 'whatsapp.com')).toBe(false)
    expect(hostMatches('whatsapp.com.evil.io', 'whatsapp.com')).toBe(false)
  })

  it('keeps each site on its own pages, the browser goes anywhere on the web', () => {
    expect(siteAllows(SITES.whatsapp, 'https://web.whatsapp.com/')).toBe(true)
    expect(siteAllows(SITES.whatsapp, 'https://example.com/')).toBe(false)
    expect(siteAllows(SITES.instagram, 'https://www.instagram.com/p/x')).toBe(true)
    expect(siteAllows(SITES.browser, 'https://example.com/')).toBe(true)
    expect(siteAllows(SITES.browser, 'file:///C:/Users/x/.env')).toBe(false)
    expect(siteAllows(SITES.browser, 'javascript:alert(1)')).toBe(false)
  })

  it('lets a site show the sign-in pages it needs', () => {
    expect(siteMayOpen(SITES.tiktok, 'https://accounts.google.com/o/oauth2')).toBe(true)
    expect(siteMayOpen(SITES.tiktok, 'https://example.com/')).toBe(false)
  })

  it('knows only its own site ids', () => {
    expect(isSiteId('telegram')).toBe(true)
    expect(isSiteId('toString')).toBe(false)
    expect(isSiteId(42)).toBe(false)
  })
})

describe('addressToUrl', () => {
  it('opens addresses and searches the rest with Brave Search', () => {
    expect(addressToUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(addressToUrl('example.com')).toBe('https://example.com')
    expect(addressToUrl('localhost:3000/x')).toBe('https://localhost:3000/x')
    expect(addressToUrl('météo paris')).toBe('https://search.brave.com/search?q=m%C3%A9t%C3%A9o%20paris')
    expect(addressToUrl('1.5')).toBe('https://search.brave.com/search?q=1.5')
  })

  it('refuses schemes a page never opens', () => {
    expect(addressToUrl('file:///C:/x')).toBeNull()
    expect(addressToUrl('javascript:alert(1)')).toBeNull()
    expect(addressToUrl('   ')).toBeNull()
  })
})

describe('chromeUserAgent', () => {
  it('drops the Electron and app tokens, keeps Chrome', () => {
    const electron = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) jarod-os/0.1.0-alpha.1 Chrome/138.0.7204.35 Electron/44.0.0 Safari/537.36'

    expect(chromeUserAgent(electron)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.35 Safari/537.36')
  })
})
