/*
 * The model button of Settings → Hermes & agents: the choice made, or the invitation to make one. A profile that never chose has none (the engine answers
 * `model.options` with empty `provider`/`model` and `needs_choice`), and the core's built-in default is not shown as if the user had picked it.
 */

export function shortModel(model: string | undefined | null): string {
  if (!model) {
    return 'Automatic'
  }

  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}

export function modelButtonLabel(options: { provider?: string; model?: string; needs_choice?: boolean } | null | undefined, chat: { provider?: string; model?: string } | null | undefined): string {
  if (options?.needs_choice) {
    return 'Choose a model'
  }

  const current = options?.model ?? chat?.model
  const provider = options?.provider ?? chat?.provider

  return provider ? `${provider} · ${shortModel(current)}` : `Hermes · ${shortModel(current)}`
}
