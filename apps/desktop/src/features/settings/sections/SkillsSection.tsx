import { IconBook2, IconCompass, IconSearch, IconSparkles } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { useJarodSettings } from './jarod-controls.tsx'
import { disabledAfterToggle, filterRegistry, filterSkills, type InstalledRegistry, type InstalledSkill, installOutcome, isInstalled, KIND_LABEL, type RegistryCatalog, type RegistryDetail, type RegistryItem, type RegistryKind, summaryOfSkills, wasCancelled } from './skills-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Skills: what the agent knows how to do, and where to find more.
 *   Installed: switch a skill on or off for the agent, read its SKILL.md, remove it (archived, recoverable)
 *   Discover: browse the community registry (skills, MCP servers, agents). Nothing is fetched until you press Browse. Installing shows the source, licence,
 *   hash and permissions in a native confirmation first; skills are also scanned for dangerous patterns.
 */

export function SkillsSection() {
  return (
    <>
      <SectionTitle title="Skills" subtitle="What the agent knows how to do, and where to find more." />
      <InstalledSkills />
      <Discover />
    </>
  )
}

function InstalledSkills() {
  const skills = useBackendData(() => jarod<InstalledSkill[]>('list-installed-skills'))
  const settings = useJarodSettings()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  if (isUnsupported(skills.error)) {
    return <InlineNote tone="info">Skills need the Jarod engine.</InlineNote>
  }

  const data = skills.data ?? []
  const shown = filterSkills(data, query)

  const toggle = async (skill: InstalledSkill, enabled: boolean) => {
    setBusy(skill.id)

    if (await settings.save({ disabledSkills: disabledAfterToggle(data, skill.id, enabled) }, enabled ? `${skill.name} switched on` : `${skill.name} switched off`)) {
      skills.reload()
    }

    setBusy(null)
  }

  const view = async (skill: InstalledSkill) => {
    if (open === skill.id) {
      setOpen(null)

      return
    }

    setOpen(skill.id)
    setContent(null)

    try {
      setContent((await jarod<string>('get-skill-content', skill.path)) || 'This skill has no SKILL.md to show.')
    } catch (error) {
      setContent(`Could not read it: ${errorText(error)}`)
    }
  }

  const remove = async (skill: InstalledSkill) => {
    setBusy(skill.id)
    setConfirming(null)

    try {
      const result = await jarod<{ success: boolean; error?: string }>('uninstall-skill', skill.id)

      if (result.success) {
        markSaved()
        notify({ title: 'Skill removed', body: `${skill.name} was archived; it can be restored from the profile’s .archive folder.`, level: 'success' })
        skills.reload()
      } else {
        notify({ title: 'Could not remove the skill', body: result.error ?? 'Unknown error', level: 'error' })
      }
    } catch (error) {
      notify({ title: 'Could not remove the skill', body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup title="Installed">
      <SettingsRow icon={<IconSparkles />} label={summaryOfSkills(data)} description="A skill that is switched off is not offered to the model." keywords="skills installed enabled disabled">
        <label className="glass-input flex h-8 w-[220px] items-center gap-2 rounded-lg px-2.5">
          <IconSearch size={14} className="text-fg-3" />
          <span className="sr-only">Search installed skills</span>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search skills" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
        </label>
      </SettingsRow>
      {skills.error && <InlineNote tone="danger">Could not read the skills: {skills.error}</InlineNote>}
      {shown.map(skill => (
        <SettingsRow
          key={skill.id}
          icon={<IconBook2 />}
          label={skill.name}
          description={<span className="line-clamp-2">{skill.description || 'No description.'}</span>}
          keywords={`skill ${skill.id} ${skill.category}`}
          below={open === skill.id && <pre className="max-h-72 overflow-auto rounded-lg bg-black/25 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">{content ?? 'Reading…'}</pre>}
        >
          {skill.category && <Pill tone="muted">{skill.category}</Pill>}
          <GlassButton size="sm" variant="ghost" onClick={() => void view(skill)} aria-label={`${open === skill.id ? 'Hide' : 'Read'} ${skill.name}`}>
            {open === skill.id ? 'Hide' : 'Read'}
          </GlassButton>
          {confirming === skill.id ? (
            <>
              <GlassButton size="sm" variant="danger" disabled={busy === skill.id} onClick={() => void remove(skill)}>
                Remove
              </GlassButton>
              <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Keep
              </GlassButton>
            </>
          ) : (
            <GlassButton size="sm" variant="ghost" disabled={busy === skill.id} onClick={() => setConfirming(skill.id)} aria-label={`Remove ${skill.name}`}>
              Remove…
            </GlassButton>
          )}
          <Toggle checked={skill.enabled} label={`${skill.name} on or off`} disabled={busy === skill.id} onChange={value => void toggle(skill, value)} />
        </SettingsRow>
      ))}
      {skills.data && shown.length === 0 && <SettingsRow icon={<IconBook2 />} label={query ? 'No skill matches' : 'No skill installed'} description={query ? 'Try other words.' : 'Browse the registry below to add some.'} keywords="skills empty" />}
    </SettingsGroup>
  )
}

function Discover() {
  const [kind, setKind] = useState<RegistryKind>('skills')
  const [catalog, setCatalog] = useState<RegistryCatalog | null>(null)
  const [installed, setInstalled] = useState<InstalledRegistry | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<{ id: string; value: RegistryDetail | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const browse = async (force = false) => {
    setLoading(true)

    try {
      const [cat, inst] = await Promise.all([jarod<RegistryCatalog>('registry-fetch', force), jarod<InstalledRegistry>('registry-list-installed')])

      setCatalog(cat)
      setInstalled(inst)
    } catch (error) {
      setCatalog({ skills: [], mcps: [], agents: [], error: errorText(error) })
    } finally {
      setLoading(false)
    }
  }

  const show = async (item: RegistryItem) => {
    if (detail?.id === item.id) {
      setDetail(null)

      return
    }

    setDetail({ id: item.id, value: null })

    try {
      setDetail({ id: item.id, value: await jarod<RegistryDetail>('registry-detail', kind, item) })
    } catch (error) {
      setDetail({ id: item.id, value: { description: errorText(error) } })
    }
  }

  const install = async (item: RegistryItem) => {
    setBusy(item.id)

    try {
      const outcome = installOutcome(await jarod<{ success: boolean; error?: string }>('registry-install', kind, item))

      if (outcome.ok) {
        markSaved()
        notify({ title: `${item.name} installed`, level: 'success' })
        void browse()
      } else if (!wasCancelled(outcome.text)) {
        notify({ title: `Could not install ${item.name}`, body: outcome.text, level: 'error' })
      }
    } catch (error) {
      notify({ title: `Could not install ${item.name}`, body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const items = catalog ? filterRegistry(kind, catalog[kind], query, installed) : []

  return (
    <SettingsGroup title="Discover">
      <SettingsRow icon={<IconCompass />} label="Community registry" description="Skills, MCP servers and agents shared by the community. Nothing is fetched until you press Browse." keywords="discover registry community skills mcp agents browse install">
        <GlassButton size="sm" variant={catalog ? 'secondary' : 'primary'} disabled={loading} onClick={() => void browse(Boolean(catalog))}>
          {loading ? 'Loading…' : catalog ? 'Refresh' : 'Browse'}
        </GlassButton>
      </SettingsRow>
      {catalog?.error && <InlineNote tone="danger">The registry could not be read: {catalog.error}</InlineNote>}
      {catalog && !catalog.error && (
        <SettingsRow icon={<IconSearch />} label={`${catalog[kind].length} ${KIND_LABEL[kind].toLowerCase()}`} keywords="discover registry search kind">
          <div className="flex items-center gap-1" role="tablist" aria-label="Registry section">
            {(Object.keys(KIND_LABEL) as RegistryKind[]).map(k => (
              <GlassButton key={k} size="sm" variant={k === kind ? 'primary' : 'ghost'} role="tab" aria-selected={k === kind} onClick={() => (setKind(k), setDetail(null))}>
                {KIND_LABEL[k]}
              </GlassButton>
            ))}
          </div>
          <label className="glass-input flex h-8 w-[200px] items-center gap-2 rounded-lg px-2.5">
            <IconSearch size={14} className="text-fg-3" />
            <span className="sr-only">Search the registry</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
          </label>
        </SettingsRow>
      )}
      {items.slice(0, 60).map(item => {
        const done = isInstalled(kind, item, installed)

        return (
          <SettingsRow
            key={`${kind}:${item.id}`}
            icon={<IconCompass />}
            label={item.name}
            description={<span className="line-clamp-2">{[item.author, item.license, item.description].filter(Boolean).join(' · ')}</span>}
            keywords={`registry ${kind} ${item.id}`}
            below={detail?.id === item.id && <DetailView value={detail.value} />}
          >
            {done && <Pill tone="ok">Installed</Pill>}
            <GlassButton size="sm" variant="ghost" onClick={() => void show(item)} aria-label={`Details of ${item.name}`}>
              Details
            </GlassButton>
            <GlassButton size="sm" variant="primary" disabled={done || busy === item.id} onClick={() => void install(item)} aria-label={`Install ${item.name}`}>
              {busy === item.id ? 'Installing…' : 'Install…'}
            </GlassButton>
          </SettingsRow>
        )
      })}
      {catalog && !catalog.error && items.length > 60 && <SettingsRow icon={<IconSearch />} label={`${items.length - 60} more`} description="Narrow the search to see them." keywords="registry more" />}
    </SettingsGroup>
  )
}

function DetailView({ value }: { value: RegistryDetail | null }) {
  if (!value) {
    return <div className="text-[12px] text-fg-4">Reading…</div>
  }

  return (
    <div className="flex flex-col gap-2">
      {value.description && <div className="text-[12.5px] text-fg-2">{value.description}</div>}
      {value.rows?.map(row => (
        <div key={row.label} className="flex flex-col gap-0.5 text-[12px]">
          <span className="text-fg-4">{row.label}</span>
          {row.value && <span className={row.mono ? 'font-mono text-fg-2' : 'text-fg-2'}>{row.value}</span>}
          {row.chips && (
            <span className="flex flex-wrap gap-1">
              {row.chips.map(chip => (
                <Pill key={chip} tone="muted">
                  {chip}
                </Pill>
              ))}
            </span>
          )}
        </div>
      ))}
      {value.markdown && <pre className="max-h-72 overflow-auto rounded-lg bg-black/25 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">{value.markdown}</pre>}
    </div>
  )
}
