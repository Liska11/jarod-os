import { IconExternalLink, IconFile, IconFolder, IconPhoto } from '@tabler/icons-react'
import { t, useT } from '../../lib/i18n.ts'
import { EmptyGlass, GlassButton } from '../../components/ui/glass.tsx'
import { formatRelative } from '../../lib/format.ts'
import { useLocalData } from '../../lib/use-async.ts'
import type { Artifact } from '../../store/missions.ts'
import { Markdown } from '../chat/Markdown.tsx'
import { previewKind } from './mission-helpers.ts'
import { attempt } from '../../lib/native.ts'

const TEXT_LINES = 40

type PreviewData = { type: 'image'; src: string } | { type: 'text'; text: string; truncated: boolean } | { type: 'file' }

async function loadPreview(artifact: Artifact): Promise<PreviewData> {
  if (artifact.kind !== 'file') {
    return { type: 'file' }
  }

  const kind = previewKind(artifact.path)

  if (kind === 'image') {
    const thumb = await window.jarodOS.fs.thumbnail(artifact.path, 640)

    if (thumb) {
      return { type: 'image', src: thumb }
    }

    const file = await window.jarodOS.fs.readFile(artifact.path)

    return file.kind === 'image' && file.content ? { type: 'image', src: file.content } : { type: 'file' }
  }

  if (kind === 'text') {
    const file = await window.jarodOS.fs.readFile(artifact.path)

    if (file.kind === 'text' && typeof file.content === 'string') {
      const lines = file.content.split('\n')

      return { type: 'text', text: lines.slice(0, TEXT_LINES).join('\n'), truncated: lines.length > TEXT_LINES || Boolean(file.truncated) }
    }

    if (file.kind === 'image' && file.content) {
      return { type: 'image', src: file.content }
    }
  }

  return { type: 'file' }
}

export function MissionPreview({ artifact }: { artifact: Artifact | undefined }) {
  useT()
  const preview = useLocalData(() => (artifact ? loadPreview(artifact) : Promise.resolve<PreviewData>({ type: 'file' })), [artifact?.path, artifact?.ts])

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-fg">{t('missionPreview.title')}</h2>
        {artifact && <span className="text-[11.5px] text-fg-4">{t('missionPreview.updated', { time: formatRelative(artifact.ts) })}</span>}
      </div>
      {!artifact ? (
        <EmptyGlass icon={<IconPhoto />} title={t('missionPreview.empty')} description={t('missionPreview.empty.hint')} className="min-h-32" />
      ) : (
        <>
          <PreviewCard artifact={artifact} data={preview.data} loading={preview.loading} error={preview.error} />
          <div className="flex justify-center">
            <GlassButton size="sm" onClick={() => void attempt('native.failed.openFile', () => window.jarodOS.fs.openPath(artifact.path))} aria-label={t('missionPreview.openAria', { name: artifact.name })}>
              <IconExternalLink />
              {t('missionPreview.open')}
            </GlassButton>
          </div>
        </>
      )}
    </section>
  )
}

function PreviewCard({ artifact, data, loading, error }: { artifact: Artifact; data: PreviewData | null; loading: boolean; error: string | null }) {
  if (loading && !data) {
    return <div className="shimmer h-40 rounded-xl border border-line bg-black/15" aria-label={t('missionPreview.loading')} />
  }

  if (data?.type === 'image') {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-black/20">
        <img src={data.src} alt={artifact.name} className="block max-h-64 w-full object-contain" />
      </div>
    )
  }

  if (data?.type === 'text') {
    return (
      <div className="max-h-64 overflow-hidden rounded-xl border border-line bg-paper/95 px-4 py-3 text-ink [&_*]:text-ink [&_a]:text-accent-strong [&_code]:bg-ink/6 [&_pre]:border-ink/10 [&_pre]:bg-ink/5 [&_th]:shadow-[0_0_0_1px_rgba(0,0,0,.12)] [&_td]:shadow-[0_0_0_1px_rgba(0,0,0,.12)]">
        <Markdown text={data.text} className="text-[11.5px] leading-relaxed" />
        {data.truncated && <div className="mt-2 text-[10.5px] text-black/50">…</div>}
      </div>
    )
  }

  const Icon = artifact.kind === 'folder' ? IconFolder : IconFile

  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-black/15 px-4 py-3.5">
      <span className="icon-tile size-9 shrink-0" style={{ borderRadius: 9 }}>
        <Icon size={18} stroke={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">{artifact.name}</div>
        <div className="truncate text-[11.5px] text-fg-4">{error ?? artifact.path}</div>
      </div>
    </div>
  )
}
