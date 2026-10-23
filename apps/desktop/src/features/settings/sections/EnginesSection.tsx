import { IconCpu, IconPlayerPlay, IconPlayerStop, IconPlus, IconRefresh, IconSend, IconShieldQuestion, IconSquareX } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { ENGINE_CAPABILITIES, type CockpitBackendChoice, type EngineInfo, type EnginePermissionPolicy, type EnginesPrefs } from '../../../../shared/engines.ts'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { type MessageKey, useT } from '../../../lib/i18n.ts'
import { applyEngineEvent, levelTone, openApproval, stateTone, type TranscriptEntry, turnRunning } from './engines-model.ts'
import { InlineNote, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Réglages › Moteurs (docs/MULTI-RUNTIME-FAISABILITE.md) : chaque moteur avec son état réel, sa version et ses capacités vérifiées ;
 * le moteur du cockpit (appliqué en relançant Jarod-OS, jamais en cours de session) ; DSH conduit à côté, dans sa propre session.
 */

const input = 'glass-input rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

export function EnginesSection() {
  const { t } = useT()
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [prefs, setPrefs] = useState<EnginesPrefs | null>(null)
  const [savedBackend, setSavedBackend] = useState<CockpitBackendChoice | null>(null)
  const [dshHome, setDshHome] = useState('')

  const refresh = useCallback(() => {
    void window.jarodOS.engines
      .list()
      .then(result => {
        setEngines(result.engines)
        setPrefs(result.prefs)
        setSavedBackend(current => current ?? result.prefs.backend)
        setDshHome(result.dshHome)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()

    return window.jarodOS.engines.onChanged(refresh)
  }, [refresh])

  const save = async (next: EnginesPrefs) => setPrefs(await window.jarodOS.engines.setPrefs(next))
  const active = engines.find(engine => engine.active)

  return (
    <>
      <SectionTitle title={t('engines.title')} subtitle={t('engines.subtitle')} />

      <SettingsGroup title={t('engines.list')}>
        {engines.map(engine => (
          <EngineCard key={engine.id} engine={engine} />
        ))}
      </SettingsGroup>

      {prefs && (
        <SettingsGroup title={t('engines.cockpit')}>
          <SettingsRow
            icon={<IconCpu />}
            label={t('engines.cockpit.choice')}
            description={t('engines.cockpit.hint', {
              current: active ? t(`engines.name.${active.id}` as MessageKey) : '—'
            })}
            keywords="backend hermes jarod moteur engine"
          >
            <MenuDropdown<CockpitBackendChoice>
              ariaLabel={t('engines.cockpit.choice')}
              label={t(`engines.backend.${prefs.backend}` as MessageKey)}
              value={prefs.backend}
              items={(['auto', 'jarod', 'hermes'] as const).map(id => ({
                id,
                label: t(`engines.backend.${id}` as MessageKey),
                description: t(`engines.backend.${id}.hint` as MessageKey)
              }))}
              onSelect={backend => void save({ ...prefs, backend })}
            />
          </SettingsRow>
          {savedBackend !== null && prefs.backend !== savedBackend && (
            <InlineNote tone="warn">
              <span>{t('engines.cockpit.pending')}</span>{' '}
              <GlassButton size="sm" variant="primary" onClick={() => void window.jarodOS.engines.relaunch()}>
                <IconRefresh size={14} /> {t('engines.cockpit.relaunch')}
              </GlassButton>
            </InlineNote>
          )}
          {prefs.backend === 'hermes' && <InlineNote tone="info">{t('engines.cockpit.hermesHome')}</InlineNote>}
        </SettingsGroup>
      )}

      {prefs && <DshPanel engine={engines.find(engine => engine.id === 'dsh')} policy={prefs.dshPermission} onPolicy={dshPermission => void save({ ...prefs, dshPermission })} home={dshHome} />}
    </>
  )
}

function EngineCard({ engine }: { engine: EngineInfo }) {
  const { t } = useT()

  return (
    <div data-engine={engine.id} data-state={engine.state}>
      <SettingsRow
        icon={<IconCpu />}
        label={t(`engines.name.${engine.id}` as MessageKey)}
        keywords={`${engine.id} ${engine.protocol} engine moteur`}
        description={
          <span className="flex flex-col gap-1">
            <span className="selectable font-mono text-[11.5px]">
              {engine.protocol}
              {engine.version ? ` · ${engine.version}` : ''}
              {engine.location ? ` · ${engine.location}` : ''}
            </span>
            <span className="flex flex-wrap gap-1">
              {ENGINE_CAPABILITIES.map(capability => (
                <Pill key={capability} tone={levelTone(engine.capabilities[capability])}>
                  {t(`engines.cap.${capability}` as MessageKey)} · {t(`engines.level.${engine.capabilities[capability]}` as MessageKey)}
                </Pill>
              ))}
            </span>
            {engine.notes.map(note => (
              <span key={note} className="text-[11.5px] text-fg-3">
                {t(note as MessageKey)}
              </span>
            ))}
            {engine.error && <span className="selectable text-[11.5px] text-danger">{engine.error}</span>}
          </span>
        }
      >
        {engine.active && <Pill tone="accent">{t('engines.active')}</Pill>}
        <Pill tone={stateTone(engine.state)} dot>
          {t(`engines.state.${engine.state}` as MessageKey)}
        </Pill>
      </SettingsRow>
    </div>
  )
}

function DshPanel({ engine, policy, onPolicy, home }: { engine?: EngineInfo; policy: EnginePermissionPolicy; onPolicy: (policy: EnginePermissionPolicy) => void; home: string }) {
  const { t } = useT()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const connected = engine?.state === 'connected'
  const running = turnRunning(entries)
  const approval = openApproval(entries)

  useEffect(
    () =>
      window.jarodOS.engines.onEvent(event => {
        if (event.engine === 'dsh' && event.sessionId === sessionId) {
          setEntries(current => applyEngineEvent(current, event))
        }
      }),
    [sessionId]
  )

  const run = async (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setMessage(null)
    const result = await work().catch((error: unknown) => ({
      ok: false,
      error: String(error)
    }))
    setBusy(false)

    if (!result.ok) {
      setMessage(t('engines.dsh.error', { detail: result.error ?? '' }))
    }

    return result.ok
  }

  const newSession = async () => {
    const result = await window.jarodOS.engines.dsh.newSession()

    if (result.ok) {
      setSessionId(result.value)
      setEntries([])
    }

    return result
  }

  const send = async () => {
    const text = draft.trim()

    if (!sessionId || !text) return

    if (await run(() => window.jarodOS.engines.dsh.prompt(sessionId, text))) {
      setEntries(current => [...current, { kind: 'user', text }])
      setDraft('')
    }
  }

  return (
    <SettingsGroup title={t('engines.dsh.title')}>
      {!engine?.installed && <InlineNote tone="info">{t('engines.dsh.notInstalled')}</InlineNote>}
      <SettingsRow icon={<IconShieldQuestion />} label={t('engines.dsh.permission')} description={t('engines.dsh.permission.hint')} keywords="dsh approval accord permission">
        <MenuDropdown<EnginePermissionPolicy>
          ariaLabel={t('engines.dsh.permission')}
          label={t(`engines.policy.${policy}` as MessageKey)}
          value={policy}
          items={(['ask', 'deny', 'allow'] as const).map(id => ({
            id,
            label: t(`engines.policy.${id}` as MessageKey),
            description: t(`engines.policy.${id}.hint` as MessageKey)
          }))}
          onSelect={onPolicy}
        />
      </SettingsRow>
      {engine?.installed && (
        <SettingsRow icon={<IconCpu />} label={t('engines.dsh.connection')} description={<span className="selectable font-mono text-[11.5px]">{t('engines.dsh.home', { home })}</span>} keywords="dsh acp start stop">
          {connected ? (
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.jarodOS.engines.dsh.stop()).then(() => setSessionId(null))}>
              <IconPlayerStop size={14} /> {t('engines.dsh.stop')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void run(() => window.jarodOS.engines.dsh.start())}>
              <IconPlayerPlay size={14} /> {t('engines.dsh.start')}
            </GlassButton>
          )}
          <GlassButton size="sm" variant="secondary" disabled={!connected || busy || running} onClick={() => void run(newSession)}>
            <IconPlus size={14} /> {t('engines.dsh.newSession')}
          </GlassButton>
        </SettingsRow>
      )}
      {message && <InlineNote tone="danger">{message}</InlineNote>}
      {sessionId && (
        <div className="flex flex-col gap-2 px-1 py-2">
          <span className="selectable font-mono text-[11px] text-fg-4">{t('engines.dsh.session', { id: sessionId })}</span>
          <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto rounded-lg bg-white/5 p-2 text-[12.5px]">
            {entries.length === 0 && <span className="text-fg-4">{t('engines.dsh.empty')}</span>}
            {entries.map((entry, index) => (
              <TranscriptLine key={index} entry={entry} />
            ))}
          </div>
          {approval && (
            <InlineNote tone="warn">
              <span className="flex flex-col gap-1">
                <strong>{t('engines.dsh.approval', { tool: approval.title || '?' })}</strong>
                {Object.entries(approval.input).map(([key, value]) => (
                  <span key={key} className="selectable font-mono text-[11.5px]">
                    {key}: {value}
                  </span>
                ))}
                <span className="flex gap-2">
                  <GlassButton size="sm" variant="primary" onClick={() => void window.jarodOS.engines.dsh.approve(approval.requestId, 'allow')}>
                    {t('engines.dsh.allowOnce')}
                  </GlassButton>
                  <GlassButton size="sm" variant="danger" onClick={() => void window.jarodOS.engines.dsh.approve(approval.requestId, 'deny')}>
                    {t('engines.dsh.deny')}
                  </GlassButton>
                </span>
              </span>
            </InlineNote>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
              rows={2}
              disabled={!connected || running}
              className={`${input} flex-1 py-1.5`}
              placeholder={t('engines.dsh.placeholder')}
              aria-label={t('engines.dsh.placeholder')}
            />
            {running ? (
              <GlassButton size="sm" variant="danger" onClick={() => void run(() => window.jarodOS.engines.dsh.cancel(sessionId))}>
                <IconSquareX size={14} /> {t('engines.dsh.cancel')}
              </GlassButton>
            ) : (
              <GlassButton size="sm" variant="primary" disabled={!connected || !draft.trim()} onClick={() => void send()}>
                <IconSend size={14} /> {t('engines.dsh.send')}
              </GlassButton>
            )}
          </div>
          <span className="text-[11px] text-fg-4">{t('engines.dsh.streamingNote')}</span>
        </div>
      )}
    </SettingsGroup>
  )
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const { t } = useT()

  switch (entry.kind) {
    case 'user':
      return <span className="selectable self-end rounded-md bg-accent/15 px-2 py-1">{entry.text}</span>
    case 'assistant':
      return (
        <span className="selectable whitespace-pre-wrap">
          {entry.text || (entry.done ? '' : '…')}
          {entry.done && entry.stopReason && entry.stopReason !== 'end_turn' && <Pill tone="warn">{entry.stopReason}</Pill>}
        </span>
      )
    case 'tool':
      return (
        <span className="selectable font-mono text-[11.5px] text-fg-3">
          {t('engines.dsh.tool', { tool: entry.title, status: entry.status })}
          {entry.text ? ` — ${entry.text.slice(0, 200)}` : ''}
        </span>
      )
    case 'approval':
      return entry.decision ? <span className="text-[11.5px] text-fg-3">{t(entry.automatic ? 'engines.dsh.approvalAuto' : 'engines.dsh.approvalDone', { tool: entry.title || '?', decision: entry.decision })}</span> : null
    case 'error':
      return <span className="selectable text-danger">{entry.text}</span>
  }
}
