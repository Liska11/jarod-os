import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { VmResult, VmsState } from '../../shared/vms.ts'
import { log } from '../log.ts'
import { commands, isOnDisk, listVms, parseOnline, VM_NAME, vmFolder, wsl } from '../vms.ts'

/*
 * WSL machines and the Jarod disk (electron/vms.ts): listed for Settings, installed into <root>\vms or moved there,
 * stopped, removed (the person types the name). One operation at a time; installs take minutes.
 */

const root = (): string | null => process.env.JAROD_OS_ROOT?.trim() || null

export function registerVmsIpc(): void {
  let busy: string | null = null

  const guarded = async (label: string, work: () => Promise<VmResult>): Promise<VmResult> => {
    if (process.platform !== 'win32') return { ok: false, error: 'windows-only' }
    if (busy) return { ok: false, error: 'busy' }

    busy = label

    try {
      return await work()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('vms', `${label} failed: ${message}`)

      return { ok: false, error: message }
    } finally {
      busy = null
    }
  }

  ipcMain.handle(IPC.vmsState, async (): Promise<VmsState> => {
    const disk = root()
    const list = process.platform === 'win32' ? await listVms() : []

    return { available: process.platform === 'win32', root: disk, busy, list: list.map(vm => ({ ...vm, onDisk: isOnDisk(vm, disk) })) }
  })
  ipcMain.handle(IPC.vmsOnline, async () => (process.platform === 'win32' ? parseOnline(await wsl(['--list', '--online'], 60_000).catch(() => '')) : []))
  ipcMain.handle(IPC.vmsCreate, (_event, distro: unknown, name: unknown) =>
    guarded(`install ${String(name)}`, async () => {
      const disk = root()

      if (!disk) return { ok: false, error: 'no-disk' }
      if (typeof distro !== 'string' || !/^[\w.-]+$/.test(distro) || typeof name !== 'string' || !VM_NAME.test(name)) return { ok: false, error: 'bad-name' }
      if ((await listVms()).some(vm => vm.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: 'exists' }

      log('vms', `installing ${distro} as ${name} in ${vmFolder(disk, name)}`)
      await wsl(commands.install(distro, name, vmFolder(disk, name)), 30 * 60_000)

      return { ok: true }
    })
  )
  ipcMain.handle(IPC.vmsMove, (_event, name: unknown) =>
    guarded(`move ${String(name)}`, async () => {
      const disk = root()

      if (!disk) return { ok: false, error: 'no-disk' }
      if (typeof name !== 'string' || !(await listVms()).some(vm => vm.name === name)) return { ok: false, error: 'not-a-vm' }

      // A running machine cannot move: it is stopped first.
      await wsl(commands.stop(name)).catch(() => undefined)
      log('vms', `moving ${name} to ${vmFolder(disk, name)}`)
      await wsl(commands.move(name, vmFolder(disk, name)), 60 * 60_000)

      return { ok: true }
    })
  )
  ipcMain.handle(IPC.vmsStop, (_event, name: unknown) =>
    guarded(`stop ${String(name)}`, async () => {
      if (typeof name !== 'string' || !(await listVms()).some(vm => vm.name === name)) return { ok: false, error: 'not-a-vm' }

      await wsl(commands.stop(name))

      return { ok: true }
    })
  )
  ipcMain.handle(IPC.vmsRemove, (_event, name: unknown, typed: unknown) =>
    guarded(`remove ${String(name)}`, async () => {
      // Erasing a machine's disk cannot be undone: the person types its exact name.
      if (typeof name !== 'string' || typed !== name) return { ok: false, error: 'not-confirmed' }
      if (!(await listVms()).some(vm => vm.name === name)) return { ok: false, error: 'not-a-vm' }

      log('vms', `unregistering ${name} (confirmed by name)`)
      await wsl(commands.remove(name))

      return { ok: true }
    })
  )
}
