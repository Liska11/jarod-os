import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// electron-builder fills the installer's CompanyName/publisher and LegalCopyright
// from `author` and `copyright`, so what Windows shows in Add/Remove Programs is
// decided by this file, not by the NSIS script. The upstream author kept the MIT
// notice; he did not sign this build.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
) as {
  productName?: string
  author?: string
  copyright?: string
  build?: {
    appId?: string
    executableName?: string
    nsis?: { shortcutName?: string }
    appx?: { publisherDisplayName?: string }
  }
}

const notice = readFileSync(fileURLToPath(new URL('../../../NOTICE', import.meta.url)), 'utf8')

describe('packaging metadata', () => {
  it('credits Jarod-OS as the publisher, never the upstream author', () => {
    expect(pkg.author).toBe('Jarod-OS')
    expect(pkg.copyright).toContain('Jarod-OS')
  })

  it('keeps the upstream MIT notice alongside our own copyright', () => {
    expect(pkg.copyright).toContain('Luke The Dev')
    expect(notice).toContain('fork of Herald OS')
    expect(notice).toContain('Copyright (c) 2026 Luke The Dev')
  })

  it('names the product the same way everywhere the user can see it', () => {
    expect(pkg.productName).toBe('Jarod-OS')
    expect(pkg.build?.executableName).toBe('Jarod-OS')
    expect(pkg.build?.nsis?.shortcutName).toBe('Jarod-OS')
    expect(pkg.build?.appx?.publisherDisplayName).toBe('Jarod-OS')
  })

  it('keeps the application id the installers were built with', () => {
    expect(pkg.build?.appId).toBe('one.jarod.os')
  })
})
