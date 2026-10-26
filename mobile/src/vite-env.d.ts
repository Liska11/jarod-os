/// <reference types="vite/client" />

/** From package.json (vite.config.ts). */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** "1" in a demo build only: a pretend PC answers (src/dev/demo.ts). */
  readonly VITE_DEMO?: string
}
