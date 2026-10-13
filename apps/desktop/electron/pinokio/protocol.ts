/* The IPC channel between main (service.ts) and the pinokiod host (host.ts). */

/** pinokiod listens on this port, always (upstream DEFAULT_PORT; not configurable). */
export const PINOKIO_PORT = 42000

/** host → main */
export type HostMessage =
  | { type: 'ready'; port: number; version: string; home: string | null }
  | { type: 'error'; message: string }
  /** pinokiod wants a page shown: `window` in Jarod-OS, `browser` in the system browser. */
  | { type: 'open'; url: string; surface: 'window' | 'browser' }
  | { type: 'quit' }
  | { type: 'restart' }

/** main → host */
export type ParentMessage = { type: 'stop' }
