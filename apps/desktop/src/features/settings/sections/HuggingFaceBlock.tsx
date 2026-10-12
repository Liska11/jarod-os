import { IconBrandHipchat, IconDownload, IconFolder, IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { GlassButton, Pill, ProgressBar } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { jarod, onJarodEvent } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { type HfFitEntry, type HfProgress, type HfRepoView, type HfSearchRow, fitSummary, formatBytes, formatCount, hfErrorText, isHfCancelled, percent } from './local-models-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Hugging Face: search GGUF models, read a repository, check whether a model fits in memory, download it into the models folder.
 * The window never touches the network: every request goes through the engine on a gesture here, nothing at mount. The engine confirms each download in a
 * native dialog (files, sizes, hashes, destination) before a byte is transferred.
 */

const CONTEXT_FOR_FIT = 8192

export function HuggingFaceBlock() {
  const dir = useBackendData(() => jarod<{ dir: string | null }>('hf-models-dir'))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HfSearchRow[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [repo, setRepo] = useState<HfRepoView | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (isUnsupported(dir.error)) {
    return null
  }

  const fail = (title: string, e: unknown) => {
    const message = errorText(e)

    if (!isHfCancelled(message)) {
      setError(`${title}: ${hfErrorText(message)}`)
    }
  }

  const search = async () => {
    setSearching(true)
    setError(null)
    setRepo(null)

    try {
      setResults(await jarod<HfSearchRow[]>('hf-search', { query: query.trim() }))
    } catch (e) {
      fail('Search failed', e)
    } finally {
      setSearching(false)
    }
  }

  const open = async (id: string) => {
    setError(null)

    try {
      setRepo(await jarod<HfRepoView>('hf-repo', { repo: id }))
    } catch (e) {
      fail('Could not read that repository', e)
    }
  }

  const choose = async () => {
    try {
      const picked = await jarod<{ dir: string } | null>('hf-pick-models-dir')

      if (picked) {
        markSaved()
        dir.reload()
      }
    } catch (e) {
      notify({ title: 'Models folder', body: hfErrorText(errorText(e)), level: 'error' })
    }
  }

  return (
    <>
      <SettingsGroup title="Download from Hugging Face">
        <SettingsRow icon={<IconFolder />} label="Models folder" description={dir.data?.dir ?? 'Not chosen yet. Models are downloaded here, one folder per repository.'} keywords="hugging face models folder download directory">
          <GlassButton size="sm" variant={dir.data?.dir ? 'secondary' : 'primary'} onClick={() => void choose()}>
            {dir.data?.dir ? 'Change…' : 'Choose folder…'}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconSearch />} label="Search" description="Looks for GGUF models on huggingface.co. Nothing is sent until you press Search." keywords="hugging face search gguf models find">
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()

              if (query.trim()) {
                void search()
              }
            }}
          >
            <label className="glass-input flex h-8 w-[260px] items-center rounded-lg px-2.5">
              <span className="sr-only">Search Hugging Face</span>
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. qwen 8b instruct" maxLength={100} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </label>
            <GlassButton type="submit" size="sm" variant="primary" disabled={searching || !query.trim()}>
              {searching ? 'Searching…' : 'Search'}
            </GlassButton>
          </form>
        </SettingsRow>
        {results && results.length === 0 && <SettingsRow icon={<IconBrandHipchat />} label="No result" description="Try fewer or different words." keywords="hugging face no result" />}
        {results?.map(row => (
          <SettingsRow key={row.id} icon={<IconBrandHipchat />} label={row.id} description={`${formatCount(row.downloads)} downloads · ${formatCount(row.likes)} likes`} keywords={`hugging face ${row.id}`}>
            <GlassButton size="sm" variant={repo?.repo === row.id ? 'primary' : 'secondary'} onClick={() => void open(row.id)} aria-label={`Open ${row.id}`}>
              Open
            </GlassButton>
          </SettingsRow>
        ))}
      </SettingsGroup>
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      {repo && <RepoPanel key={`${repo.repo}@${repo.sha}`} repo={repo} hasFolder={Boolean(dir.data?.dir)} onError={fail} />}
    </>
  )
}

function RepoPanel({ repo, hasFolder, onError }: { repo: HfRepoView; hasFolder: boolean; onError: (title: string, e: unknown) => void }) {
  const downloadable = useMemo(() => repo.entries.filter(entry => entry.complete), [repo])
  const [picked, setPicked] = useState<string[]>([])
  const [fits, setFits] = useState<Record<string, HfFitEntry>>({})
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<HfProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => onJarodEvent('hf-progress', (...args) => setProgress((args[0] as HfProgress | undefined) ?? null)), [])

  const checkFit = async () => {
    setChecking(true)

    try {
      const out = await jarod<{ results: HfFitEntry[]; rateLimited: { retryAfterSeconds: number | null } | null; budgetExhausted: boolean }>('hf-fit', { repo: repo.repo, sha: repo.sha, keys: downloadable.map(entry => entry.key), contextTokens: CONTEXT_FOR_FIT, cacheType: 'f16' })

      setFits(Object.fromEntries(out.results.map(result => [result.key, result])))

      if (out.rateLimited) {
        notify({ title: 'Hugging Face is limiting requests', body: 'Some models were not checked. Try again later.', level: 'warn' })
      } else if (out.budgetExhausted) {
        notify({ title: 'Check stopped', body: 'The read budget for one check was used up. Check fewer models at a time.', level: 'info' })
      }
    } catch (e) {
      onError('Could not check the models', e)
    } finally {
      setChecking(false)
    }
  }

  const download = async () => {
    setDownloading(true)
    setDone(null)
    setProgress(null)

    try {
      const out = await jarod<{ destDir: string; files: { name: string; verified: boolean }[] }>('hf-download', { repo: repo.repo, sha: repo.sha, keys: picked })

      markSaved()
      setDone(`Downloaded ${out.files.length} file${out.files.length === 1 ? '' : 's'} into ${out.destDir}. Add the .gguf as a preset above to run it.`)
    } catch (e) {
      onError('Download failed', e)
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }

  const toggle = (key: string) => setPicked(current => (current.includes(key) ? current.filter(k => k !== key) : [...current, key]))

  return (
    <SettingsGroup title={repo.repo}>
      <SettingsRow
        icon={<IconDownload />}
        label={repo.license ? `Licence: ${repo.license}` : 'Licence not stated'}
        description={`Revision ${repo.sha.slice(0, 7)}${repo.gated !== false ? ` · gated: ${repo.gated}` : ''}${repo.truncated ? ' · the list was cut short' : ''}`}
        keywords={`${repo.repo} licence license revision`}
      >
        <GlassButton size="sm" variant="secondary" disabled={checking || downloadable.length === 0} onClick={() => void checkFit()}>
          {checking ? 'Checking…' : 'Will they fit?'}
        </GlassButton>
      </SettingsRow>
      {repo.entries.length === 0 && <SettingsRow icon={<IconDownload />} label="No GGUF file in this repository" description="Look for a repository whose name ends in -GGUF." keywords={`${repo.repo} empty`} />}
      {repo.entries.map(entry => {
        const fit = fits[entry.key]

        return (
          <SettingsRow
            key={entry.key}
            icon={<IconDownload />}
            label={entry.key}
            description={[formatBytes(entry.totalBytes), entry.shardCount > 1 ? `${entry.shardCount} parts` : null, entry.projector ? 'vision projector' : null, entry.complete ? null : `incomplete: missing ${entry.missing.join(', ')}`, fit?.state === 'checked' ? fitSummary(fit.report) : fit ? (fit.reason ?? 'not checked') : entry.analyzed ? 'already checked' : null].filter(Boolean).join(' · ')}
            keywords={`${repo.repo} ${entry.key}`}
          >
            {fit?.state === 'checked' && fit.report && <Pill tone={fit.report.fit.status === 'fits' ? 'ok' : fit.report.fit.status === 'does-not-fit' ? 'warn' : 'muted'}>{fit.report.fit.status === 'fits' ? 'Fits' : fit.report.fit.status === 'does-not-fit' ? 'Too big' : 'Estimated'}</Pill>}
            <label className={cn('flex items-center gap-1.5 text-[12px]', entry.complete ? 'text-fg-2' : 'text-fg-4')}>
              <input type="checkbox" disabled={!entry.complete || downloading} checked={picked.includes(entry.key)} onChange={() => toggle(entry.key)} aria-label={`Select ${entry.key}`} />
              Select
            </label>
          </SettingsRow>
        )
      })}
      <SettingsRow
        icon={<IconDownload />}
        label={picked.length === 0 ? 'Select what to download' : `${picked.length} selected`}
        description={!hasFolder ? 'Choose a models folder first.' : 'You will see every file, its size and hash, and the destination, and confirm before anything is downloaded.'}
        keywords={`${repo.repo} download`}
        below={
          <>
            {downloading && progress && (
              <div className="flex flex-col gap-1">
                <ProgressBar value={percent(progress.received, progress.total)} />
                <div className="text-[11.5px] text-fg-4">
                  {progress.stage} · file {progress.index + 1} of {progress.count} · {formatBytes(progress.received)} of {formatBytes(progress.total)}
                </div>
              </div>
            )}
            {done && <InlineNote tone="info">{done}</InlineNote>}
          </>
        }
      >
        {downloading ? (
          <GlassButton size="sm" variant="secondary" onClick={() => void jarod('hf-download-cancel')}>
            Cancel
          </GlassButton>
        ) : (
          <GlassButton size="sm" variant="primary" disabled={picked.length === 0 || !hasFolder} onClick={() => void download()}>
            Download…
          </GlassButton>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
