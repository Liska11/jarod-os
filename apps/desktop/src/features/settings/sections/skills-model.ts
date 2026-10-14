/*
 * Skills: the data side of the section (no React). Mirrors `list-installed-skills`, `registry-fetch`, `registry-detail`, `registry-install`.
 */

import { t } from '../../../lib/i18n.ts'

export interface InstalledSkill {
  id: string
  name: string
  category: string
  description: string
  path: string
  enabled: boolean
}

export type RegistryKind = 'skills' | 'mcps' | 'agents'

export interface RegistryItem {
  id: string
  name: string
  description: string
  author?: string
  category?: string
  tags?: string[]
  license?: string
  version?: string
  homepage?: string
}

export interface RegistryCatalog {
  skills: RegistryItem[]
  mcps: RegistryItem[]
  agents: RegistryItem[]
  error?: string
}

export interface RegistryDetail {
  markdown?: string
  description?: string
  rows?: { label: string; value?: string; mono?: boolean; chips?: string[] }[]
}

export interface InstalledRegistry {
  skills: string[]
  mcps: string[]
  workflows: string[]
}

/** The registry kinds' names in the catalogue. */
export const KIND_KEY: Record<RegistryKind, 'skills.kind.skills' | 'skills.kind.mcps' | 'skills.kind.agents'> = {
  skills: 'skills.kind.skills',
  mcps: 'skills.kind.mcps',
  agents: 'skills.kind.agents'
}

/** The registry kind's name in the current language. */
export function kindLabel(kind: RegistryKind): string {
  return t(KIND_KEY[kind])
}

/** True when the text is found in any of the fields (case-insensitive, all words). */
export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return true
  }

  const hay = fields.join(' ').toLowerCase()

  return words.every(word => hay.includes(word))
}

/** Installed skills for a search, enabled first then by name; the category folder is searched too. */
export function filterSkills(skills: readonly InstalledSkill[], query: string): InstalledSkill[] {
  return skills
    .filter(skill => matchesQuery(query, skill.name, skill.description, skill.category))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

/** The `disabledSkills` list to write after switching one skill: every disabled id, without duplicates. */
export function disabledAfterToggle(skills: readonly InstalledSkill[], id: string, enabled: boolean): string[] {
  const disabled = new Set(skills.filter(skill => !skill.enabled).map(skill => skill.id))

  if (enabled) {
    disabled.delete(id)
  } else {
    disabled.add(id)
  }

  return [...disabled].sort()
}

export function summaryOfSkills(skills: readonly InstalledSkill[]): string {
  const off = skills.filter(skill => !skill.enabled).length

  return off > 0 ? t('skills.summary.off', { count: skills.length, off }) : t('skills.summary', { count: skills.length })
}

/** Is a registry entry already installed? Skills and MCP servers are matched by name; agents become profiles (not listed here). */
export function isInstalled(kind: RegistryKind, item: RegistryItem, installed: InstalledRegistry | null): boolean {
  if (!installed || kind === 'agents') {
    return false
  }

  const names = kind === 'skills' ? installed.skills : installed.mcps

  return names.includes(item.id) || names.includes(item.name)
}

/** Registry items for a search, the ones not installed first. */
export function filterRegistry(kind: RegistryKind, items: readonly RegistryItem[], query: string, installed: InstalledRegistry | null): RegistryItem[] {
  return items
    .filter(item => matchesQuery(query, item.name, item.description, item.author, item.category, ...(item.tags ?? [])))
    .sort((a, b) => Number(isInstalled(kind, a, installed)) - Number(isInstalled(kind, b, installed)) || a.name.localeCompare(b.name))
}

/** The install channel answers `{ success, error? }`; turn it into a sentence. */
export function installOutcome(result: { success?: boolean; error?: string } | null | undefined): { ok: boolean; text: string } {
  if (result?.success) {
    return { ok: true, text: t('skills.installedOutcome') }
  }

  const error = result?.error ?? t('skills.installFailed')

  return { ok: false, text: error }
}

/** Cancelling the native confirmation is not a failure. */
export function wasCancelled(text: string): boolean {
  return /annulée|cancel/i.test(text)
}
