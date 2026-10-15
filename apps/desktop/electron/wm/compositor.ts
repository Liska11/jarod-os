import type { WmAction, WmState, WmWindow } from '../../shared/ipc.ts'
import { HyprlandClient } from './hyprland.ts'
import { NiriClient } from './niri.ts'

/**
 * What the shell needs from the compositor it runs in: a mirror of windows and workspaces, the
 * focused window (context for "ask about this window") and actions. niri runs the Jarod-OS session;
 * Hyprland is where Herald runs as an app (Omarchy).
 */
export interface Compositor {
  readonly name: CompositorName
  readonly available: boolean
  start(): void
  stop(): void
  state(): WmState
  onState(listener: (state: WmState) => void): () => void
  focusedWindow(): WmWindow | null
  /** One of this process's windows, by title. */
  ourWindow(title: string): WmWindow | undefined
  action(action: WmAction): Promise<void>
  /** Compositor-specific arguments (`niri msg action …`, `hyprctl dispatch …`). */
  raw(args: string[]): Promise<void>
}

export type CompositorName = 'niri' | 'hyprland'

/** The compositor this session runs under, from the sockets each one advertises. */
export function detectCompositor(env: NodeJS.ProcessEnv = process.env): CompositorName | null {
  if (env.NIRI_SOCKET) {
    return 'niri'
  }

  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    return 'hyprland'
  }

  return null
}

export function createCompositor(name: CompositorName | null, capture?: (what: 'screen' | 'window' | 'region') => void): Compositor | null {
  if (name === 'niri') {
    return new NiriClient()
  }

  if (name === 'hyprland') {
    return new HyprlandClient(capture)
  }

  return null
}

/** Every action the `WmAction` union names. Anything else is not a request this shell makes. */
const WM_ACTION_TYPES = new Set([
  'focus-window',
  'close-window',
  'focus-workspace',
  'move-window-to-workspace',
  'toggle-floating',
  'fullscreen',
  'maximize-column',
  'toggle-overview',
  'screenshot',
])

/**
 * Whether a value that arrived over IPC is one of the actions above, with the arguments each one
 * takes. Main validates the shape itself rather than trusting the renderer's types: a window is not
 * the place a host action is decided, and an action the union does not name must never reach the
 * compositor transport (R3.2).
 */
export function knownWmAction(value: unknown): value is WmAction {
  if (!value || typeof value !== 'object') {
    return false
  }

  const action = value as Record<string, unknown>

  if (typeof action.type !== 'string' || !WM_ACTION_TYPES.has(action.type)) {
    return false
  }

  const ref = action.ref
  const workspaceRef = typeof ref === 'string' || Number.isInteger(ref)

  switch (action.type) {
    case 'focus-window':
    case 'close-window':
    case 'toggle-floating':
    case 'fullscreen':
      return Number.isInteger(action.id)
    case 'focus-workspace':
      return workspaceRef
    case 'move-window-to-workspace':
      return Number.isInteger(action.id) && workspaceRef
    case 'screenshot':
      return action.what === 'screen' || action.what === 'window' || action.what === 'select'
    default:
      return true
  }
}
