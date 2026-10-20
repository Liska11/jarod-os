import { IconBrandNodejs, IconBrandPython, IconPlus, IconTerminal2, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import type { EnvironmentsState, EnvironmentSummary } from '../../../../shared/environments.ts'
import { GlassButton, GlassCard } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { type MessageKey, useT } from '../../../lib/i18n.ts'
import { openTerminalEnvironment } from '../../../store/terminal.ts'
import { SettingsBlock } from './shared.tsx'

const DEFAULT_VERSION = { python: '3.12', node: '22' } as const

/** A folder-safe environment name from what the person typed. */
export function environmentSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * Environments of the Jarod disk (electron/environments.ts): a Python (uv) or Node.js runtime per project, kept out of
 * the system, opened in a Terminal tab with its tools first in PATH, or thrown away to the Recycle Bin.
 */
export function EnvironmentsBlock() {
  const { t } = useT()
  const [state, setState] = useState<EnvironmentsState | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'python' | 'node'>('python')
  const [version, setVersion] = useState<string>(DEFAULT_VERSION.python)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.jarodOS.environments
      .state()
      .then(setState)
      .catch(() => undefined)
  }, [])

  useEffect(refresh, [refresh])

  const describe = (reason: string) =>
    ['no-disk', 'busy', 'bad-name', 'bad-version', 'exists', 'no-release', 'no-uv'].includes(reason) ? t(`environments.error.${reason}` as MessageKey) : t('environments.error.other', { detail: reason })

  const create = async () => {
    setBusy(true)
    setError(null)
    const result = await window.jarodOS.environments.create(environmentSlug(name), kind, version.trim()).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))

    if (result.ok) setName('')
    else setError(describe(result.error))

    setBusy(false)
    refresh()
  }

  const remove = async (target: string) => {
    setConfirm(null)
    const result = await window.jarodOS.environments.remove(target).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))

    if (!result.ok) setError(describe(result.error))

    refresh()
  }

  return (
    <SettingsBlock title={t('environments.title')} label={t('environments.title')} description={t('environments.text')} keywords={t('environments.keywords')}>
      <GlassCard className="flex flex-col gap-3 p-4">
        <p className="text-[12.5px] text-fg-3">{t('environments.text')}</p>

        {state && !state.available ? (
          <p className="text-[12.5px] text-fg-2">{t('environments.needsDisk')}</p>
        ) : !state ? (
          <Spinner />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input value={name} onChange={event => setName(event.target.value)} placeholder={t('environments.name')} aria-label={t('environments.name')} className="glass-input h-8 w-44 rounded-lg px-2.5 text-[12.5px] outline-none" />
              <select
                value={kind}
                onChange={event => {
                  const next = event.target.value as 'python' | 'node'
                  setKind(next)
                  setVersion(DEFAULT_VERSION[next])
                }}
                aria-label={t('environments.kind')}
                className="glass-input h-8 rounded-lg px-2 text-[12.5px] outline-none"
              >
                <option value="python">Python</option>
                <option value="node">Node.js</option>
              </select>
              <input value={version} onChange={event => setVersion(event.target.value)} aria-label={t('environments.version')} className="glass-input h-8 w-20 rounded-lg px-2.5 font-mono text-[12.5px] outline-none" />
              <span className="flex-1" />
              <GlassButton size="sm" variant="primary" disabled={!environmentSlug(name) || !version.trim() || busy || Boolean(state.building)} onClick={() => void create()}>
                {busy || state.building ? <Spinner /> : <IconPlus />}
                {busy || state.building ? t('environments.building') : t('environments.create')}
              </GlassButton>
            </div>
            {name && environmentSlug(name) !== name && <p className="font-mono text-[11px] text-fg-3">{environmentSlug(name)}</p>}
            {error && <p className="text-[12.5px] text-danger">{error}</p>}

            {state.list.length === 0 ? (
              <p className="text-[12.5px] text-fg-3">{t('environments.none')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {state.list.map(env => (
                  <EnvironmentRow key={env.name} env={env} confirming={confirm === env.name} onConfirm={setConfirm} onRemove={() => void remove(env.name)} />
                ))}
              </ul>
            )}
          </>
        )}
      </GlassCard>
    </SettingsBlock>
  )
}

function EnvironmentRow({ env, confirming, onConfirm, onRemove }: { env: EnvironmentSummary; confirming: boolean; onConfirm: (name: string | null) => void; onRemove: () => void }) {
  const { t } = useT()

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-3">
        {env.kind === 'python' ? <IconBrandPython size={16} className="shrink-0 text-fg-3" /> : <IconBrandNodejs size={16} className="shrink-0 text-fg-3" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg">{env.name}</div>
          <div className="text-[11.5px] text-fg-3">
            {env.kind === 'python' ? 'Python' : 'Node.js'} {env.version}
          </div>
        </div>
        <GlassButton size="sm" variant="ghost" onClick={() => openTerminalEnvironment(env.name)}>
          <IconTerminal2 />
          {t('environments.terminal')}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('environments.remove')} onClick={() => onConfirm(env.name)}>
          <IconTrash />
        </GlassButton>
      </div>
      {confirming && (
        <div className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-[12.5px] text-fg-2">
          <span className="flex-1">{t('environments.confirmRemove')}</span>
          <GlassButton size="sm" variant="ghost" onClick={() => onConfirm(null)}>
            {t('backups.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant="danger" onClick={onRemove}>
            {t('sandboxes.removeNow')}
          </GlassButton>
        </div>
      )}
    </li>
  )
}
