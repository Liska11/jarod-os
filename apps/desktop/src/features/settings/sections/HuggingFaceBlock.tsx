import { IconBrandHipchat, IconDownload, IconFolder, IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { GlassButton, Pill, ProgressBar } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { useT } from '../../../lib/i18n.ts'
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
  const { t } = useT()
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
      fail(t('hf.searchFailed'), e)
    } finally {
      setSearching(false)
    }
  }

  const open = async (id: string) => {
    setError(null)

    try {
      setRepo(await jarod<HfRepoView>('hf-repo', { repo: id }))
    } catch (e) {
      fail(t('hf.repoFailed'), e)
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
      notify({ title: t('hf.folderTitle'), body: hfErrorText(errorText(e)), level: 'error' })
    }
  }

  return (
    <>
      <SettingsGroup title={t('hf.group')}>
        <SettingsRow icon={<IconFolder />} label={t('hf.folder')} description={dir.data?.dir ?? t('hf.folder.hint')} keywords="hugging face models folder download directory">
          <GlassButton size="sm" variant={dir.data?.dir ? 'secondary' : 'primary'} onClick={() => void choose()}>
            {dir.data?.dir ? t('hf.folder.change') : t('hf.folder.choose')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconSearch />} label={t('hf.search')} description={t('hf.search.hint')} keywords="hugging face search gguf models find">
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
              <span className="sr-only">{t('hf.searchAria')}</span>
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('hf.search.placeholder')} maxLength={100} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </label>
            <GlassButton type="submit" size="sm" variant="primary" disabled={searching || !query.trim()}>
              {searching ? t('hf.searching') : t('hf.search')}
            </GlassButton>
          </form>
        </SettingsRow>
        {results && results.length === 0 && <SettingsRow icon={<IconBrandHipchat />} label={t('hf.noResult')} description={t('hf.noResult.hint')} keywords="hugging face no result" />}
        {results?.map(row => (
          <SettingsRow key={row.id} icon={<IconBrandHipchat />} label={row.id} description={t('hf.stats', { downloads: formatCount(row.downloads), likes: formatCount(row.likes) })} keywords={`hugging face ${row.id}`}>
            <GlassButton size="sm" variant={repo?.repo === row.id ? 'primary' : 'secondary'} onClick={() => void open(row.id)} aria-label={t('hf.openAria', { name: row.id })}>
              {t('hf.open')}
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
  const { t, tn } = useT()
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
        notify({ title: t('hf.rateLimited'), body: t('hf.rateLimited.body'), level: 'warn' })
      } else if (out.budgetExhausted) {
        notify({ title: t('hf.budgetStop'), body: t('hf.budgetStop.body'), level: 'info' })
      }
    } catch (e) {
      onError(t('hf.checkFailed'), e)
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
      setDone(tn('hf.downloaded', out.files.length, { dir: out.destDir }))
    } catch (e) {
      onError(t('hf.downloadFailed'), e)
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
        label={repo.license ? t('hf.licence', { licence: repo.license }) : t('hf.licence.none')}
        description={`${t('hf.revision', { sha: repo.sha.slice(0, 7) })}${repo.gated !== false ? t('hf.gated', { gated: repo.gated }) : ''}${repo.truncated ? t('hf.truncated') : ''}`}
        keywords={`${repo.repo} licence license revision`}
      >
        <GlassButton size="sm" variant="secondary" disabled={checking || downloadable.length === 0} onClick={() => void checkFit()}>
          {checking ? t('hf.checking') : t('hf.willFit')}
        </GlassButton>
      </SettingsRow>
      {repo.entries.length === 0 && <SettingsRow icon={<IconDownload />} label={t('hf.noGguf')} description={t('hf.noGguf.hint')} keywords={`${repo.repo} empty`} />}
      {repo.entries.map(entry => {
        const fit = fits[entry.key]

        return (
          <SettingsRow
            key={entry.key}
            icon={<IconDownload />}
            label={entry.key}
            description={[
              formatBytes(entry.totalBytes),
              entry.shardCount > 1 ? t('hf.parts', { count: entry.shardCount }) : null,
              entry.projector ? t('hf.projector') : null,
              entry.complete ? null : t('hf.incomplete', { files: entry.missing.join(', ') }),
              fit?.state === 'checked' ? fitSummary(fit.report) : fit ? (fit.reason ?? t('hf.notChecked')) : entry.analyzed ? t('hf.alreadyChecked') : null
            ]
              .filter(Boolean)
              .join(' · ')}
            keywords={`${repo.repo} ${entry.key}`}
          >
            {fit?.state === 'checked' && fit.report && <Pill tone={fit.report.fit.status === 'fits' ? 'ok' : fit.report.fit.status === 'does-not-fit' ? 'warn' : 'muted'}>
              {fit.report.fit.status === 'fits' ? t('hf.fit.fits') : fit.report.fit.status === 'does-not-fit' ? t('hf.fit.tooBig') : t('hf.fit.estimated')}
            </Pill>}
            <label className={cn('flex items-center gap-1.5 text-[12px]', entry.complete ? 'text-fg-2' : 'text-fg-4')}>
              <input type="checkbox" disabled={!entry.complete || downloading} checked={picked.includes(entry.key)} onChange={() => toggle(entry.key)} aria-label={t('hf.selectAria', { name: entry.key })} />
              {t('hf.select')}
            </label>
          </SettingsRow>
        )
      })}
      <SettingsRow
        icon={<IconDownload />}
        label={picked.length === 0 ? t('hf.selectWhat') : t('hf.selected', { count: picked.length })}
        description={!hasFolder ? t('hf.needFolder') : t('hf.download.hint')}
        keywords={`${repo.repo} download`}
        below={
          <>
            {downloading && progress && (
              <div className="flex flex-col gap-1">
                <ProgressBar value={percent(progress.received, progress.total)} />
                <div className="text-[11.5px] text-fg-4">
                  {t('hf.progress', {
                    stage: progress.stage,
                    index: progress.index + 1,
                    count: progress.count,
                    received: formatBytes(progress.received),
                    total: formatBytes(progress.total)
                  })}
                </div>
              </div>
            )}
            {done && <InlineNote tone="info">{done}</InlineNote>}
          </>
        }
      >
        {downloading ? (
          <GlassButton size="sm" variant="secondary" onClick={() => void jarod('hf-download-cancel')}>
            {t('hf.cancel')}
          </GlassButton>
        ) : (
          <GlassButton size="sm" variant="primary" disabled={picked.length === 0 || !hasFolder} onClick={() => void download()}>
            {t('hf.download')}
          </GlassButton>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
