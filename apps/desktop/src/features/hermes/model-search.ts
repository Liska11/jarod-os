/** The model menu's search: every word typed must appear in "provider name + model", in any order ("google flash" finds Gemini Flash under Google). */
export interface SearchableProvider {
  slug: string
  name: string
  models: string[]
}

export interface SearchResult<P extends SearchableProvider> {
  providers: P[]
  /** How many models match, across all providers. */
  count: number
}

const normalize = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function searchModels<P extends SearchableProvider>(providers: readonly P[], query: string): SearchResult<P> {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  const rows = providers
    .map(p => ({ ...p, models: p.models.filter(model => words.every(word => normalize(`${p.name} ${p.slug} ${model}`).includes(word))) }))
    .filter(p => p.models.length > 0)

  return { providers: rows, count: rows.reduce((sum, p) => sum + p.models.length, 0) }
}

/** The first model of the first provider, for the Enter key. */
export function firstMatch<P extends SearchableProvider>(providers: readonly P[]): { slug: string; model: string } | null {
  const p = providers.find(row => row.models.length > 0)

  return p ? { slug: p.slug, model: p.models[0]! } : null
}

/** How many models a provider shows before "show all": few when browsing, more once the user is searching. */
export const COLLAPSED_MODELS = 40
