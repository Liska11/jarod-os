/**
 * The privileged host actions that are not renderer registry commands (R3.1, extended R3.2).
 *
 * Three families live outside the renderer's own catalogue and still change the machine: the plugin
 * administration IPC (`plugins/*`), the `herald-os` CLI a window asks main to spawn, and the
 * machine-level actions main performs itself (the idle unit restart, the power actions). All are
 * declared here, in the main process, and merged into the one catalogue the gates and the securities
 * learn from (`main.ts`), so every one of them has a tier and an id nothing declared is refused as
 * `unknown command …` rather than guessed at.
 *
 * The CLI table is keyed by the verb a person, a menu entry or the shell itself can reach. A verb's
 * tier is its most conservative reading — what it is worth when nothing more specific matches — and a
 * sub-verb entry only ever refines that policy: a sub-verb that changes the machine is
 * `mutate`/`destructive` even under a verb that mostly reports, and a sub-verb that only reports is
 * `read` under a verb that also changes something. An unlisted sub-verb keeps the verb's tier, so a
 * table thinner than the CLI can never *lower* what an action is worth.
 *
 * `os` and `os-run` are deliberately absent: they are retired, and a retired verb stays refused.
 */

import { type PowerAction } from '../../shared/ipc.ts'
import { asControlTier, type ControlTier } from './control-authz.ts'
import type { CatalogueEntry, RegistryArgSpec } from './host-control.ts'

/** The plugin administration IPC, as ids the gate and the journal can name. */
export const PLUGIN_ACTIONS = {
  add: 'plugin.add',
  update: 'plugin.update',
  remove: 'plugin.remove',
  setEnabled: 'plugin.set-enabled',
} as const

interface CliVerb {
  /** What this verb is worth when no more specific entry matches. */
  tier: ControlTier
  /** Sub-verbs whose tier differs from the verb's; a refinement, never a relaxation of the verb. */
  sub?: Readonly<Record<string, ControlTier>>
}

const PLUGIN_SCHEMAS: Readonly<Record<string, readonly RegistryArgSpec[]>> = {
  [PLUGIN_ACTIONS.add]: [{ name: 'url', type: 'string', required: true }],
  [PLUGIN_ACTIONS.update]: [{ name: 'id', type: 'string', required: true }],
  [PLUGIN_ACTIONS.remove]: [{ name: 'id', type: 'string', required: true }],
  [PLUGIN_ACTIONS.setEnabled]: [
    { name: 'id', type: 'string', required: true },
    { name: 'enabled', type: 'boolean', required: true },
  ],
}

const PLUGIN_TIERS: Readonly<Record<string, ControlTier>> = {
  [PLUGIN_ACTIONS.add]: 'mutate',
  [PLUGIN_ACTIONS.update]: 'mutate',
  [PLUGIN_ACTIONS.remove]: 'destructive',
  [PLUGIN_ACTIONS.setEnabled]: 'mutate',
}

/**
 * The machine-level actions main performs itself, with the tier each is worth. `herald-os-idle
 * restart` reapplies the idle timings the shell just wrote; the power actions stop, restart or end
 * the session, so they are the same class of effect as the CLI's own `power` verb and are tiered the
 * same way — locking and suspending change the session, logging out, rebooting and powering off end
 * it. None of them is reachable from a window without naming one of these ids.
 */
const SHELL_ACTIONS: Readonly<Record<string, ControlTier>> = {
  'shell.idle-restart': 'mutate',
  'shell.power.lock': 'mutate',
  'shell.power.suspend': 'mutate',
  'shell.power.logout': 'destructive',
  'shell.power.reboot': 'destructive',
  'shell.power.poweroff': 'destructive',
  'shell.winget.upgrade': 'mutate',
}

/**
 * Upgrading one winget package the update check listed (`winget-install.ts`), after the person confirmed its exact id, version and
 * source. It installs software, so it is `mutate`; its arguments are exactly those three, anything more is refused.
 */
export const WINGET_UPGRADE_ACTION = 'shell.winget.upgrade'

const SHELL_SCHEMAS: Readonly<Record<string, readonly RegistryArgSpec[]>> = {
  [WINGET_UPGRADE_ACTION]: [
    { name: 'id', type: 'string', required: true },
    { name: 'version', type: 'string', required: true },
    { name: 'source', type: 'string', required: true },
  ],
}

/** The idle unit restart, as the catalogue id the gate and the journal name it by. */
export const IDLE_RESTART_ACTION = 'shell.idle-restart'

/** Every power action a window may ask for, as the catalogue id it becomes. */
export const POWER_ACTIONS: Readonly<Record<PowerAction, string>> = {
  lock: 'shell.power.lock',
  suspend: 'shell.power.suspend',
  logout: 'shell.power.logout',
  reboot: 'shell.power.reboot',
  poweroff: 'shell.power.poweroff',
}

/**
 * Every `herald-os` verb a window may ask main to spawn, with its tier. A verb absent from this table
 * is refused before a process is started: the spawn path is an allow-list, not a free argv surface.
 */
const CLI_VERBS: Readonly<Record<string, CliVerb>> = {
  applications: { tier: 'act' },
  ask: { tier: 'act' },
  bar: { tier: 'mutate', sub: { list: 'read' } },
  branding: { tier: 'mutate', sub: { show: 'read' } },
  capture: { tier: 'act', sub: { color: 'read', qr: 'read', text: 'read', transcode: 'mutate' } },
  catalog: { tier: 'mutate', sub: { install: 'mutate', list: 'read', status: 'read', remove: 'destructive' } },
  channel: { tier: 'mutate' },
  clipboard: { tier: 'act' },
  command: { tier: 'act' },
  commands: { tier: 'read' },
  crash: { tier: 'act' },
  debug: { tier: 'read' },
  dictate: { tier: 'act' },
  emoji: { tier: 'act' },
  event: { tier: 'act' },
  firmware: { tier: 'destructive', sub: { check: 'read' } },
  font: { tier: 'mutate', sub: { list: 'read' } },
  hook: { tier: 'mutate', sub: { dir: 'read', list: 'read' } },
  idle: { tier: 'mutate', sub: { show: 'read' } },
  install: { tier: 'mutate' },
  keymap: { tier: 'mutate', sub: { show: 'read' } },
  launch: { tier: 'act' },
  lock: { tier: 'act' },
  menu: { tier: 'act' },
  notice: { tier: 'act' },
  notify: { tier: 'act' },
  ocr: { tier: 'act' },
  omakase: { tier: 'mutate', sub: { list: 'read' } },
  omarchy: { tier: 'mutate', sub: { status: 'read' } },
  open: { tier: 'act' },
  page: { tier: 'act' },
  panel: { tier: 'act' },
  password: { tier: 'destructive' },
  plugin: {
    tier: 'mutate',
    sub: { add: 'mutate', dir: 'read', disable: 'mutate', enable: 'mutate', list: 'read', remove: 'destructive', update: 'mutate' },
  },
  power: { tier: 'act' },
  reminder: { tier: 'act', sub: { clear: 'act', list: 'read' } },
  remove: { tier: 'destructive' },
  reset: { tier: 'destructive' },
  rollback: { tier: 'destructive' },
  run: { tier: 'mutate' },
  screenshot: { tier: 'act' },
  screensaver: { tier: 'act' },
  setup: { tier: 'mutate' },
  state: { tier: 'read' },
  suspend: { tier: 'act' },
  theme: { tier: 'mutate', sub: { current: 'read', list: 'read' } },
  toggle: { tier: 'mutate' },
  update: { tier: 'mutate' },
  'update-available': { tier: 'read' },
  voice: { tier: 'act' },
  wallpaper: { tier: 'mutate' },
  weather: { tier: 'act', sub: { location: 'mutate' } },
  'webapp-open': { tier: 'act' },
  windows: { tier: 'mutate', sub: { connect: 'act', remove: 'destructive', start: 'act', status: 'read', stop: 'act' } },
  wm: { tier: 'act' },
}

/**
 * The catalogue id of one CLI argv, or `null` when the verb is not one this table declares. An
 * unlisted sub-verb keeps the verb's own id — and so the verb's tier — rather than inventing a policy
 * for it; an unlisted verb yields `null`, and the caller refuses instead of starting a process.
 */
export function cliActionId(argv: readonly string[]): string | null {
  const verb = String(argv[0] ?? '').trim()
  const spec = CLI_VERBS[verb]

  if (!spec) {
    return null
  }

  const sub = String(argv[1] ?? '').trim()

  return spec.sub?.[sub] ? `cli.${verb}.${sub}` : `cli.${verb}`
}

/** The entries these tables add to the shell's own catalogue (see `main.ts`). */
export function hostCatalogueEntries(): CatalogueEntry[] {
  const entries: CatalogueEntry[] = Object.values(PLUGIN_ACTIONS).map(id => ({
    id,
    tier: PLUGIN_TIERS[id],
    args: PLUGIN_SCHEMAS[id],
  }))

  for (const [verb, spec] of Object.entries(CLI_VERBS)) {
    entries.push({ id: `cli.${verb}`, tier: spec.tier })

    for (const [sub, tier] of Object.entries(spec.sub ?? {})) {
      entries.push({ id: `cli.${verb}.${sub}`, tier })
    }
  }

  for (const [id, tier] of Object.entries(SHELL_ACTIONS)) {
    entries.push(SHELL_SCHEMAS[id] ? { id, tier, args: SHELL_SCHEMAS[id] } : { id, tier })
  }

  return entries
}

/**
 * The same entries as a tier lookup. A security consults this from the moment the gates exist, so a
 * host action is decidable before the renderer has registered anything — the setup wizard may set a
 * password on a first run, long before the registry catalogue arrives (`main.ts`).
 */
export function hostCatalogueTiers(): Map<string, ControlTier> {
  const tiers = new Map<string, ControlTier>()

  for (const entry of hostCatalogueEntries()) {
    const tier = asControlTier(entry.tier)

    if (tier) {
      tiers.set(entry.id, tier)
    }
  }

  return tiers
}
