import type { HeraldOSApi } from '../../preload/index.ts'

declare global {
  interface Window {
    heraldOS: HeraldOSApi
  }
}
