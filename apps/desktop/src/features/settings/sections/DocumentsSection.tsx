import { IconDatabase, IconFileSearch, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, ProgressBar } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
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
        <SectionTitle title="Documents" subtitle="Search inside your documents." />
        <InlineNote tone="info">Document search is set up here with the Jarod engine.</InlineNote>
      </>
    )
  }

  const rag = api.settings?.rag
  const s = status.data

  const save = async (patch: Record<string, unknown>, title = 'Setting saved') => {
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
      reportEngineError('Reindex', error)
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <>
      <SectionTitle title="Documents" subtitle="Search inside your documents." />
      {api.error && <InlineNote tone="danger">Could not read the settings: {api.error}</InlineNote>}
      {rag && (
        <SettingsGroup title="Search">
          <SwitchRow icon={<IconFileSearch />} label="Search my documents" description="Lets the agent index files and answer from them." keywords="rag documents search index embeddings enable" value={rag.enabled} disabled={api.saving} onChange={value => void save({ enabled: value })} />
          <TextRow icon={<IconDatabase />} label="Embeddings server" description="An OpenAI-compatible address that turns text into numbers. A model on this PC keeps your documents here; any other address is confirmed first." keywords="rag embeddings url server lm studio ollama" value={rag.embeddingsUrl} mono allowEmpty placeholder="http://127.0.0.1:1234/v1" validate={embeddingsUrlProblem} disabled={api.saving} onSave={value => save({ embeddingsUrl: value })} />
          <TextRow icon={<IconDatabase />} label="Embeddings model" description="The model name the server knows, like text-embedding-nomic-embed-text-v1.5." keywords="rag embeddings model name" value={rag.embeddingsModel} mono allowEmpty disabled={api.saving} onSave={value => save({ embeddingsModel: value })} />
          <NumberRow icon={<IconDatabase />} label="Passage size" description="Characters per passage." keywords="rag chunk size passage" value={rag.chunkSize} validate={text => intProblem(text, 100, 4000)} disabled={api.saving} onSave={value => save({ chunkSize: value })} />
          <NumberRow icon={<IconDatabase />} label="Overlap" description="Characters shared by neighbouring passages (at most half a passage)." keywords="rag chunk overlap" value={rag.chunkOverlap} validate={text => intProblem(text, 0, 1000) ?? overlapProblem(Number(text), rag.chunkSize)} disabled={api.saving} onSave={value => save({ chunkOverlap: value })} />
          <NumberRow icon={<IconDatabase />} label="Passages kept per document" description="At most this many passages of one document in an answer." keywords="rag max chunks per document" value={rag.maxChunksPerDoc} validate={text => intProblem(text, 1, 20)} disabled={api.saving} onSave={value => save({ maxChunksPerDoc: value })} />
          <NumberRow icon={<IconDatabase />} label="Passages per question" description="How many passages are looked at to answer." keywords="rag top k results" value={rag.topK} validate={text => intProblem(text, 1, 50)} disabled={api.saving} onSave={value => save({ topK: value })} />
        </SettingsGroup>
      )}
      {s && (
        <SettingsGroup title="Index">
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
                Stop
              </GlassButton>
            ) : (
              <GlassButton size="sm" variant="primary" disabled={busy || !s.enabled || s.reindexable === 0} onClick={() => void reindex()}>
                Reindex…
              </GlassButton>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}
    </>
  )
}
