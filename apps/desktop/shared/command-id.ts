/**
 * The shape of an OS command id: `area.verb`, optionally `area.sub.verb`. The first segment is
 * lowercase letters and digits; later ones start with a lowercase letter and may hold camelCase and
 * underscores (`software.local_model`). The command registry, plugin manifests and menu extensions
 * all validate against this one pattern so they cannot drift apart.
 */
export const COMMAND_ID = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9_]*)+$/

export const isCommandId = (value: string): boolean => COMMAND_ID.test(value)
