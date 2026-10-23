import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ControlEndpoint } from './control-authz.ts'
import { OsControlServer } from './os-control.ts'
import {
  assertPipeDacl,
  controlPipeSddl,
  hardenControlPipe,
  isLogonSid,
  logonSidFromDefaultDacl,
  parseIdentity,
  parseReadback,
  pipeAceSet,
  pipePrincipalsFor,
  readControlPipeDacl,
  readTokenDefaultDacl,
  resolvePipeIdentity,
  resolvePipePrincipals,
  PipeSecurityError,
} from './pipe-security.ts'

const windows = process.platform === 'win32'
const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const LOGON = 'S-1-5-5-0-1234567'

function uniquePipe(): ControlEndpoint & { kind: 'pipe' } {
  const name = `herald-os-test-${randomBytes(8).toString('hex')}`

  return { kind: 'pipe', endpoint: `pipe://${name}`, path: `\\\\.\\pipe\\${name}` }
}

describe('controlPipeSddl', () => {
  it('names exactly the principals it is given, in a stable order, with protected DACL rights', () => {
    expect(controlPipeSddl([LOGON, USER])).toBe(`D:P(A;;FRFW;;;${USER})(A;;FRFW;;;${LOGON})`)
    expect(controlPipeSddl([USER, USER, LOGON])).toBe(controlPipeSddl([LOGON, USER]))
  })

  it('refuses a policy it cannot state honestly', () => {
    expect(() => controlPipeSddl([])).toThrow(PipeSecurityError)
    expect(() => controlPipeSddl(['Everyone'])).toThrow(/not a SID/)
    expect(() => controlPipeSddl(['WD'])).toThrow(/not a SID/)
    expect(() => controlPipeSddl(['S-1-1-0'])).toThrow(/broad principal/)
    expect(() => controlPipeSddl(['S-1-5-18'])).toThrow(/broad principal/)
  })
})

describe('pipePrincipalsFor', () => {
  it('prefers the logon SID, which is what a remote or other-session client lacks', () => {
    expect(pipePrincipalsFor({ user: USER, logon: LOGON })).toEqual([LOGON])
  })

  it('falls back to the user when the token carries no logon SID', () => {
    expect(pipePrincipalsFor({ user: USER, logon: null })).toEqual([USER])
    expect(pipePrincipalsFor({ user: USER, logon: '' })).toEqual([USER])
  })

  it('refuses a token it cannot name', () => {
    expect(() => pipePrincipalsFor({ user: '', logon: null })).toThrow(PipeSecurityError)
    expect(() => pipePrincipalsFor({ user: 'me', logon: 'you' })).toThrow(PipeSecurityError)
  })
})

describe('parseIdentity', () => {
  it('reads the two lines the identity script prints', () => {
    expect(parseIdentity(`USER ${USER}\r\nLOGON ${LOGON}\r\n`)).toEqual({ user: USER, logon: LOGON })
  })

  it('reads an empty logon as absent', () => {
    expect(parseIdentity(`USER ${USER}\nLOGON \n`)).toEqual({ user: USER, logon: null })
  })

  it('refuses a token that came back without a user', () => {
    expect(() => parseIdentity('LOGON \n')).toThrow(PipeSecurityError)
  })
})

describe('parseReadback', () => {
  it('finds the SDDL the script printed', () => {
    expect(parseReadback('SDDL O:BA G:BA D:P(A;;FRFW;;;S-1-5-5-0-1)\n', 'SDDL')).toBe('O:BA G:BA D:P(A;;FRFW;;;S-1-5-5-0-1)')
  })

  it('returns nothing when the script reported a failure instead', () => {
    expect(parseReadback('OPEN_FAILED win32=5\n', 'SDDL')).toBeNull()
  })
})

describe('assertPipeDacl', () => {
  const expected = controlPipeSddl([LOGON])

  it('accepts exactly the DACL that was asked for, however the platform spells the mask', () => {
    expect(() => assertPipeDacl(`O:BA G:BA ${expected}`, expected)).not.toThrow()
    expect(() => assertPipeDacl(`O:${USER}G:${USER}D:P(A;;0x12019f;;;${LOGON})`, expected)).not.toThrow()
  })

  it('refuses a DACL that is not protected, missing, or wider than the request', () => {
    expect(() => assertPipeDacl(`O:BA G:BA D:(A;;FRFW;;;${LOGON})`, expected)).toThrow(/not protected/)
    expect(() => assertPipeDacl('O:BA G:BA D:P', expected)).toThrow(/missing/)
    expect(() => assertPipeDacl(`O:BA G:BA ${expected}(A;;FR;;;WD)`, expected)).toThrow(/more than the requested/)
    expect(() => assertPipeDacl(`O:BA G:BA D:P(A;;FRFW;;;${LOGON})(A;;FRFW;;;${USER})`, expected)).toThrow(/more than the requested/)
  })

  it('reads the built-in Administrator alias back as the account that was asked for, and nothing else', () => {
    const admin = 'S-1-5-21-4239583824-265399229-1323058055-500'
    const wanted = controlPipeSddl([admin])

    expect(() => assertPipeDacl('O:BAG:S-1-5-21-4239583824-265399229-1323058055-513D:P(A;;0x12019f;;;LA)', wanted)).not.toThrow()
    expect(() => assertPipeDacl('O:BA G:BA D:P(A;;0x12019f;;;LG)', wanted)).toThrow(/missing/)
    expect(() => assertPipeDacl('O:BA G:BA D:P(A;;0x12019f;;;LA)', expected)).toThrow(/missing/)
    expect(() => assertPipeDacl(`O:BA G:BA D:P(A;;0x12019f;;;LA)(A;;FR;;;${admin})`, wanted)).toThrow(/more than the requested/)
  })
})

describe('isLogonSid', () => {
  it('separates one logon session from an account', () => {
    expect(isLogonSid('S-1-5-5-0-457057')).toBe(true)
    expect(isLogonSid('S-1-5-5-3-1')).toBe(true)
    expect(isLogonSid(USER)).toBe(false)
    expect(isLogonSid('S-1-5-18')).toBe(false)
    expect(isLogonSid('')).toBe(false)
  })
})

describe('pipeAceSet', () => {
  it('spells each ACE one way, so a numeric mask and a named mask compare', () => {
    expect(pipeAceSet(`O:BA G:BA D:P(A;;0x12019f;;;${USER})(A;;FR;;;WD)`)).toEqual(
      [`0x120089;;;WD`, `0x12019f;;;${USER}`].sort(),
    )
  })
})

describe('logonSidFromDefaultDacl', () => {
  it('reads the one session a default DACL names, and refuses an ambiguous one', () => {
    expect(logonSidFromDefaultDacl(`D:P(A;;GA;;;SY)(A;;GA;;;${USER})(A;;GXGR;;;${LOGON})`)).toBe(LOGON)
    expect(logonSidFromDefaultDacl(`D:P(A;;GA;;;SY)(A;;GA;;;${USER})`)).toBeNull()
    expect(logonSidFromDefaultDacl(`D:P(A;;GA;;;${LOGON})(A;;GA;;;S-1-5-5-0-2)`)).toBeNull()
  })
})

describe('named pipe security on this platform', () => {
  it('resolves the principals of the current token on Windows only', async () => {
    if (!windows) {
      await expect(resolvePipePrincipals()).rejects.toThrow(/Windows/)

      return
    }

    const principals = await resolvePipePrincipals()

    expect(principals.length).toBeGreaterThan(0)

    for (const sid of principals) {
      expect(sid).toMatch(/^S-1-5-\d+(-\d+)+$/)
    }
  })

  it.runIf(windows)('replaces the implicit DACL of a live pipe and still talks to it', async () => {
    const target = uniquePipe()
    const server = net.createServer(connection => {
      connection.setEncoding('utf8')
      connection.on('data', () => connection.write('{"ok":true}\n'))
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(target.path, resolve)
    })

    try {
      const principals = await resolvePipePrincipals()
      const applied = await hardenControlPipe(target.path, principals)

      expect(() => assertPipeDacl(applied, controlPipeSddl(principals))).not.toThrow()
      expect(applied).not.toMatch(/;;;[WAS]D\)/)
      expect(applied).not.toMatch(/;;;AN\)/)
      expect(await readControlPipeDacl(target.path)).toBe(applied)

      // The client the shell itself expects — a process of this session — is still let in.
      const answer = await new Promise<string>((resolve, reject) => {
        const client = net.connect(target.path, () => client.write('{"cmd":"ui"}\n'))
        client.setEncoding('utf8')
        client.once('data', chunk => {
          client.end()
          resolve(String(chunk))
        })
        client.once('error', reject)
      })

      expect(answer.trim()).toBe('{"ok":true}')
      expect(await readControlPipeDacl(target.path)).toBe(applied)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it.runIf(windows)('refuses to serve a pipe whose DACL it could not replace', async () => {
    const target = uniquePipe()
    const server = new OsControlServer(target, async () => ({ ok: true }))

    server.start()
    await server.ready

    expect(server.status.serving).toBe(true)

    const live = await readControlPipeDacl(target.path)
    const wanted = controlPipeSddl(await resolvePipePrincipals())

    expect(() => assertPipeDacl(live, wanted)).not.toThrow()

    // A second claim of the same name is exactly the squatting attempt FILE_FLAG_FIRST_PIPE_INSTANCE
    // exists for: libuv sets it, so the impostor is the one that fails.
    const impostor = new OsControlServer(target, async () => ({ ok: true }))

    impostor.start()
    await impostor.ready

    expect(impostor.status.serving).toBe(false)
    expect(impostor.status.failure).toBeTruthy()

    server.stop()
    impostor.stop()
  })

  it.runIf(windows)('is born with a platform default DACL rather than the policy this shell states', async () => {
    const target = uniquePipe()
    const server = net.createServer(connection => connection.destroy())

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(target.path, resolve)
    })

    try {
      const live = pipeAceSet(await readControlPipeDacl(target.path))
      const tokenDefault = await readTokenDefaultDacl()

      expect(tokenDefault).toBeTruthy()

      // Node takes no SECURITY_ATTRIBUTES argument, so the object libuv creates is born with a DACL the
      // platform chose. Measured here, that DACL grants read to Everyone and Anonymous — which this
      // shell's policy never does — so until the policy is stated and read back, the door is not ours.
      expect(live).not.toEqual(pipeAceSet(controlPipeSddl(await resolvePipePrincipals())))
      expect(live).toContain('0x120089;;;WD')
      expect(live).toContain('0x120089;;;AN')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it.runIf(windows)('names the session from the token default DACL when the group enumeration has none', async () => {
    const tokenDefault = await readTokenDefaultDacl()
    const logon = tokenDefault ? logonSidFromDefaultDacl(tokenDefault) : null

    if (logon) {
      // An interactive token carries its logon SID in its default DACL: the resolution must prefer it,
      // which scopes the pipe to one session rather than to every process of the account.
      expect(await resolvePipePrincipals()).toEqual([logon])
    } else {
      // A token whose default DACL names no session is the documented fallback: the account is the
      // only principal the pipe can honestly name.
      expect(await resolvePipePrincipals()).toEqual([(await resolvePipeIdentity()).user])
    }
  })

  it.runIf(windows)('refuses a client the policy does not name, so the DACL is enforced, not decorative', async () => {
    const target = uniquePipe()
    const server = net.createServer(connection => connection.destroy())

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(target.path, resolve)
    })

    try {
      // A SID this token does not hold: whatever the implicit DACL said, only that principal may open
      // the pipe now. The read-back inside `hardenControlPipe` proved the DACL is the one asked for;
      // this proves the platform enforces it — our own same-session client is turned away.
      await hardenControlPipe(target.path, ['S-1-5-21-1-2-3-1001'])

      const error = await new Promise<string | null>(resolve => {
        const client = net.connect(target.path, () => {
          client.destroy()
          resolve(null)
        })

        client.once('error', failure => resolve(failure.message))
      })

      expect(error).toMatch(/EACCES|EPERM|access is denied/i)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it.runIf(windows)('applies the account-only fallback when the token carries no logon SID', async () => {
    const target = uniquePipe()
    const server = net.createServer(connection => {
      connection.setEncoding('utf8')
      connection.on('data', () => connection.write('{"ok":true}\n'))
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(target.path, resolve)
    })

    try {
      const identity = await resolvePipeIdentity()
      // A non-interactive or service token has no logon SID: the policy then names the account and
      // cannot separate one session from another. It must still apply, verify, and admit its client.
      const principals = pipePrincipalsFor({ user: identity.user, logon: null })
      const applied = await hardenControlPipe(target.path, principals)

      expect(isLogonSid(identity.user)).toBe(false)
      expect(applied).not.toMatch(/;;;AN\)/)
      expect(() => assertPipeDacl(applied, controlPipeSddl(principals))).not.toThrow()

      const answer = await new Promise<string>((resolve, reject) => {
        const client = net.connect(target.path, () => client.write('{"cmd":"ui"}\n'))
        client.setEncoding('utf8')
        client.once('data', chunk => {
          client.end()
          resolve(String(chunk))
        })
        client.once('error', reject)
      })

      expect(answer.trim()).toBe('{"ok":true}')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    // Several real PowerShell round trips (identity, DACL set and read back): over 5 s on a busy CI runner.
  }, 30_000)
})
