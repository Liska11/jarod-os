import { IconDownload, IconExternalLink, IconFilePlus, IconMusic, IconPlayerSkipBack, IconPlayerSkipForward, IconRepeat, IconRepeatOff, IconSubtask, IconTrash, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyGlass, GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { useT } from '../../lib/i18n.ts'
import { useNativeApp } from '../sites/native-app.ts'
import { addToPlaylist, fileName, isAudio, isMedia, isSubtitle, nextIndex, previousIndex, toVtt } from './player-model.ts'

/*
 * The Player page: videos and music from this computer, in a playlist. Files stream through jarod-media: (only the
 * ones picked or dropped here). What Chromium cannot decode goes on in VLC, installed with one click if missing.
 */

const STORE_KEY = 'jarod.player.playlist'
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

function loadPlaylist(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')

    return Array.isArray(saved) ? saved.filter((file): file is string => typeof file === 'string' && isMedia(file)) : []
  } catch {
    return []
  }
}

function savePlaylist(files: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(files))
  } catch {
    // The playlist is a convenience: without storage it starts empty next time.
  }
}

/** A subtitles file as a WebVTT track (SubRip is converted); null when it cannot be read. */
async function readSubtitles(file: string): Promise<{ label: string; url: string } | null> {
  const [granted] = await window.heraldOS.media.allow([file]).catch(() => [])
  const text = granted ? await fetch(granted.url).then(response => (response.ok ? response.text() : '')).catch(() => '') : ''

  return text ? { label: fileName(file), url: URL.createObjectURL(new Blob([toVtt(text, file)], { type: 'text/vtt' })) } : null
}

export function PlayerPage() {
  const { t } = useT()
  const [playlist, setPlaylist] = useState<string[]>(loadPlaylist)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [index, setIndex] = useState(0)
  const [repeat, setRepeat] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [subtitles, setSubtitles] = useState<{ label: string; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const vlc = useNativeApp('vlc', 'VLC')
  const current = playlist[index] ?? null

  const allow = useCallback(async (files: string[]) => {
    if (files.length === 0) {
      return
    }

    const granted = await window.heraldOS.media.allow(files).catch(() => [])
    setUrls(previous => ({ ...previous, ...Object.fromEntries(granted.map(entry => [entry.file, entry.url])) }))
  }, [])

  // The saved playlist streams again once main allows its files (the ones gone from the disk drop out).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the playlist saved last time
  useEffect(() => {
    void allow(playlist)
  }, [])

  useEffect(() => savePlaylist(playlist), [playlist])

  const add = useCallback(
    async (files: string[]) => {
      const subtitle = files.find(isSubtitle)
      const media = files.filter(isMedia)

      if (media.length > 0) {
        await allow(media)
        setPlaylist(previous => {
          const next = addToPlaylist(previous, media)

          if (previous.length === 0) {
            setIndex(0)
          }

          return next
        })
      }

      if (subtitle) {
        const next = await readSubtitles(subtitle)

        if (next) {
          setSubtitles(next)
        }
      }
    },
    [allow]
  )

  const loadSubtitles = async (file: string) => {
    const next = await readSubtitles(file)

    if (next) {
      setSubtitles(previous => {
        if (previous) {
          URL.revokeObjectURL(previous.url)
        }

        return next
      })
    }
  }

  const pick = async () => {
    const files = await window.heraldOS.fs.pickFiles({ multiple: true }).catch(() => [])
    await add(files)
  }

  const pickSubtitles = async () => {
    const [file] = await window.heraldOS.fs.pickFiles({ multiple: false }).catch(() => [])

    if (file && isSubtitle(file)) {
      await loadSubtitles(file)
    }
  }

  const play = (next: number | null) => {
    if (next !== null && next !== index) {
      setIndex(next)
    }
  }

  // A new track: start it, at the chosen speed, with no stale error.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a speed change alone is the next effect's job
  useEffect(() => {
    setFailed(false)
    const element = video.current

    if (element && current && urls[current]) {
      element.playbackRate = speed
      void element.play().catch(() => undefined)
    }
  }, [current, urls[current ?? '']])

  useEffect(() => {
    if (video.current) {
      video.current.playbackRate = speed
    }
  }, [speed])

  const remove = (file: string) => {
    const at = playlist.indexOf(file)
    setPlaylist(playlist.filter(item => item !== file))

    if (at < index || (at === index && index === playlist.length - 1)) {
      setIndex(Math.max(0, index - 1))
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const element = video.current

    if (!element || (event.target as HTMLElement).closest('input, select, button')) {
      return
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      element.currentTime = Math.max(0, element.currentTime + (event.key === 'ArrowRight' ? 5 : -5))
      event.preventDefault()
    } else if (event.key === ' ') {
      void (element.paused ? element.play() : Promise.resolve(element.pause()))
      event.preventDefault()
    } else if (event.key.toLowerCase() === 'f') {
      void (document.fullscreenElement ? document.exitFullscreen() : element.requestFullscreen())
    } else if (event.key.toLowerCase() === 'n') {
      play(nextIndex(index, playlist.length, repeat))
    } else if (event.key.toLowerCase() === 'p') {
      play(previousIndex(index, playlist.length))
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: page-wide player shortcuts and file drop
    <div
      className="flex h-full flex-col outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragOver={event => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        void add([...event.dataTransfer.files].map(file => window.heraldOS.fs.pathForFile(file)).filter(Boolean))
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <GlassButton size="sm" variant="primary" onClick={() => void pick()}>
          <IconFilePlus />
          {t('player.add')}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('player.previous')} disabled={playlist.length === 0} onClick={() => play(previousIndex(index, playlist.length))}>
          <IconPlayerSkipBack />
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('player.next')} disabled={nextIndex(index, playlist.length, repeat) === null} onClick={() => play(nextIndex(index, playlist.length, repeat))}>
          <IconPlayerSkipForward />
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('player.repeat')} aria-pressed={repeat} onClick={() => setRepeat(value => !value)} className={repeat ? 'text-accent-strong' : undefined}>
          {repeat ? <IconRepeat /> : <IconRepeatOff />}
        </GlassButton>
        <select value={speed} onChange={event => setSpeed(Number(event.target.value))} aria-label={t('player.speed')} className="glass-input h-8 rounded-lg px-2 text-[12px] outline-none">
          {SPEEDS.map(value => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
        <GlassButton size="sm" variant="ghost" disabled={!current || isAudio(current)} onClick={() => void pickSubtitles()}>
          <IconSubtask />
          {subtitles ? subtitles.label : t('player.subtitles')}
        </GlassButton>
        {subtitles && (
          <GlassButton size="icon" variant="ghost" aria-label={t('player.subtitlesOff')} onClick={() => setSubtitles(null)}>
            <IconX />
          </GlassButton>
        )}
        <span className="flex-1" />
        {vlc.installed && (
          <GlassButton size="sm" variant="ghost" disabled={!current} onClick={() => current && vlc.launch(current)}>
            <IconExternalLink />
            {t('player.openInVlc')}
          </GlassButton>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 items-center justify-center bg-black/40">
          {current && urls[current] ? (
            <>
              {/* biome-ignore lint/a11y/useMediaCaption: subtitles are the person's own file, added with the Subtitles button */}
              <video
                key={current}
                ref={video}
                src={urls[current]}
                controls
                className={cn('max-h-full max-w-full', isAudio(current) && 'h-14 w-[min(560px,90%)]')}
                onEnded={() => play(nextIndex(index, playlist.length, repeat))}
                onError={() => setFailed(true)}
              >
                {subtitles && !isAudio(current) && <track kind="subtitles" src={subtitles.url} label={subtitles.label} default />}
              </video>
              {isAudio(current) && (
                <div className="pointer-events-none absolute top-[22%] flex flex-col items-center gap-2 text-fg-2">
                  <IconMusic className="size-12 text-fg-3" />
                  <span className="max-w-md truncate text-[13px]">{fileName(current)}</span>
                </div>
              )}
              {failed && (
                <div className="absolute inset-x-6 bottom-20 flex flex-col items-center gap-2 rounded-xl bg-black/70 p-4 text-center text-[12.5px] text-fg-2">
                  <span>{t('player.unsupported', { name: fileName(current) })}</span>
                  {vlc.installed ? (
                    <GlassButton size="sm" variant="primary" onClick={() => vlc.launch(current)}>
                      <IconExternalLink />
                      {t('player.openInVlc')}
                    </GlassButton>
                  ) : vlc.installed === false ? (
                    <GlassButton size="sm" variant="primary" disabled={vlc.installing} onClick={() => void vlc.install()}>
                      {vlc.installing ? <Spinner /> : <IconDownload />}
                      {vlc.installing ? t('sites.native.installing', { name: 'VLC' }) : t('sites.native.install', { name: 'VLC' })}
                    </GlassButton>
                  ) : null}
                  {vlc.error && <span className="text-warn">{vlc.error}</span>}
                </div>
              )}
            </>
          ) : (
            <EmptyGlass className={cn('m-6 w-full max-w-lg', dragging && 'border-accent-strong')} icon={<IconMusic />} title={t('player.empty')} description={t('player.empty.hint')} />
          )}
        </div>

        {playlist.length > 0 && (
          <aside className="flex w-64 shrink-0 flex-col border-l border-line">
            <div className="flex items-center justify-between px-3 py-2 text-[10px] font-semibold tracking-[0.14em] text-fg-3 uppercase">
              <span>{t('player.playlist', { count: playlist.length })}</span>
              <button type="button" aria-label={t('player.clear')} onClick={() => setPlaylist([])} className="flex size-5 items-center justify-center rounded hover:bg-white/10 hover:text-fg">
                <IconTrash size={13} />
              </button>
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {playlist.map((file, at) => (
                <li key={file} className="group flex items-center">
                  <button
                    type="button"
                    onClick={() => setIndex(at)}
                    title={file}
                    aria-current={at === index ? 'true' : undefined}
                    className={cn('flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[12px]', at === index ? 'bg-white/14 text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg', !urls[file] && 'opacity-50')}
                  >
                    <span className="w-5 shrink-0 text-right text-[10.5px] text-fg-4">{at + 1}</span>
                    <span className="truncate">{fileName(file)}</span>
                  </button>
                  <button type="button" aria-label={t('player.remove', { name: fileName(file) })} onClick={() => remove(file)} className="invisible flex size-6 items-center justify-center rounded text-fg-3 group-hover:visible hover:bg-white/10 hover:text-fg">
                    <IconX size={12} />
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  )
}
