/** What the single maximize / restore button does, given the window's state (pure; the handler applies it). */
export type MaximizeAction = 'leave-fullscreen' | 'unmaximize' | 'maximize'

export function maximizeAction(state: { fullscreen: boolean; maximized: boolean }): MaximizeAction {
  if (state.fullscreen) {
    return 'leave-fullscreen'
  }

  return state.maximized ? 'unmaximize' : 'maximize'
}
