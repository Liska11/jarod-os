import { IconChartDots3, IconFileAnalytics, IconFileText, IconMovie, IconPhoto } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { dateLocale, type MessageKey, t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Settings > Artifacts (cockpit, lot 5): what the agent produced (diagrams, videos, analyses, reports), with the state of each file now.
 * The preview of an HTML or SVG file runs in a frame WITHOUT scripts (sandbox=""), from text the engine read; the window never names a
 * path. Opening uses the file's associated application; programs and scripts are refused by the engine.
 */

export interface ArtifactRow {
  id: string
  kind: 'diagram' | 'video' | 'analysis' | 'report' | 'image' | 'file'
  title: string
  path: string
  sourcePath: string | null
  mime: string
  bytes: number
  origin: string
  createdAt: number
  state: 'intact' | 'modified' | 'missing' | 'unknown'
}

type Preview = { kind: 'html' | 'svg' | 'text'; text: string } | { kind: 'image'; dataUrl: string } | { kind: 'none'; reason: string }

const ICON = { diagram: IconChartDots3, video: IconMovie, analysis: IconFileAnalytics, report: IconFileText, image: IconPhoto, file: IconFileText }

export const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`)

/** The preview as a frame document: an SVG is wrapped in a page; text is escaped. Always rendered with sandbox="" (no script). */
export function previewDocument(p: Preview): string | null {
  if (p.kind === 'html') {
    return p.text
  }

  if (p.kind === 'svg') {
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;background:#fff">${p.text}</body>`
  }

  if (p.kind === 'text') {
    const escaped = p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    return `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:12px monospace;margin:12px">${escaped}</pre>`
  }

  return null
}

export function ArtifactsSection() {
  useT()
  const list = useBackendData(() => jarod<ArtifactRow[]>('artifacts-list'))
  const [preview, setPreview] = useState<{ id: string; p: Preview } | null>(null)
  const [busy, setBusy] = useState(false)

  if (isUnsupported(list.error)) {
    return (
      <>
        <SectionTitle title={t('settings.artifacts.title')} subtitle={t('settings.artifacts.subtitle')} />
        <InlineNote tone="info">{t('settings.artifacts.needsJarod')}</InlineNote>
      </>
    )
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await fn()
    } catch (error) {
      reportEngineError(t('settings.artifacts.title'), error)
    } finally {
      setBusy(false)
    }
  }

  const show = (id: string) => act(async () => setPreview({ id, p: await jarod<Preview>('artifact-preview', id) }))

  const open = (id: string) =>
    act(async () => {
      const r = await jarod<{ success: boolean; error?: string }>('artifact-open', id)

      if (!r.success) {
        throw new Error(r.error ?? t('settings.artifacts.openFailed'))
      }
    })

  const forget = (id: string) =>
    act(async () => {
      await jarod('artifact-forget', id)
      setPreview(current => (current?.id === id ? null : current))
      list.reload()
    })

  const rows = list.data ?? []

  return (
    <>
      <SectionTitle title={t('settings.artifacts.title')} subtitle={t('settings.artifacts.subtitle')} />

      <SettingsGroup title={t('settings.artifacts.recent')}>
        {rows.length === 0 && <SettingsRow icon={<IconFileText />} label={t('settings.artifacts.none')} description={t('settings.artifacts.none.hint')} keywords="artifacts empty" />}
        {rows.map(row => {
          const Icon = ICON[row.kind]
          const doc = preview?.id === row.id ? preview.p : null

          return (
            <SettingsRow
              key={row.id}
              icon={<Icon />}
              label={row.title}
              description={`${t(`settings.artifacts.kind.${row.kind}` as MessageKey)} · ${sizeText(row.bytes)} · ${new Date(row.createdAt).toLocaleString(dateLocale())} · ${row.path}${row.sourcePath ? ` — ${t('settings.artifacts.source', { path: row.sourcePath })}` : ''}`}
              keywords={`artifact ${row.kind} ${row.title}`}
              below={
                doc &&
                (doc.kind === 'image' ? (
                  <img alt={row.title} src={doc.dataUrl} className="max-h-[420px] max-w-full rounded-md border border-white/10" />
                ) : doc.kind === 'none' ? (
                  <InlineNote tone="warn">{doc.reason}</InlineNote>
                ) : (
                  <iframe title={row.title} sandbox="" srcDoc={previewDocument(doc) ?? ''} className="h-[420px] w-full rounded-md border border-white/10 bg-white" />
                ))
              }
            >
              <Pill tone={row.state === 'intact' ? 'ok' : row.state === 'missing' ? 'danger' : 'warn'}>{t(`settings.artifacts.state.${row.state}` as MessageKey)}</Pill>
              <GlassButton size="sm" variant="secondary" disabled={busy || row.state !== 'intact'} onClick={() => void (doc ? setPreview(null) : show(row.id))}>
                {doc ? t('settings.artifacts.hide') : t('settings.artifacts.preview')}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" disabled={busy || row.state === 'missing'} onClick={() => void open(row.id)}>
                {t('settings.artifacts.open')}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void forget(row.id)} aria-label={t('settings.artifacts.forget.aria', { title: row.title })}>
                {t('settings.artifacts.forget')}
              </GlassButton>
            </SettingsRow>
          )
        })}
      </SettingsGroup>
    </>
  )
}
