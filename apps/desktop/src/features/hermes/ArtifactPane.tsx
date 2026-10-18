import { useStore } from '@nanostores/react'
import {
  IconAlignLeft,
  IconBold,
  IconExternalLink,
  IconFileText,
  IconFileTypePdf,
  IconFolder,
  IconInfoCircle,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconMarkdown,
  IconPencil,
  IconPencilOff,
  IconSearch,
  IconUnderline,
  IconUpload,
  IconWorld
} from '@tabler/icons-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FilePreview } from '../../../shared/ipc.ts'
import { Dropdown, EmptyGlass, GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import type { ChatState } from '../../lib/chat-model.ts'
import { formatBytes } from '../../lib/format.ts'
import { useLocalData } from '../../lib/use-async.ts'
import type { Artifact } from '../../store/missions.ts'
import { notify } from '../../store/notifications.ts'
import { Markdown } from '../chat/Markdown.tsx'
import { $editing, $paneTab, $selectedArtifact, $zoom, artifactKind, collectSources, extensionOf, isEditable, type SourceRow } from './artifact-store.ts'
import { MenuDivider, MenuItem, PopMenu } from './Menu.tsx'
import { isPaneApp } from './pane-apps.ts'
import { PaneAppViews, PaneTabs } from './PaneApps.tsx'
import { revealLabel } from '../../lib/platform-labels.ts'
import { attempt } from '../../lib/native.ts'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'

const ZOOMS = [50, 75, 100, 125, 150]

/* Light document colours: the transcript markdown styles read these tokens, so scoping them to the sheet re-skins it. */
const DOCUMENT_VARS = {
  '--color-fg': '#0b1230',
  '--color-fg-2': 'rgba(11, 18, 48, 0.82)',
  '--color-fg-3': 'rgba(11, 18, 48, 0.6)',
  '--color-line': 'rgba(11, 18, 48, 0.12)',
  '--color-line-strong': 'rgba(11, 18, 48, 0.28)',
  '--color-accent-strong': '#2f7dff'
} as React.CSSProperties

const PDF_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif; color: #0b1230; font-size: 13px; line-height: 1.6; max-width: 720px; margin: 48px auto; padding: 0 32px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; } h3 { font-size: 14px; margin: 20px 0 6px; }
  p { margin: 0 0 10px; } ul, ol { padding-left: 22px; margin: 0 0 10px; } li + li { margin-top: 3px; } li::marker { color: #2f7dff; }
  code { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; background: #f1f4fb; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f1f4fb; padding: 12px 14px; border-radius: 8px; overflow-x: auto; } pre code { background: none; padding: 0; }
  table { border-collapse: collapse; } th, td { border: 1px solid #d8deee; padding: 5px 10px; text-align: left; }
  a { color: #2f7dff; } hr { border: 0; border-top: 1px solid #d8deee; margin: 20px 0; } blockquote { border-left: 3px solid #d8deee; margin: 0; padding-left: 12px; color: #4b5578; }
`

export function ArtifactPane({ chat }: { chat: ChatState | null }) {
  const { t } = useT()
  const artifact = useStore($selectedArtifact)
  const tab = useStore($paneTab)
  const editing = useStore($editing)
  const zoom = useStore($zoom)
  const [exportOpen, setExportOpen] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const file = useLocalData<FilePreview | null>(() => (artifact ? window.heraldOS.fs.readFile(artifact.path) : Promise.resolve(null)), [artifact?.path, artifact?.ts])
  const editable = Boolean(artifact && isEditable(artifact.name) && file.data?.kind === 'text')
  const kind = artifact ? artifactKind(artifact.name) : 'other'
  const showToolbar = tab === 'preview' && editable
  // An app opened from the sidebar (browser, a messaging app, the player) has the pane to itself.
  const appTab = isPaneApp(tab)

  // Leaving an artifact or reloading it discards an unsaved draft.
  useEffect(() => {
    $editing.set(false)
  }, [artifact?.path])

  const beginEdit = useCallback(() => {
    if (!editable) {
      return
    }

    setDraft(file.data?.content ?? '')
    $editing.set(true)
    requestAnimationFrame(() => editor.current?.focus())
  }, [editable, file.data])

  const save = async () => {
    if (!artifact) {
      return
    }

    setSaving(true)

    try {
      await window.heraldOS.fs.writeText(artifact.path, draft)
      notify({ title: t('pane.saved'), body: artifact.name, level: 'success', surface: 'hermes' })
      $editing.set(false)
      file.reload()
    } catch (error) {
      notify({ title: t('pane.saveFailed'), body: error instanceof Error ? error.message : String(error), level: 'error', surface: 'hermes' })
    } finally {
      setSaving(false)
    }
  }

  const exportPdf = async () => {
    if (!artifact) {
      return
    }

    const text = editing ? draft : file.data?.kind === 'text' ? (file.data.content ?? '') : ''

    if (!text && kind !== 'markdown' && kind !== 'text') {
      notify({ title: t('pane.exportPdf'), body: t('pane.exportPdf.onlyText'), level: 'warn', surface: 'hermes' })

      return
    }

    const body = kind === 'markdown' || extensionOf(artifact.name) === 'txt' ? renderToStaticMarkup(<Markdown text={text} className="prose-document" />) : `<pre>${escapeHtml(text)}</pre>`
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(artifact.name)}</title><style>${PDF_STYLE}</style></head><body>${body}</body></html>`
    const saved = await window.heraldOS.fs.exportPdf(html, artifact.name.replace(/\.[a-z0-9]{1,6}$/i, ''))

    if (saved) {
      notify({ title: t('pane.exported'), body: saved, level: 'success', surface: 'hermes' })
    }
  }

  /** Formatting buttons write Markdown around the selection, switching to edit mode when needed. */
  const applyFormat = (wrap: (selection: string) => { text: string; cursor?: number }) => {
    if (!editable) {
      return
    }

    if (!editing) {
      beginEdit()
    }

    requestAnimationFrame(() => {
      const el = editor.current

      if (!el) {
        return
      }

      const start = el.selectionStart
      const end = el.selectionEnd
      const current = el.value
      const selection = current.slice(start, end)
      const { text, cursor } = wrap(selection)
      const next = current.slice(0, start) + text + current.slice(end)
      setDraft(next)
      requestAnimationFrame(() => {
        el.focus()
        const at = start + (cursor ?? text.length)
        el.setSelectionRange(at, at)
      })
    })
  }

  const inline = (marker: string, close = marker) => applyFormat(sel => ({ text: `${marker}${sel || t('pane.insertText')}${close}`, cursor: sel ? undefined : marker.length + 4 }))
  const prefixLines = (prefix: (index: number) => string) =>
    applyFormat(sel => ({
      text: (sel || t('pane.insertItem'))
        .split('\n')
        .map((line, index) => `${prefix(index)}${line}`)
        .join('\n')
    }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneTabs value={tab} />
      <div className={cn('flex items-center gap-3 border-b border-line px-4 py-2', appTab && 'hidden')}>
        {artifact && <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{artifact.name}</span>}
        {!artifact && <span className="flex-1" />}
        <span className="hidden items-center gap-1.5 text-[12px] text-fg-3 xl:flex" title={t('pane.review.title')}>
          <span className="size-1.5 rounded-full bg-accent-strong" />
          {t('pane.review')}
          <IconInfoCircle size={13} />
        </span>
        {editing ? (
          <>
            <GlassButton size="sm" variant="ghost" onClick={() => $editing.set(false)} disabled={saving}>
              {t('pane.cancel')}
            </GlassButton>
            <GlassButton size="sm" variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('pane.saving') : t('pane.save')}
            </GlassButton>
          </>
        ) : (
          <GlassButton size="sm" onClick={beginEdit} disabled={!editable} title={editable ? undefined : t('pane.editOnlyText')}>
            {editable ? <IconPencil /> : <IconPencilOff />}
            {t('pane.edit')}
          </GlassButton>
        )}
        <PopMenu
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          trigger={
            <GlassButton size="sm" disabled={!artifact} onClick={() => setExportOpen(v => !v)} aria-haspopup="menu" aria-expanded={exportOpen}>
              <IconUpload />
              {t('pane.export')}
            </GlassButton>
          }
        >
          <MenuItem
            icon={<IconMarkdown />}
            disabled={kind !== 'markdown' && kind !== 'text'}
            onClick={() => {
              setExportOpen(false)

              if (artifact) {
                void attempt('native.failed.showFile', () => window.heraldOS.fs.reveal(artifact.path))
              }
            }}
          >
            {t('pane.markdownFile')}
          </MenuItem>
          <MenuItem
            icon={<IconFileTypePdf />}
            disabled={kind !== 'markdown' && kind !== 'text'}
            onClick={() => {
              setExportOpen(false)
              void exportPdf()
            }}
          >
            {t('pane.pdf')}
          </MenuItem>
          <MenuDivider />
          <MenuItem
            icon={<IconExternalLink />}
            onClick={() => {
              setExportOpen(false)

              if (artifact) {
                void attempt('native.failed.openFile', () => window.heraldOS.fs.openPath(artifact.path))
              }
            }}
          >
            {t('pane.openDefault')}
          </MenuItem>
          <MenuItem
            icon={<IconFolder />}
            onClick={() => {
              setExportOpen(false)

              if (artifact) {
                void attempt('native.failed.showFile', () => window.heraldOS.fs.reveal(artifact.path))
              }
            }}
          >
            {revealLabel()}
          </MenuItem>
        </PopMenu>
      </div>

      {showToolbar && (
        <div className="flex items-center gap-1 border-b border-line px-3 py-2" role="toolbar" aria-label={t('pane.formatting')}>
          <Dropdown label={t('pane.paragraph')} />
          <ToolbarDivider />
          <ToolbarButton label={t('pane.bold')} onClick={() => inline('**')}>
            <IconBold size={15} />
          </ToolbarButton>
          <ToolbarButton label={t('pane.italic')} onClick={() => inline('*')}>
            <IconItalic size={15} />
          </ToolbarButton>
          <ToolbarButton label={t('pane.underline')} onClick={() => inline('<u>', '</u>')}>
            <IconUnderline size={15} />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label={t('pane.bulleted')} onClick={() => prefixLines(() => '- ')}>
            <IconList size={15} />
          </ToolbarButton>
          <ToolbarButton label={t('pane.numbered')} onClick={() => prefixLines(i => `${i + 1}. `)}>
            <IconListNumbers size={15} />
          </ToolbarButton>
          <ToolbarButton label={t('pane.alignLeft')} disabled title={t('pane.alignLeft.title')}>
            <IconAlignLeft size={15} />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label={t('pane.link')} onClick={() => applyFormat(sel => ({ text: `[${sel || t('pane.insertText')}](https://)`, cursor: (sel || t('pane.insertText')).length + 11 }))}>
            <IconLink size={15} />
          </ToolbarButton>
          <span className="flex-1" />
          <PopMenu open={zoomOpen} onClose={() => setZoomOpen(false)} width="w-28" trigger={<Dropdown label={`${zoom}%`} onClick={() => setZoomOpen(v => !v)} />}>
            {ZOOMS.map(z => (
              <MenuItem
                key={z}
                onClick={() => {
                  $zoom.set(z)
                  setZoomOpen(false)
                }}
                hint={z === zoom ? '•' : undefined}
              >
                {z}%
              </MenuItem>
            ))}
          </PopMenu>
        </div>
      )}

      <PaneAppViews tab={tab} />
      <div className={cn('min-h-0 flex-1 overflow-y-auto p-4', appTab && 'hidden')}>
        {tab === 'sources' ? (
          <Sources chat={chat} />
        ) : !artifact ? (
          <EmptyGlass className="h-full" icon={<IconFileText />} title={t('pane.empty')} description={t('pane.empty.hint')} />
        ) : editing ? (
          <textarea
            ref={editor}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            spellCheck
            aria-label={t('pane.editAria', { name: artifact.name })}
            className="selectable min-h-full w-full resize-none rounded-xl bg-white/95 px-10 py-9 text-[14px] leading-[1.6] text-[#0b1230] shadow-card outline-none placeholder:text-black/30"
            style={{ zoom: zoom / 100 }}
          />
        ) : (
          <Document artifact={artifact} file={file.data} loading={file.loading} error={file.error} zoom={zoom} />
        )}
      </div>
    </div>
  )
}

function ToolbarButton({ label, children, onClick, disabled, title }: { label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick} className="flex size-7 items-center justify-center rounded-lg text-fg-2 hover:bg-white/8 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
}

function Document({ artifact, file, loading, error, zoom }: { artifact: Artifact; file: FilePreview | null; loading: boolean; error: string | null; zoom: number }) {
  const kind = artifactKind(artifact.name)

  if (loading && !file) {
    return (
      <div className="rounded-xl bg-white/95 px-10 py-9 shadow-card" aria-label={t('pane.loadingDocument')}>
        <div className="shimmer h-7 w-1/2 rounded-md" />
        <div className="shimmer mt-3 h-3.5 w-1/4 rounded-sm" />
        <div className="shimmer mt-8 h-3.5 w-11/12 rounded-sm" />
        <div className="shimmer mt-2 h-3.5 w-4/5 rounded-sm" />
        <div className="shimmer mt-2 h-3.5 w-3/5 rounded-sm" />
      </div>
    )
  }

  if (error || !file) {
    const missing = !error || /ENOENT/.test(error)

    return <EmptyGlass className="h-full" icon={<IconFileText />} title={t('pane.cannotOpen')} description={missing ? t('pane.missing') : error} action={<GlassButton size="sm" onClick={() => void attempt('native.failed.showFile', () => window.heraldOS.fs.reveal(artifact.path))}>{revealLabel()}</GlassButton>} />
  }

  if (file.kind === 'image' && file.content) {
    return (
      <div className="flex justify-center rounded-xl bg-white/95 p-6 shadow-card" style={{ zoom: zoom / 100 }}>
        <img src={file.content} alt={artifact.name} className="max-h-[70vh] max-w-full rounded-lg object-contain" draggable={false} />
      </div>
    )
  }

  if (file.kind === 'text' && (kind === 'markdown' || extensionOf(artifact.name) === 'txt')) {
    return (
      <div className="rounded-xl bg-white/95 px-10 py-9 text-[#0b1230] shadow-card [&_code]:bg-black/6! [&_pre]:border-black/10! [&_pre]:bg-black/4!" style={{ ...DOCUMENT_VARS, zoom: zoom / 100 }}>
        <Markdown text={file.content ?? ''} className="prose-document" />
        {file.truncated && <div className="mt-6 text-[12px] text-black/50">{t('pane.truncated')}</div>}
      </div>
    )
  }

  if (file.kind === 'text') {
    return (
      <pre className="selectable overflow-x-auto rounded-xl bg-white/95 px-8 py-7 font-mono text-[12.5px] leading-relaxed text-[#0b1230] whitespace-pre-wrap shadow-card" style={{ zoom: zoom / 100 }}>
        {file.content}
        {file.truncated && '\n…'}
      </pre>
    )
  }

  return <BinaryPreview artifact={artifact} file={file} zoom={zoom} />
}

function BinaryPreview({ artifact, file, zoom }: { artifact: Artifact; file: FilePreview; zoom: number }) {
  const thumb = useLocalData(() => window.heraldOS.fs.thumbnail(artifact.path, 800), [artifact.path, artifact.ts])

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl bg-white/95 px-8 py-8 text-[#0b1230] shadow-card" style={{ zoom: zoom / 100 }}>
      {thumb.loading ? <div className="shimmer h-72 w-56 rounded-lg" /> : thumb.data ? <img src={thumb.data} alt={`${artifact.name} preview`} className="max-h-[60vh] max-w-full rounded-lg shadow-[0_8px_30px_rgba(0,10,60,.18)]" draggable={false} /> : <IconFileText size={64} stroke={1.2} className="text-black/30" />}
      <div className="text-center">
        <div className="text-[14px] font-semibold">{artifact.name}</div>
        <div className="text-[12px] text-black/55">
          {extensionOf(artifact.name).toUpperCase() || t('pane.file')} · {formatBytes(file.size)}
        </div>
      </div>
      <GlassButton size="sm" variant="primary" onClick={() => void attempt('native.failed.openFile', () => window.heraldOS.fs.openPath(artifact.path))}>
        <IconExternalLink />
        {t('pane.openDefault')}
      </GlassButton>
    </div>
  )
}

const ACTION_LABEL: Record<SourceRow['action'], MessageKey> = { read: 'pane.action.read', wrote: 'pane.action.wrote', searched: 'pane.action.searched', visited: 'pane.action.visited' }

function Sources({ chat }: { chat: ChatState | null }) {
  const rows = useMemo(() => (chat ? collectSources(chat.messages) : []), [chat?.messages])

  if (rows.length === 0) {
    return <EmptyGlass className="h-full" icon={<IconSearch />} title={t('pane.noSources')} description={t('pane.noSources.hint')} />
  }

  return (
    <div className="stagger flex flex-col gap-2">
      {rows.map(row => (
        <div key={row.id} className="glass-card flex items-center gap-3 rounded-xl px-3.5 py-2.5">
          <span className="icon-tile shrink-0" style={{ width: 34, height: 34, borderRadius: 9 }}>
            {row.kind === 'url' ? <IconWorld size={17} stroke={1.6} /> : <IconFileText size={17} stroke={1.6} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-fg">{row.label}</div>
            <div className="truncate text-[11.5px] text-fg-3">
              {t(ACTION_LABEL[row.action])} · <span className={cn(row.kind === 'file' && 'font-mono')}>{row.target}</span>
            </div>
          </div>
          {row.kind === 'file' && (
            <button type="button" aria-label={revealLabel()} title={revealLabel()} onClick={() => void attempt('native.failed.showFile', () => window.heraldOS.fs.reveal(row.target))} className="flex size-7 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg">
              <IconFolder size={15} />
            </button>
          )}
          <button
            type="button"
            aria-label={row.kind === 'url' ? t('pane.openBrowser') : t('pane.open')}
            title={row.kind === 'url' ? t('pane.openBrowser') : t('pane.open')}
            onClick={() => void (row.kind === 'url' ? window.heraldOS.shell.openExternal(row.target) : window.heraldOS.fs.openPath(row.target))}
            className="flex size-7 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg"
          >
            <IconExternalLink size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}
