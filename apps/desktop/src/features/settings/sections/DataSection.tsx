import { IconArchive, IconFolder, IconRestore } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Data & folders: where the agent works, and your data.
 *   Work folder: the folder conversations start in and the agent’s file tools are confined to. Picked in the file dialog, never typed.
 *   Backup: a verified copy of this profile (encrypted database, files, manifest with SHA-256 for every file) into a folder you choose.
 *   Import: merges a portability package (memories, some settings, personas), or restores a full backup into a NEW profile. Nothing is deleted or overwritten.
 */

type Result = { success: boolean; path?: string; error?: string }

export function DataSection() {
  const workspace = useBackendData(() => jarod<string | null>('get-default-workspace'))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null)

  if (isUnsupported(workspace.error)) {
    return (
      <>
        <SectionTitle title="Data & folders" subtitle="Where the agent works, and your data." />
        <InlineNote tone="info">These are set up here with the Jarod engine.</InlineNote>
      </>
    )
  }

  const fail = (error: unknown) => notify({ title: 'Data', body: errorText(error).replace(/^.*?\[oneai\]\s*/, ''), level: 'error' })

  const chooseFolder = async () => {
    setBusy(true)

    try {
      const picked = await jarod<string | null>('select-folder')

      if (picked) {
        await jarod('set-default-workspace', picked)
        markSaved()
        notify({ title: 'Work folder set', body: picked, level: 'success' })
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

  const transfer = async (channel: 'run-hermes-backup' | 'run-hermes-import', done: string, cancelledWord: RegExp) => {
    setBusy(true)
    setNote(null)

    try {
      const result = await jarod<Result>(channel)

      if (result.success) {
        markSaved()
        setNote({ tone: 'info', text: result.path ? `${done} ${result.path}` : done })
      } else if (!cancelledWord.test(result.error ?? '')) {
        setNote({ tone: 'danger', text: result.error ?? 'It failed.' })
      }
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SectionTitle title="Data & folders" subtitle="Where the agent works, and your data." />
      <SettingsGroup title="Work folder">
        <SettingsRow icon={<IconFolder />} label={workspace.data ?? 'Default folder'} description="Conversations start here and the agent’s file tools stay inside it. A change applies to new conversations." keywords="work folder workspace default directory">
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void chooseFolder()}>
            Choose folder…
          </GlassButton>
          {workspace.data && (
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void clearFolder()}>
              Use the default
            </GlassButton>
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Backup">
        <SettingsRow icon={<IconArchive />} label="Back up this profile" description="Copies the encrypted database, files and a manifest with a SHA-256 for each file into a folder you choose. The copy is read back and checked." keywords="backup export profile save copy">
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void transfer('run-hermes-backup', 'Backup written to', /annulée/i)}>
            Back up…
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconRestore />} label="Import or restore" description="Pick the manifest.json of a portability package (memories, settings, personas are merged) or of a full backup (restored as a new profile). You confirm before anything is written." keywords="import restore backup portability merge">
          <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void transfer('run-hermes-import', 'Done.', /annulé/i)}>
            Import…
          </GlassButton>
        </SettingsRow>
        {note && <InlineNote tone={note.tone}>{note.text}</InlineNote>}
      </SettingsGroup>
    </>
  )
}
