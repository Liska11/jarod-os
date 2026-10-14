import { IconDatabase, IconFileSearch, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, ProgressBar } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useT } from '../../../lib/i18n.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { NumberRow, reportEngineError, SwitchRow, TextRow, useJarodSettings } from './jarod-controls.tsx'
import { intProblem } from './jarod-settings-model.ts'
import { isUnsupported } from './providers-model.ts'
import { embeddingsUrlProblem, indexSummary, overlapProblem, type RagIndexStatus, reindexAdvice, runPercent, runText } from './rag-model.ts'
import { InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Documents: search inside your documents. The agent indexes a file (the `rag_index` tool), cuts it into passages and asks an embeddings server to turn each into
 * numbers; a question is answered from the closest passages. The embeddings server can be a model on this PC (LM Studio, Ollama: nothing leaves the machine) or a
 * hosted one (document text is sent there; the engine asks you to confirm). Reindexing redoes the passages after you change the sizes or the model.
 */

export function DocumentsSection() {
  const { t } = useT()
  const api = useJarodSettings()
  const status = useBackendData(() => jarod<RagIndexStatus>('rag-index-status'))
  const [busy, setBusy] = useState(false)
  const running = status.data?.run.state === 'running'
  const reload = status.reload

  useEffect(() => {
    if (!running) {
      return
    }

    const timer = setInterval(reload, 1000)

    return () => clearInterval(timer)
  }, [running, reload])

  if (isUnsupported(api.error) || isUnsupported(status.error)) {
    return (
      <>
        <SectionTitle title={t('documents.title')} subtitle={t('documents.subtitle')} />
        <InlineNote tone="info">{t('documents.engineNote')}</InlineNote>
      </>
    )
  }

  const rag = api.settings?.rag
  const s = status.data

  const save = async (patch: Record<string, unknown>, title = t('documents.saved')) => {
    const ok = await api.save({ rag: patch }, title)

    reload()

    return ok
  }

  const reindex = async () => {
    setBusy(true)

    try {
      await jarod('rag-reindex')
      markSaved()
    } catch (error) {
      reportEngineError(t('documents.reindex'), error)
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <>
      <SectionTitle title={t('documents.title')} subtitle={t('documents.subtitle')} />
      {api.error && <InlineNote tone="danger">{t('documents.readFailed', { error: api.error })}</InlineNote>}
      {rag && (
        <SettingsGroup title={t('documents.search')}>
          <SwitchRow icon={<IconFileSearch />} label={t('documents.enable')} description={t('documents.enable.hint')} keywords="rag documents search index embeddings enable" value={rag.enabled} disabled={api.saving} onChange={value => void save({ enabled: value })} />
          <TextRow icon={<IconDatabase />} label={t('documents.server')} description={t('documents.server.hint')} keywords="rag embeddings url server lm studio ollama" value={rag.embeddingsUrl} mono allowEmpty placeholder="http://127.0.0.1:1234/v1" validate={embeddingsUrlProblem} disabled={api.saving} onSave={value => save({ embeddingsUrl: value })} />
          <TextRow icon={<IconDatabase />} label={t('documents.model')} description={t('documents.model.hint')} keywords="rag embeddings model name" value={rag.embeddingsModel} mono allowEmpty disabled={api.saving} onSave={value => save({ embeddingsModel: value })} />
          <NumberRow icon={<IconDatabase />} label={t('documents.chunkSize')} description={t('documents.chunkSize.hint')} keywords="rag chunk size passage" value={rag.chunkSize} validate={text => intProblem(text, 100, 4000)} disabled={api.saving} onSave={value => save({ chunkSize: value })} />
          <NumberRow icon={<IconDatabase />} label={t('documents.overlap')} description={t('documents.overlap.hint')} keywords="rag chunk overlap" value={rag.chunkOverlap} validate={text => intProblem(text, 0, 1000) ?? overlapProblem(Number(text), rag.chunkSize)} disabled={api.saving} onSave={value => save({ chunkOverlap: value })} />
          <NumberRow icon={<IconDatabase />} label={t('documents.maxPerDoc')} description={t('documents.maxPerDoc.hint')} keywords="rag max chunks per document" value={rag.maxChunksPerDoc} validate={text => intProblem(text, 1, 20)} disabled={api.saving} onSave={value => save({ maxChunksPerDoc: value })} />
          <NumberRow icon={<IconDatabase />} label={t('documents.topK')} description={t('documents.topK.hint')} keywords="rag top k results" value={rag.topK} validate={text => intProblem(text, 1, 50)} disabled={api.saving} onSave={value => save({ topK: value })} />
        </SettingsGroup>
      )}
      {s && (
        <SettingsGroup title={t('documents.index')}>
          <SettingsRow
            icon={<IconRefresh />}
            label={indexSummary(s)}
            description={reindexAdvice(s)}
            keywords="rag index reindex documents passages"
            below={
              <>
                {s.run.state === 'running' && <ProgressBar value={runPercent(s.run)} />}
                {runText(s.run) && <div className="text-[12px] text-fg-3">{runText(s.run)}</div>}
              </>
            }
          >
            {running ? (
              <GlassButton size="sm" variant="secondary" disabled={s.run.cancelling} onClick={() => void jarod('rag-reindex-cancel').then(reload)}>
                {t('documents.stop')}
              </GlassButton>
            ) : (
              <GlassButton size="sm" variant="primary" disabled={busy || !s.enabled || s.reindexable === 0} onClick={() => void reindex()}>
                {t('documents.reindexNow')}
              </GlassButton>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}
    </>
  )
}
