import { IconAlertTriangle, IconCheck, IconFileImport, IconKey, IconX } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { type MessageKey, t } from '../../lib/i18n.ts'
import { jarod } from '../../lib/jarod.ts'
import { type Destination, importable, type KeyLine, MESSAGING_KEYS, maskValue, parseKeysFile, parseLine, settleLines } from './keys-import.ts'
import { Footer, Heading } from './parts.tsx'

type Outcome = { ok: boolean; where?: Destination; error?: string }

/** Save one key where the engine keeps it; a provider key the engine does not know goes to the vault instead. */
async function saveKey(entry: KeyLine): Promise<Outcome> {
  try {
    if (entry.destination === 'messaging') {
      await jarod('update-messaging-platform', MESSAGING_KEYS[entry.name], { env: { [entry.name]: entry.value } })
      return { ok: true, where: 'messaging' }
    }
    if (entry.destination === 'provider') {
      try {
        await jarod('set-env', entry.name, entry.value)
        return { ok: true, where: 'provider' }
      } catch {
        // No provider of that name in this engine: keep it in the vault rather than lose it.
      }
    }
    await jarod('vault-save', { name: entry.name, envVar: entry.name, description: t('setup.keys.vaultDescription') }, entry.value)
    return { ok: true, where: 'vault' }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

function problemText(entry: KeyLine): string {
  if (entry.status === 'replaced') return t('setup.keys.problem.replaced', { line: entry.problem ?? '' })
  const problem = entry.problem ?? ''
  if (problem.startsWith('format:')) return t('setup.keys.problem.format', { shape: problem.slice('format:'.length) })
  return t(`setup.keys.problem.${problem}` as MessageKey)
}

/**
 * First-run API keys: import a `.txt` (or paste it), review each line — a bad one can be corrected in place — then save
 * the valid keys into the engine's encrypted stores. The text is dropped from memory once imported; keys are only ever
 * shown masked.
 */
export function KeysStep({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState<KeyLine[] | null>(null)
  const [paste, setPaste] = useState('')
  const [results, setResults] = useState<Record<number, Outcome>>({})
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const load = (text: string) => {
    setResults({})
    setLines(parseKeysFile(text).filter(entry => entry.status !== 'skipped'))
    setPaste('')
  }

  const fix = (line: number, raw: string) => {
    // Only the corrected line is read again; duplicates are then judged over the whole set.
    setLines(current => (current ? settleLines(current.map(entry => (entry.line === line ? parseLine(raw, line) : entry))) : current))
  }

  const valid = lines ? importable(lines) : []
  const done = valid.length > 0 && valid.every(entry => results[entry.line]?.ok)

  const save = async () => {
    setBusy(true)
    const next: Record<number, Outcome> = { ...results }
    for (const entry of valid) {
      if (next[entry.line]?.ok) continue
      next[entry.line] = await saveKey(entry)
      setResults({ ...next })
    }
    setBusy(false)
    // Keep only what the screen needs: names and outcomes, no values.
    setLines(current => current?.map(entry => ({ ...entry, value: entry.value ? maskValue(entry.value) : '', raw: '' })) ?? null)
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Heading icon={<IconKey size={18} />} title={t('setup.keys.title')} text={t('setup.keys.text')} />

      {!lines && (
        <div className="flex flex-col gap-3">
          <input
            ref={file}
            type="file"
            accept=".txt,.env,text/plain"
            className="hidden"
            onChange={event => {
              const chosen = event.target.files?.[0]
              if (chosen) void chosen.text().then(load)
              event.target.value = ''
            }}
          />
          <GlassButton variant="ghost" onClick={() => file.current?.click()}>
            <IconFileImport size={15} /> {t('setup.keys.choose')}
          </GlassButton>
          <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
            {t('setup.keys.paste')}
            <textarea
              value={paste}
              onChange={event => setPaste(event.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={'OPENAI_API_KEY=sk-…\nANTHROPIC_API_KEY=sk-ant-…'}
              className="glass-input rounded-lg px-3 py-2 font-mono text-[12px] text-fg outline-none"
            />
          </label>
          {paste.trim() && (
            <div className="flex justify-end">
              <GlassButton variant="primary" onClick={() => load(paste)}>
                {t('setup.keys.read')}
              </GlassButton>
            </div>
          )}
        </div>
      )}

      {lines && (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-1">
          {lines.length === 0 && <li className="text-[12.5px] text-fg-3">{t('setup.keys.empty')}</li>}
          {lines.map(entry => (
            <KeyRow key={entry.line} entry={entry} outcome={results[entry.line]} onFix={raw => fix(entry.line, raw)} locked={busy || Boolean(results[entry.line]?.ok)} />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2">
        <GlassButton variant="ghost" onClick={lines && !done ? () => setLines(null) : onDone} disabled={busy}>
          {lines && !done ? t('setup.keys.other') : t('setup.later')}
        </GlassButton>
        {done ? (
          <Footer onNext={onDone} label={t('setup.next')} />
        ) : (
          <Footer onNext={() => void save()} label={t('setup.keys.import', { count: valid.length })} busy={busy} disabled={valid.length === 0} />
        )}
      </div>
    </div>
  )
}

function KeyRow({ entry, outcome, onFix, locked }: { entry: KeyLine; outcome?: Outcome; onFix: (raw: string) => void; locked: boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  const bad = entry.status === 'invalid'

  return (
    <li className={cn('glass-input flex flex-col gap-1 rounded-lg px-3 py-2 text-[12.5px]', bad && 'border-danger/60')}>
      <div className="flex items-center gap-2">
        {outcome?.ok ? <IconCheck size={14} className="text-ok" /> : outcome ? <IconX size={14} className="text-danger" /> : bad ? <IconAlertTriangle size={14} className="text-warn" /> : <IconKey size={14} className="text-fg-3" />}
        <span className="text-fg-3">{t('setup.keys.line', { line: entry.line })}</span>
        <span className="font-mono text-fg">{entry.name || '—'}</span>
        {entry.renamedFrom && <span className="text-fg-4">{t('setup.keys.renamed', { name: entry.renamedFrom })}</span>}
        <span className="font-mono text-fg-3">{entry.value ? maskValue(entry.value) : ''}</span>
        <span className="min-w-0 flex-1 truncate text-right text-fg-3">
          {outcome?.ok
            ? t(`setup.keys.saved.${outcome.where ?? 'vault'}` as MessageKey)
            : outcome?.error
              ? outcome.error
              : entry.status === 'ok'
                ? t(`setup.keys.to.${entry.destination ?? 'vault'}` as MessageKey)
                : problemText(entry)}
        </span>
      </div>
      {bad && !locked && (
        <form
          className="flex gap-2"
          onSubmit={event => {
            event.preventDefault()
            if (draft !== null) onFix(draft)
            setDraft(null)
          }}
        >
          <input
            value={draft ?? ''}
            onChange={event => setDraft(event.target.value)}
            placeholder={t('setup.keys.fixPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            className="glass-input h-8 min-w-0 flex-1 rounded-md px-2 font-mono text-[12px] text-fg outline-none"
          />
          <GlassButton type="submit" size="sm" variant="ghost" disabled={!draft?.trim()}>
            {t('setup.keys.fix')}
          </GlassButton>
        </form>
      )}
    </li>
  )
}
