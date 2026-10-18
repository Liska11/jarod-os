import { describe, expect, it } from 'vitest'
import { commands, isOnDisk, listVms, parseList, parseLocations, parseOnline } from './vms.ts'

const LIST = '  NAME              STATE           VERSION\r\n* Ubuntu-26.04      Stopped         2\r\n  docker-desktop    Stopped         2\r\n  dev               Running         2\r\n'

describe('WSL output', () => {
  it('reads the machines, the default one, without Docker’s own', () => {
    expect(parseList(LIST)).toEqual([
      { name: 'Ubuntu-26.04', state: 'Stopped', version: 2, default: true },
      { name: 'dev', state: 'Running', version: 2, default: false }
    ])
    expect(parseList('U\u0000b\u0000')).toEqual([])
  })

  it('reads the distributions available online, in English or French', () => {
    const english = 'The following is a list of valid distributions.\r\n\r\nNAME            FRIENDLY NAME\r\nUbuntu          Ubuntu\r\nDebian          Debian GNU/Linux\r\n'
    const french = 'Voici la liste des distributions valides.\r\n\r\nNOM             NOM CONVIVIAL\r\nUbuntu-24.04    Ubuntu 24.04 LTS\r\n'

    expect(parseOnline(english)).toEqual([
      { id: 'Ubuntu', label: 'Ubuntu' },
      { id: 'Debian', label: 'Debian GNU/Linux' }
    ])
    expect(parseOnline(french)).toEqual([{ id: 'Ubuntu-24.04', label: 'Ubuntu 24.04 LTS' }])
    expect(parseOnline('no network')).toEqual([])
  })

  it('reads where each machine keeps its disk', () => {
    const json = JSON.stringify([
      { DistributionName: 'Ubuntu-26.04', BasePath: 'C:\\Users\\me\\AppData\\Local\\wsl\\{abc}' },
      { DistributionName: 'dev', BasePath: '\\\\?\\D:\\Jarod-OS\\vms\\dev' }
    ])
    const where = parseLocations(json)

    expect(where.get('dev')).toBe('D:\\Jarod-OS\\vms\\dev')
    expect(isOnDisk({ location: where.get('dev') ?? null }, 'D:\\Jarod-OS')).toBe(true)
    expect(isOnDisk({ location: where.get('Ubuntu-26.04') ?? null }, 'D:\\Jarod-OS')).toBe(false)
    expect(isOnDisk({ location: 'D:\\Jarod-OS\\vmsX\\a' }, 'D:\\Jarod-OS')).toBe(false)
    expect(parseLocations('')).toEqual(new Map())
  })

  it('joins the list and the locations', async () => {
    const vms = await listVms(async () => LIST, async () => new Map([['dev', 'D:\\Jarod-OS\\vms\\dev']]))

    expect(vms.map(vm => [vm.name, vm.location])).toEqual([
      ['Ubuntu-26.04', null],
      ['dev', 'D:\\Jarod-OS\\vms\\dev']
    ])
  })
})

describe('WSL commands', () => {
  it('installs into the Jarod disk without starting, moves, stops and removes by name', () => {
    expect(commands.install('Ubuntu-24.04', 'dev', 'D:\\Jarod-OS\\vms\\dev')).toEqual(['--install', 'Ubuntu-24.04', '--name', 'dev', '--location', 'D:\\Jarod-OS\\vms\\dev', '--no-launch'])
    expect(commands.move('dev', 'D:\\Jarod-OS\\vms\\dev')).toEqual(['--manage', 'dev', '--move', 'D:\\Jarod-OS\\vms\\dev'])
    expect(commands.stop('dev')).toEqual(['--terminate', 'dev'])
    expect(commands.remove('dev')).toEqual(['--unregister', 'dev'])
  })
})
