import type { JarodOSApi } from '../../preload/index.ts'

declare global {
  interface Window {
    jarodOS: JarodOSApi
  }
}
