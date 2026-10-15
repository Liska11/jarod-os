#!/usr/bin/env node
/**
 * Measures the access control of the Windows named pipe the host control door uses, on this machine.
 *
 * The app never passes a security descriptor (Node's `net` module has no parameter for one), so the
 * pipe carries whatever the creating token's default DACL produces. This probe answers, with a real
 * measurement, what that is: owner, group, DACL, which SIDs may write, and whether a same-user
 * process can connect. It owns a throwaway pipe created through the same code path the app uses; it
 * never touches the live endpoint.
 *
 *   node scripts/probe-pipe-acl.mjs               # the measurement
 *   node scripts/probe-pipe-acl.mjs --experiment  # + flag absence, and whether hardening survives
 *
 * Exit code is 0 whatever the verdict: this is a report, not a gate.
 */

import { execFileSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const experiment = process.argv.includes('--experiment')

/** Known SIDs in the terms the question is asked in. Anything else is printed as it is. */
const WELL_KNOWN = {
  SY: 'Local System',
  BA: 'BUILTIN\\Administrators',
  WD: 'Everyone',
  AN: 'Anonymous',
  CO: 'Creator Owner',
  AU: 'Authenticated Users',
  BU: 'BUILTIN\\Users'
}

/** The write bits that would let a caller drive the shell: FILE_WRITE_DATA | FILE_APPEND_DATA, etc. */
const WRITE_MASKS = new Set(['FA', 'GW', 'FW', 'WD', 'AD', 'WO'])
const WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000

const name = `herald-os-probe-${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`

function powershell(args) {
  // Windows PowerShell 5.1 and PowerShell 7 disagree on little here, but only one may be installed.
  for (const shell of ['pwsh', 'powershell']) {
    try {
      return execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'pipe-dacl.ps1'), ...args], {
        encoding: 'utf8'
      }).trim()
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }

      // A non-zero exit is how the helper reports OPEN_FAILED / SDDL_FAILED: its line is the answer.
      const reported = String(error?.stdout ?? '').trim()

      return reported || `PROBE_FAILED ${error instanceof Error ? error.message : String(error)}`
    }
  }

  return 'PROBE_FAILED no PowerShell on PATH'
}

/** The SDDL of a pipe that exists, or the failure the helper reported. */
function sddlOf(pipeName) {
  return powershell(['-PipeName', pipeName])
}

function identity() {
  const text = powershell(['-Identity'])
  const user = text.match(/^USER (S-1-[0-9-]+)$/m)?.[1]
  // The logon SID names the session, and it is what a Microsoft-shaped DACL would also allow.
  let logon
  try {
    logon = execFileSync('whoami', ['/logonid'], { encoding: 'utf8' }).trim().match(/^(S-1-5-5-[0-9-]+)$/m)?.[1]
  } catch {
    logon = undefined
  }

  return { user, logon, raw: `USER ${user ?? 'unknown'}\nLOGON ${logon ?? 'unknown'}` }
}

function parseAces(sddl) {
  const aces = []

  for (const [, body] of sddl.matchAll(/\(([^)]*)\)/g)) {
    // An ACE is (type;flags;mask;object;inherit;sid).
    const [type, , mask, , , sid] = body.split(';')

    if (type !== 'A' || !mask || !sid) {
      continue
    }

    const numeric = /^0x[0-9a-f]+$/i.test(mask) ? Number.parseInt(mask.slice(2), 16) : null
    const writes = WRITE_MASKS.has(mask.toUpperCase()) || (numeric !== null && (numeric & WRITE_BITS) !== 0)

    aces.push({ sid, label: WELL_KNOWN[sid] ?? sid, mask, writes })
  }

  return aces
}

/** Whether another process of the same user can reach the pipe: what a local caller would do. */
function sameUserCanConnect(pipeName) {
  return new Promise(resolve => {
    const socket = net.connect(`\\\\.\\pipe\\${pipeName}`)
    const settle = value => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(2000)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

/** Whether a second server can bind the same name, and how it failed: FILE_FLAG_FIRST_PIPE_INSTANCE would refuse. */
function secondBind(pipeName) {
  return new Promise(resolve => {
    const other = net.createServer(socket => socket.end())
    const settle = value => {
      other.removeAllListeners()
      try {
        other.close()
      } catch {
        // Already gone.
      }

      resolve(value)
    }

    other.once('error', error => settle({ bound: false, error: `${error.code ?? ''} ${error.message}`.trim() }))
    other.listen(`\\\\.\\pipe\\${pipeName}`, () => settle({ bound: true, error: null }))
  })
}

const server = net.createServer(socket => socket.end())

server.listen(`\\\\.\\pipe\\${name}`, async () => {
  const ids = identity()
  const first = sddlOf(name)
  const connected = await sameUserCanConnect(name)

  const dacl = first.includes('D:') ? `D:${first.split('D:').slice(1).join('D:')}` : first
  const aces = first.includes('D:') ? parseAces(dacl) : []
  const owner = first.match(/O:(S-1-[0-9-]+)/)?.[1] ?? null
  const group = first.match(/G:(S-1-[0-9-]+)/)?.[1] ?? null
  const writers = aces.filter(ace => ace.writes).map(ace => `${ace.label} (${ace.mask})`)
  const readers = aces.filter(ace => !ace.writes).map(ace => `${ace.label} (${ace.mask})`)
  // Anyone who is not SYSTEM, an administrator, or this very user, and can write, can drive the shell.
  const foreignWriters = aces
    .filter(ace => ace.writes && !['SY', 'BA'].includes(ace.sid) && ace.sid !== ids.user)
    .map(ace => ace.label)

  const report = {
    pipe: name,
    creation: {
      code: 'apps/desktop/electron/shell/os-control.ts — net.createServer(...).listen(target.path)',
      name_source: 'controlEndpoint({ platform: "win32" }) in apps/desktop/electron/shell/control-authz.ts',
      security_descriptor:
        'none passed by the app: libuv calls CreateNamedPipeW with a NULL descriptor, so the creating token\'s default DACL applies',
      derivation: 'sha256(dataDir + "\\0" + runtimeDir).hex.slice(0, 16), prefixed herald-os-'
    },
    measured: {
      raw: first,
      owner,
      group,
      aces,
      can_write: writers,
      can_read_only: readers,
      another_process_same_user_can_connect: connected,
      note: 'write access is what a control request needs; read-only access cannot send a request'
    },
    another_user: {
      measured: false,
      protocol: [
        'the DACL above already answers it for any foreign token: a SID in can_write means that user can drive the shell',
        'to observe it: run this script from the other user\'s session and compare the DACL line',
        'decision rule: the pipe grants writing iff the foreign token\'s user SID (or a group it holds) appears with a write bit in the DACL, or the DACL is absent (then everyone writes)'
      ]
    },
    verdict: null
  }

  if (!first.includes('D:')) {
    // No measurement: the honest verdict is that nothing is demonstrated, never "secure".
    report.verdict = 'ACL implicite / non démontrée'
  } else if (foreignWriters.length > 0 || aces.length === 0) {
    report.verdict = 'accès trop large'
  } else if (readers.some(entry => entry.startsWith('Everyone') || entry.startsWith('Anonymous'))) {
    // The ACL is the runtime's implicit one, and it hands read-only access to everyone:
    // not enough to send a control request, but broader than the code ever intended.
    report.verdict =
      'ACL implicite / non démontrée (lecture accordée à Everyone/Anonymous ; écriture réservée à l\'utilisateur, SYSTEM et les administrateurs)'
  } else {
    report.verdict = 'ACL explicite correcte'
  }

  if (experiment) {
    const strict = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ids.user})${ids.logon ? `(A;;FA;;;${ids.logon})` : ''}`
    const bind = await secondBind(name)
    // A hostile local process does not go through libuv: it calls CreateNamedPipeW itself. Whether the
    // kernel refuses it is the question, so measure both spellings instead of assuming the flag's reach.
    const squatWithoutFlag = powershell(['-PipeName', name, '-CreateInstance'])
    const squatWithFlag = powershell(['-PipeName', name, '-CreateInstance', '-FirstInstance'])
    const applied = powershell(['-PipeName', name, '-ApplySddl', strict])
    const afterSet = sddlOf(name)
    // A connection makes the server accept it, and the runtime then creates its next listening
    // instance — with the same NULL descriptor it always used.
    const reconnected = await sameUserCanConnect(name)
    const afterConnect = sddlOf(name)
    const afterAgain = sddlOf(name)
    // Five more accepts: if the runtime really re-creates each instance from the NULL descriptor, a
    // broad DACL should come back the moment a fresh instance takes over.
    const afterMore = []
    for (let i = 0; i < 5; i += 1) {
      await sameUserCanConnect(name)
      afterMore.push(sddlOf(name))
    }

    report.experiment = {
      purpose: 'does hardening the pipe instance survive the next accept, and is FIRST_PIPE_INSTANCE set?',
      identity: ids.raw,
      strict_sddl_offered: strict,
      second_server_can_bind_the_same_name: bind.bound,
      second_bind_failure: bind.error,
      first_pipe_instance_flag_present: bind.bound === false,
      apply_result: applied,
      dacl_after_set: afterSet,
      same_user_could_still_connect: reconnected,
      dacl_after_the_server_accepted: afterConnect,
      dacl_read_again: afterAgain,
      squatting: {
        hostile_process_without_the_flag: squatWithoutFlag,
        hostile_process_with_the_flag: squatWithFlag,
        note:
          'a hostile local process does not use libuv: it calls CreateNamedPipeW itself. CREATED means it took another instance of the app\'s name; CREATE_FAILED win32=5 (access denied) means the kernel refused it.'
      },
      dacl_after_five_more_accepts: afterMore,
      reading_note:
        'a by-name read reaches one instance of the pipe; the runtime creates each next instance with the same NULL descriptor, so a broad DACL reappearing here means the instance that will accept the next client is the broad one'
    }
  }

  console.log(JSON.stringify(report, null, 2))

  server.close(() => process.exit(0))
})
