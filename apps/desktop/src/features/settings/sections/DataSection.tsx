import { IconArchive, IconFolder, IconRestore } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Data & folders: where the agent works, and your data.
 *   Work folder: the folder conversations start in and the agent’s file tools are confined to. Picked in the file dialog, never typed.
 *   Backup: a verified copy of this profile (encrypted database, files, manifest with SHA-256 for every file) into a folder you choose.
 *   Import: merges a portability package (memories, some settings, personas), or restores a full backup into a NEW profile. Nothing is deleted or overwritten.
 */

type Result = { success: boolean; path?: string; error?: string }

export function DataSection() {
  const { t } = useT()
  const workspace = useBackendData(() => jarod<string | null>('get-default-workspace'))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null)

  if (isUnsupported(workspace.error)) {
    return (
      <>
        <SectionTitle title={t('data.title')} subtitle={t('data.subtitle')} />
        <InlineNote tone="info">{t('data.needEngine')}</InlineNote>
      </>
    )
  }

  const fail = (error: unknown) => reportEngineError(t('data.engineError'), error)

  const chooseFolder = async () => {
    setBusy(true)

    try {
      const picked = await jarod<string | null>('select-folder')

      if (picked) {
        await jarod('set-default-workspace', picked)
        markSaved()
        notify({ title: t('data.workFolderSet'), body: picked, level: 'success' })
        workspace.reload()
      }
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const clearFolder = async () => {
    setBusy(true)

    try {
      await jarod('set-default-workspace', null)
      markSaved()
      workspace.reload()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const transfer = async (channel: 'run-hermes-backup' | 'run-hermes-import', done: (path: string | undefined) => string, cancelledWord: RegExp) => {
    setBusy(true)
    setNote(null)

    try {
      const result = await jarod<Result>(channel)

      if (result.success) {
        markSaved()
        setNote({ tone: 'info', text: done(result.path) })
      } else if (!cancelledWord.test(result.error ?? '')) {
        setNote({ tone: 'danger', text: result.error ?? t('data.failed') })
      }
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('data.title')} subtitle={t('data.subtitle')} />
      <SettingsGroup title={t('data.workFolder')}>
        <SettingsRow icon={<IconFolder />} label={workspace.data ?? t('data.defaultFolder')} description={t('data.workFolder.hint')} keywords="work folder workspace default directory">
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void chooseFolder()}>
            {t('data.chooseFolder')}
          </GlassButton>
          {workspace.data && (
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void clearFolder()}>
              {t('data.useDefault')}
            </GlassButton>
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('data.backup')}>
        <SettingsRow icon={<IconArchive />} label={t('data.backupProfile')} description={t('data.backupProfile.hint')} keywords="backup export profile save copy">
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void transfer('run-hermes-backup', path => t('data.backupWritten', { path: path ?? '' }).trimEnd(), /annulée/i)}>
            {t('data.backupButton')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconRestore />} label={t('data.import')} description={t('data.import.hint')} keywords="import restore backup portability merge">
          <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void transfer('run-hermes-import', () => t('data.done'), /annulé/i)}>
            {t('data.importButton')}
          </GlassButton>
        </SettingsRow>
        {note && <InlineNote tone={note.tone}>{note.text}</InlineNote>}
      </SettingsGroup>
    </>
  )
}
