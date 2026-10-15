/**
 * The access policy of the Windows control pipe (R3.1).
 *
 * `net.createServer().listen('\\\\.\\pipe\\name')` creates its pipe with no security descriptor, so
 * Windows gives the object the creating token's *default* DACL. `scripts/probe-pipe-acl.mjs` measured
 * what that is on a real machine — `Everyone` and `ANONYMOUS LOGON` were granted read, on top of
 * SYSTEM, Administrators and the user:
 *
 *   D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)
 *
 * Node cannot hand `CreateNamedPipe` a `SECURITY_ATTRIBUTES`, so this module does the two things
 * Node leaves out, and refuses rather than guess:
 *
 *   - `resolvePipePrincipals()` asks the token which principals the ACEs may name: the logon SID of
 *     this session when the token carries one, and the user otherwise. A logon SID is what separates
 *     "a process in the session the person is using" from "any process holding this user's
 *     credentials" — a network logon gets a different one.
 *   - `hardenControlPipe()` opens the pipe with `WRITE_DAC`, replaces the DACL with a protected one
 *     naming exactly those SIDs, reads the object's DACL back, and fails if what came back is not
 *     what was asked for. The caller (`os-control.ts`) treats a failure as "do not serve": a door
 *     whose access policy cannot be stated is not opened.
 *
 * What is deliberately *not* in the DACL: `Everyone` (WD), `ANONYMOUS LOGON` (AN), `SYSTEM` (SY) and
 * `Administrators` (BA). SYSTEM already owns the machine and an administrator can take ownership of
 * any object, so an ACE for them would only widen the list of processes that can reach the pipe
 * without the token.
 *
 * `FRFW` (generic read and generic write) is the smallest grant a client needs to speak JSON lines
 * and the server needs to keep accepting them: on a pipe the `FILE_APPEND_DATA` bit of generic write
 * *is* `FILE_CREATE_PIPE_INSTANCE` (both 0x4), which libuv requires for each further instance of its
 * own pipe. `FILE_FLAG_FIRST_PIPE_INSTANCE`, which libuv already passes, keeps its job of denying a
 * hostile process that tries to claim the name *before* the shell does.
 *
 * Nothing here is a credential: the pipe still needs the per-run token, which a client can only
 * learn from the 0600 file the shell writes or from the environment of the backend it starts itself.
 */

import { encodePowerShell } from '../platform/windows-parse.ts'
import { run } from '../platform/exec.ts'

/** A SID as SDDL spells it (the user's, a logon SID, …): never a name and never a wildcard. */
const SID = /^S-\d+(?:-\d+)+$/

/** The principals an ACE of this module must never name, whatever a caller passes. */
const FORBIDDEN: ReadonlySet<string> = new Set([
  'AO', 'AU', 'BG', 'BO', 'BU', 'CA', 'CD', 'CO', 'DA', 'DC', 'DD', 'DG', 'DU', 'EA', 'ED', 'WD',
  'AN', 'SY', 'BA', 'AC', 'IU', 'LA', 'LG', 'NO', 'NU', 'PA', 'PO', 'PS', 'RD', 'RE', 'RC', 'RO',
  'RU', 'SA', 'SI', 'SO', 'SU', 'IS', 'MU', 'CY', 'OW', 'WR', 'ER', 'VR',
  // The same principals spelled out, so a caller cannot pass a raw SID past the check above.
  'S-1-0-0', 'S-1-1-0', 'S-1-2-0', 'S-1-3-0', 'S-1-5-2', 'S-1-5-7', 'S-1-5-11', 'S-1-5-18',
  'S-1-5-32-544', 'S-1-5-32-545', 'S-1-5-32-546', 'S-1-5-32-547', 'S-1-5-32-555', 'S-1-5-32-562',
  'S-1-16-0', 'S-1-16-4096', 'S-1-16-8192', 'S-1-16-12288', 'S-1-16-16384',
])

/**
 * What a client needs to talk to the pipe and the server needs to keep accepting instances:
 * generic read (`FILE_GENERIC_READ`) and generic write, whose `0x4` bit is
 * `FILE_CREATE_PIPE_INSTANCE` on a pipe — libuv creates one instance per pending connection.
 */
export const PIPE_ACE_RIGHTS = 'FRFW'

/**
 * The SDDL masks this module can write, as the platform reports them back. Windows answers with the
 * numeric value (`0x12019f`), so a read-back is compared through this map rather than by text.
 */
const NAMED_MASKS: Readonly<Record<string, number>> = {
  FA: 0x1f01ff,
  FR: 0x120089,
  FW: 0x120116,
  FX: 0x1200a9,
  FRFW: 0x12019f,
}

/** A refused pipe policy: the pipe is not served when this escapes `hardenControlPipe`. */
export class PipeSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipeSecurityError'
  }
}

/**
 * The SDDL for a protected DACL naming exactly these SIDs. Order is fixed (sorted) so two calls with
 * the same principals produce the same string and the read-back can be compared to it.
 */
export function controlPipeSddl(sids: readonly string[]): string {
  const unique = [...new Set(sids.map(sid => String(sid).trim()))].sort()

  if (unique.length === 0) {
    throw new PipeSecurityError('a pipe DACL needs at least one principal')
  }

  for (const sid of unique) {
    if (!SID.test(sid)) {
      throw new PipeSecurityError(`not a SID: ${sid}`)
    }

    if (FORBIDDEN.has(sid)) {
      throw new PipeSecurityError(`refusing to grant the control pipe to a broad principal: ${sid}`)
    }
  }

  return `D:P${unique.map(sid => `(A;;${PIPE_ACE_RIGHTS};;;${sid})`).join('')}`
}

/**
 * The principals to name for one token: the session's logon SID when it has one, its user otherwise.
 * A token without a logon SID is what a service or network logon looks like; there the user's own SID
 * is the only principal the pipe can name.
 */
export function pipePrincipalsFor(identity: { user: string; logon: string | null }): string[] {
  const logon = identity.logon?.trim() ?? ''
  const user = identity.user.trim()

  if (logon && SID.test(logon)) {
    return [logon]
  }

  if (!user || !SID.test(user)) {
    throw new PipeSecurityError('the current token has no SID to name in the pipe DACL')
  }

  return [user]
}

/** The two lines the identity script prints, parsed; the logon SID is `null` when absent. */
export function parseIdentity(stdout: string): { user: string; logon: string | null } {
  let user = ''
  let logon: string | null = null

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(USER|LOGON) (\S*)$/.exec(line.trim())

    if (!match) {
      continue
    }

    if (match[1] === 'USER') {
      user = match[2]
    } else {
      logon = match[2] || null
    }
  }

  if (!user) {
    throw new PipeSecurityError('could not read the current token: no USER line came back')
  }

  return { user, logon }
}

/** The lines a read-back script prints for one marker: every read-back shares this shape. */
type ReadbackMarker = 'DACL_AFTER_SET' | 'SDDL' | 'TOKEN_DEFAULT_DACL'

/** The SDDL the read-back printed, or `null` when the script reported a failure instead. */
export function parseReadback(stdout: string, marker: ReadbackMarker): string | null {
  const match = new RegExp(`^${marker} (.+)$`, 'm').exec(stdout)

  return match ? match[1].trim() : null
}

/**
 * The read-back must be exactly the DACL that was asked for: same count, same ACEs, protected. An
 * extra ACE — `Everyone`, or anything else the platform or a third party added — is a failure, not a
 * warning, because the whole point of the exercise is that the policy is the one stated.
 *
 * The platform answers in numeric masks (`0x12019f`) where the request was written with the SDDL
 * abbreviations (`FRFW`); both are canonicalised so the comparison is about rights, not spelling.
 */
export function assertPipeDacl(sddl: string, expected: string): void {
  const start = sddl.indexOf('D:')
  const dacl = start === -1 ? '' : sddl.slice(start)

  if (!dacl.startsWith('D:P')) {
    throw new PipeSecurityError(`the pipe DACL is not protected: ${sddl}`)
  }

  const wanted = pipeAceSet(expected)

  if (wanted.length === 0) {
    throw new PipeSecurityError(`the requested DACL names nobody: ${expected}`)
  }

  const aces = pipeAceSet(dacl)

  for (const ace of wanted) {
    if (!aces.includes(ace)) {
      throw new PipeSecurityError(`the pipe DACL is missing ${ace}: ${sddl}`)
    }
  }

  if (aces.length !== wanted.length) {
    const extra = aces.filter(ace => !wanted.includes(ace))

    throw new PipeSecurityError(`the pipe DACL has more than the requested principals (${extra.join(', ') || 'duplicates'}): ${sddl}`)
  }
}

/** The ACEs of a DACL, as `mask;;;sid`, sorted; named masks are replaced by their numeric value. */
export function pipeAceSet(sddl: string): string[] {
  return [...sddl.matchAll(/\(A+;;([^;]*);;;([^)]+)\)/g)]
    .map(match => `${canonicalMask(match[1])};;;${match[2]}`)
    .sort()
}

/**
 * True when this SID names one interactive logon session (`S-1-5-5-<type>-<id>`) rather than an
 * account. The distinction is what a pipe DACL can and cannot express: a session SID separates a
 * process in the session the person is using from any process holding the same user's credentials,
 * an account SID does not.
 */
export function isLogonSid(sid: string): boolean {
  return /^S-1-5-5-\d+-\d+$/.test(sid.trim())
}

/**
 * The session SID a token default DACL names, when it names exactly one. Windows writes the logon SID
 * into an interactive token's default DACL, so this is a second, more reliable place to find the
 * session than the group enumeration — measured on this machine, where the enumeration came back empty
 * and the default DACL still named `S-1-5-5-0-457057` (R3.2).
 */
export function logonSidFromDefaultDacl(sddl: string): string | null {
  const logons = new Set(
    pipeAceSet(sddl)
      .map(ace => ace.split(';;;')[1] ?? '')
      .filter(sid => isLogonSid(sid)),
  )

  return logons.size === 1 ? [...logons][0] : null
}

/** `FRFW` and `0x12019f` name the same access; compare them as one. */
function canonicalMask(mask: string): string {
  const text = mask.trim()
  const named = NAMED_MASKS[text.toUpperCase()]

  if (named !== undefined) {
    return `0x${named.toString(16)}`
  }

  const numeric = /^0x([0-9a-f]+)$/i.exec(text)

  return numeric ? `0x${Number.parseInt(numeric[1], 16).toString(16)}` : text
}

/** A single-quoted PowerShell string; the values here are a pipe name and an SDDL we built. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The P/Invoke surface the two scripts need, kept identical to the measured `scripts/pipe-dacl.ps1`. */
const INTEROP = `using System;
using System.Runtime.InteropServices;

public static class HeraldPipeSecurity {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint GetSecurityInfo(IntPtr handle, uint objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint SetSecurityInfo(IntPtr handle, uint objectType, uint securityInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint securityInfo, out IntPtr text, out uint length);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint length);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}`

/** `-Identity` from `scripts/pipe-dacl.ps1`: the SIDs an ACE would have to name on this token. */
export function identityScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    INTEROP,
    "'@",
    '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    "$logon = ($me.Groups | Where-Object { $_.Value -match '^S-1-5-5-\\d+-\\d+$' } | Select-Object -First 1)",
    'Write-Output "USER $($me.User.Value)"',
    'if ($logon) { Write-Output "LOGON $($logon.Value)" } else { Write-Output "LOGON " }',
    '',
  ].join('\n')
}

/**
 * Opens the pipe with `WRITE_DAC` and replaces its DACL with a protected one naming `sddl`, then
 * reads the same object's DACL back and prints it as `DACL_AFTER_SET <sddl>`.
 */
export function hardenScript(pipePath: string, sddl: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    INTEROP,
    "'@",
    `$pipe = ${literal(pipePath)}`,
    `$sddl = ${literal(sddl)}`,
    '# GENERIC_READ (0x80000000, which carries READ_CONTROL) | WRITE_DAC (0x40000); OPEN_EXISTING = 3.',
    '$access = [uint32]2147483648 -bor [uint32]262144',
    '$handle = [HeraldPipeSecurity]::CreateFileW($pipe, $access, [uint32]0, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)',
    'if ($handle -eq [IntPtr]::new(-1)) { Write-Output "OPEN_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    'try {',
    '  $new = [IntPtr]::Zero',
    '  $length = 0',
    '  # SDDL_REVISION_1 = 1.',
    '  if (-not [HeraldPipeSecurity]::ConvertStringSecurityDescriptorToSecurityDescriptorW($sddl, 1, [ref]$new, [ref]$length)) { Write-Output "SDDL_PARSE_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    '  try {',
    '    # SetSecurityInfo wants the ACL, not the descriptor that carries it.',
    '    $present = $false',
    '    $acl = [IntPtr]::Zero',
    '    $defaulted = $false',
    '    if (-not [HeraldPipeSecurity]::GetSecurityDescriptorDacl($new, [ref]$present, [ref]$acl, [ref]$defaulted) -or -not $present -or $acl -eq [IntPtr]::Zero) { Write-Output "NO_DACL_IN_SDDL win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    '    # SE_KERNEL_OBJECT = 6; DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION = 2147483652.',
    '    $code = [HeraldPipeSecurity]::SetSecurityInfo($handle, 6, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $acl, [IntPtr]::Zero)',
    '    if ($code -ne 0) { Write-Output "SETSECURITY_FAILED win32=$code"; exit 1 }',
    '  } finally { [void][HeraldPipeSecurity]::LocalFree($new) }',
    ...readBackBody('DACL_AFTER_SET'),
    '} finally { [void][HeraldPipeSecurity]::CloseHandle($handle) }',
    '',
  ].join('\n')
}

/** Reads the DACL of an existing pipe without changing it, as `SDDL <sddl>`. */
export function readScript(pipePath: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    INTEROP,
    "'@",
    `$pipe = ${literal(pipePath)}`,
    '$handle = [HeraldPipeSecurity]::CreateFileW($pipe, [uint32]2147483648, [uint32]0, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)',
    'if ($handle -eq [IntPtr]::new(-1)) { Write-Output "OPEN_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    'try {',
    ...readBackBody('SDDL'),
    '} finally { [void][HeraldPipeSecurity]::CloseHandle($handle) }',
    '',
  ].join('\n')
}

/** The shared tail of both scripts: `GetSecurityInfo` plus `ConvertSecurityDescriptorToStringSecurityDescriptorW`. */
function readBackBody(marker: ReadbackMarker): string[] {
  return [
    '  $owner = [IntPtr]::Zero',
    '  $group = [IntPtr]::Zero',
    '  $held = [IntPtr]::Zero',
    '  $descriptor = [IntPtr]::Zero',
    '  # SE_KERNEL_OBJECT = 6; OWNER (1) | GROUP (2) | DACL (4).',
    '  $result = [HeraldPipeSecurity]::GetSecurityInfo($handle, 6, 7, [ref]$owner, [ref]$group, [ref]$held, [IntPtr]::Zero, [ref]$descriptor)',
    '  if ($result -ne 0) { Write-Output "GETSECURITY_FAILED win32=$result"; exit 1 }',
    '  try {',
    '    $text = [IntPtr]::Zero',
    '    $textLength = 0',
    '    if (-not [HeraldPipeSecurity]::ConvertSecurityDescriptorToStringSecurityDescriptorW($descriptor, 1, 7, [ref]$text, [ref]$textLength)) { Write-Output "SDDL_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    '    try { Write-Output "' + marker + ' $([System.Runtime.InteropServices.Marshal]::PtrToStringUni($text))" } finally { [void][HeraldPipeSecurity]::LocalFree($text) }',
    '  } finally { [void][HeraldPipeSecurity]::LocalFree($descriptor) }',
  ]
}

/**
 * The P/Invoke surface for reading the creating token's *default* DACL. It is a measurement tool, not
 * part of the policy: `pipe-security.test.ts` uses it to show that a pipe `net` creates carries that
 * DACL rather than the one this shell asks for, which is what "Node cannot pass a security
 * descriptor at creation" means concretely.
 */
const TOKEN_INTEROP = `using System;
using System.Runtime.InteropServices;

public static class HeraldTokenSecurity {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool InitializeSecurityDescriptor(IntPtr descriptor, uint revision);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetSecurityDescriptorDacl(IntPtr descriptor, bool present, IntPtr dacl, bool defaulted);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint securityInfo, out IntPtr text, out uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}`

/** Prints the creating token's default DACL as `TOKEN_DEFAULT_DACL <sddl>`, or an empty value. */
export function tokenDefaultDaclScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    TOKEN_INTEROP,
    "'@",
    '# TOKEN_QUERY = 8; TokenDefaultDacl = 6 (one pointer).',
    '$token = [IntPtr]::Zero',
    'if (-not [HeraldTokenSecurity]::OpenProcessToken([HeraldTokenSecurity]::GetCurrentProcess(), [uint32]8, [ref]$token)) { Write-Output "OPENTOKEN_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    'try {',
    '  # The documented two-call shape: ask for the length first, then for the value.',
    '  $need = 0',
    '  [void][HeraldTokenSecurity]::GetTokenInformation($token, 6, [IntPtr]::Zero, 0, [ref]$need)',
    '  if ($need -le 0) { $need = 8 }',
    '  $info = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($need)',
    '  try {',
    '    $returned = 0',
    '    if (-not [HeraldTokenSecurity]::GetTokenInformation($token, 6, $info, $need, [ref]$returned)) { Write-Output "GETTOKENINFO_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) need=$need"; exit 1 }',
    '    $dacl = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($info)',
    '    if ($dacl -eq [IntPtr]::Zero) { Write-Output "TOKEN_DEFAULT_DACL "; exit 0 }',
    '    $descriptor = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(40)',
    '    try {',
    '      # SECURITY_DESCRIPTOR_REVISION = 1; a SECURITY_DESCRIPTOR is 20 bytes, 40 is a safe buffer.',
    '      if (-not [HeraldTokenSecurity]::InitializeSecurityDescriptor($descriptor, 1)) { Write-Output "INITSD_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    '      if (-not [HeraldTokenSecurity]::SetSecurityDescriptorDacl($descriptor, $true, $dacl, $false)) { Write-Output "SETSDDACL_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    '      $text = [IntPtr]::Zero',
    '      $textLength = 0',
    '      # SDDL_REVISION_1 = 1; DACL_SECURITY_INFORMATION = 4.',
    '      if (-not [HeraldTokenSecurity]::ConvertSecurityDescriptorToStringSecurityDescriptorW($descriptor, 1, 4, [ref]$text, [ref]$textLength)) { Write-Output "SDDL_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }',
    '      try { Write-Output "TOKEN_DEFAULT_DACL $([System.Runtime.InteropServices.Marshal]::PtrToStringUni($text))" } finally { [void][HeraldTokenSecurity]::LocalFree($text) }',
    '    } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($descriptor) }',
    '  } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($info) }',
    '} finally { [void][HeraldTokenSecurity]::CloseHandle($token) }',
    '',
  ].join('\n')
}

/** Runs one script through the system's PowerShell, without ever putting a secret in argv or a log. */
async function powershell(script: string, timeoutMs = 20_000): Promise<string> {
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
    timeoutMs
  )

  if (result.code !== 0) {
    const reported = /^[A-Z_]+ .*$/m.exec(result.stdout)?.[0] ?? result.stderr.trim().split(/\r?\n/)[0] ?? 'no output'
    throw new PipeSecurityError(`powershell exited ${result.code}: ${reported.slice(0, 200)}`)
  }

  return result.stdout
}

let cachedPrincipals: string[] | null = null

/** The SIDs of the current token as the identity script reports them, uncached (one PowerShell run). */
export async function resolvePipeIdentity(): Promise<{ user: string; logon: string | null }> {
  if (process.platform !== 'win32') {
    throw new PipeSecurityError(`named pipe security is a Windows concern, not ${process.platform}`)
  }

  return parseIdentity(await powershell(identityScript()))
}

/**
 * The SIDs this process may grant the pipe to, resolved once per process. On anything but Windows
 * there is no named pipe to harden, and asking would be a category error.
 */
export async function resolvePipePrincipals(): Promise<string[]> {
  if (process.platform !== 'win32') {
    throw new PipeSecurityError(`named pipe security is a Windows concern, not ${process.platform}`)
  }

  if (!cachedPrincipals) {
    const identity = await resolvePipeIdentity()

    // The group enumeration does not always surface the session, but the token default DACL does: an
    // interactive token is built with its logon SID in there. Prefer it, so the pipe can name one
    // session instead of every process of the account.
    if (!identity.logon) {
      const defaultDacl = await readTokenDefaultDacl()
      const logon = defaultDacl ? logonSidFromDefaultDacl(defaultDacl) : null

      if (logon) {
        identity.logon = logon
      }
    }

    cachedPrincipals = pipePrincipalsFor(identity)
  }

  return [...cachedPrincipals]
}

/**
 * Replaces the pipe's DACL with the one `controlPipeSddl(principals)` spells, and returns that SDDL
 * only after reading it back off the live object. Any failure — no PowerShell, a refused
 * `SetSecurityInfo`, a read-back that names more principals than were asked for — throws, and the
 * caller must not serve the door.
 */
export async function hardenControlPipe(pipePath: string, principals: readonly string[]): Promise<string> {
  if (process.platform !== 'win32') {
    throw new PipeSecurityError(`named pipe security is a Windows concern, not ${process.platform}`)
  }

  const expected = controlPipeSddl(principals)
  const stdout = await powershell(hardenScript(pipePath, expected))
  const applied = parseReadback(stdout, 'DACL_AFTER_SET')

  if (!applied) {
    const reported = /^[A-Z_]+ .*$/m.exec(stdout)?.[0] ?? 'no SDDL came back'
    throw new PipeSecurityError(`the pipe DACL could not be applied: ${reported.slice(0, 200)}`)
  }

  assertPipeDacl(applied, expected)

  return applied
}

/** The live DACL of one pipe, for tests and for anybody measuring what the shell actually created. */
export async function readControlPipeDacl(pipePath: string): Promise<string> {
  const stdout = await powershell(readScript(pipePath))
  const sddl = parseReadback(stdout, 'SDDL')

  if (!sddl) {
    const reported = /^[A-Z_]+ .*$/m.exec(stdout)?.[0] ?? 'no SDDL came back'
    throw new PipeSecurityError(`the pipe DACL could not be read: ${reported.slice(0, 200)}`)
  }

  return sddl
}

/**
 * The creating token's default DACL, as SDDL, or `null` when the token carries none. This is what
 * Windows gives an object whose creator passed no security descriptor — the measurement that shows a
 * pipe created by `net` inherits the platform's default rather than a policy of ours.
 */
export async function readTokenDefaultDacl(): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new PipeSecurityError(`token default DACL is a Windows concern, not ${process.platform}`)
  }

  const stdout = await powershell(tokenDefaultDaclScript())
  const sddl = parseReadback(stdout, 'TOKEN_DEFAULT_DACL')

  if (sddl === null) {
    const reported = /^[A-Z_]+ .*$/m.exec(stdout)?.[0] ?? 'no SDDL came back'
    throw new PipeSecurityError(`the token default DACL could not be read: ${reported.slice(0, 200)}`)
  }

  return sddl.trim() === '' ? null : sddl
}

/** For tests that resolve identities more than once in one process. */
export function forgetPipePrincipals(): void {
  cachedPrincipals = null
}
