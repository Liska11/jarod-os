import { describe, expect, it } from 'vitest'
import { checkRequest, hostnameOf, isLoopbackName, isLoopbackOrigin } from './guard.ts'

describe('hostnameOf', () => {
  it('drops the port, keeps IPv6 brackets', () => {
    expect(hostnameOf('LocalHost:42000')).toBe('localhost')
    expect(hostnameOf('[::1]:42000')).toBe('[::1]')
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('isLoopbackName', () => {
  it('accepts names that can only mean this machine', () => {
    for (const name of ['localhost', '127.0.0.1', '127.8.9.10', '[::1]', 'comfyui.localhost', 'localhost.']) {
      expect(isLoopbackName(name), name).toBe(true)
    }
  })

  it('refuses everything else, including look-alikes', () => {
    for (const name of ['192.168.1.42', '0.0.0.0', 'localhost.evil.example', 'evil-localhost', 'pinokio.co', '', '127.0.0.1.nip.io']) {
      expect(isLoopbackName(name), name).toBe(false)
    }
  })
})

describe('isLoopbackOrigin', () => {
  it('accepts pages served by this machine, on any port', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:42000')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:7860')).toBe(true)
    expect(isLoopbackOrigin('https://facefusion.localhost')).toBe(true)
  })

  it('refuses other sites, null and non-web origins', () => {
    expect(isLoopbackOrigin('https://evil.example')).toBe(false)
    expect(isLoopbackOrigin('null')).toBe(false)
    expect(isLoopbackOrigin('file://')).toBe(false)
    expect(isLoopbackOrigin('chrome-extension://abc')).toBe(false)
  })
})

describe('checkRequest', () => {
  it('lets the Pinokio UI and Jarod-OS through', () => {
    expect(checkRequest({ host: '127.0.0.1:42000', origin: 'http://127.0.0.1:42000' })).toEqual({ ok: true })
    // Jarod-OS (main process, the core's tools) sends no Origin.
    expect(checkRequest({ host: 'localhost:42000' })).toEqual({ ok: true })
  })

  it('stops a web page in a browser from driving the engine (cross-site WebSocket)', () => {
    expect(checkRequest({ host: 'localhost:42000', origin: 'https://evil.example' })).toMatchObject({ ok: false })
    expect(checkRequest({ host: 'localhost:42000', origin: 'null' })).toMatchObject({ ok: false })
  })

  it('stops DNS rebinding and requests addressed to the network name', () => {
    expect(checkRequest({ host: 'rebind.evil.example:42000' })).toMatchObject({ ok: false })
    expect(checkRequest({ host: '192.168.1.42:42000' })).toMatchObject({ ok: false })
    expect(checkRequest({})).toMatchObject({ ok: false })
  })

  it('reads the first value of repeated headers', () => {
    expect(checkRequest({ host: ['127.0.0.1:42000', 'evil'], origin: ['http://localhost:42000'] })).toEqual({ ok: true })
  })
})
