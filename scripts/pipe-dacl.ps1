# Reads (and, on request, replaces) the DACL of a named pipe that already exists.
#
# The app creates its pipe with Node's `net` module (see apps/desktop/electron/shell/os-control.ts),
# which passes no security descriptor, so the pipe's ACL is whatever the creating process token's
# default DACL produces. This script asks the kernel what that actually is, from a client handle:
# CreateFileW on the pipe, then GetSecurityInfo(SE_KERNEL_OBJECT, OWNER|GROUP|DACL) and
# ConvertSecurityDescriptorToStringSecurityDescriptorW.
#
# `-ApplySddl` is an experiment switch: it rewrites the DACL of one pipe instance so a probe can
# measure whether hardening an instance survives the server's next accept. Never point it at a live
# endpoint: scripts/probe-pipe-acl.mjs owns its own throwaway pipe for exactly this reason.
#
# Usage:
#   pwsh -NoProfile -File scripts/pipe-dacl.ps1 -PipeName herald-os-0123456789abcdef
#   pwsh -NoProfile -File scripts/pipe-dacl.ps1 -PipeName herald-probe-0123 -ApplySddl "D:(A;;FA;;;SY)(A;;FA;;;S-1-5-21-...-1003)"
#   pwsh -NoProfile -File scripts/pipe-dacl.ps1 -Identity        # the SIDs an SDDL would need

# `-CreateInstance` is the squatting experiment: try to create another instance of a pipe name that
# already exists, exactly as a hostile local process would, without touching the app.
#   -FirstInstance adds FILE_FLAG_FIRST_PIPE_INSTANCE (libuv's flag, which a second claimant cannot use).
param(
  [Parameter(Mandatory = $false)][string]$PipeName,
  [string]$ApplySddl,
  [switch]$Identity,
  [switch]$CreateInstance,
  [switch]$FirstInstance
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HeraldPipeAcl {
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, IntPtr attributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}
'@

if ($Identity) {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $logon = ($me.Groups | Where-Object { $_.Value -match '^S-1-5-5-\d+-\d+$' } | Select-Object -First 1)
  Write-Output "USER $($me.User.Value)"
  Write-Output "LOGON $($logon.Value)"
  exit 0
}

if (-not $PipeName) {
  Write-Output 'NO_PIPE_NAME'
  exit 1
}

if ($CreateInstance) {
  # A hostile local process would do exactly this: claim another instance of the app's pipe name.
  # PIPE_ACCESS_DUPLEX = 3, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT = 0, unlimited instances.
  $openMode = [uint32]3
  if ($FirstInstance) { $openMode = $openMode -bor [uint32]1048576 }
  $pipe = [HeraldPipeAcl]::CreateNamedPipeW("\\.\pipe\$PipeName", $openMode, [uint32]0, [uint32]255, [uint32]4096, [uint32]4096, [uint32]0, [IntPtr]::Zero)

  if ($pipe -eq [IntPtr]::new(-1)) {
    Write-Output "CREATE_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 1
  }

  Write-Output 'CREATED'
  [void][HeraldPipeAcl]::CloseHandle($pipe)
  exit 0
}

# GENERIC_READ (0x80000000) includes READ_CONTROL, which GetSecurityInfo needs. OPEN_EXISTING = 3.
# The cast matters: Windows PowerShell reads 0x80000000 as a negative Int32 and refuses to pass it
# to a UInt32 parameter. When a DACL is being replaced, WRITE_DAC (0x40000) is needed as well.
$access = [uint32]2147483648
if ($ApplySddl) { $access = $access -bor [uint32]262144 }
$handle = [HeraldPipeAcl]::CreateFileW("\\.\pipe\$PipeName", $access, [uint32]0, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)

if ($handle -eq [IntPtr]::new(-1)) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output "OPEN_FAILED win32=$code"
    exit 1
}

try {
    if ($ApplySddl) {
        $new = [IntPtr]::Zero
        $length = 0
        # SDDL_REVISION_1 = 1.
        $ok = [HeraldPipeAcl]::ConvertStringSecurityDescriptorToSecurityDescriptorW($ApplySddl, 1, [ref]$new, [ref]$length)

        if (-not $ok) {
            Write-Output "SDDL_PARSE_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            exit 1
        }

        try {
            # SetSecurityInfo wants a pointer to the ACL, not to the descriptor that carries it.
            # Passing the descriptor is what ERROR_INVALID_ACL (1336) means.
            $present = $false
            $acl = [IntPtr]::Zero
            $defaulted = $false
            $got = [HeraldPipeAcl]::GetSecurityDescriptorDacl($new, [ref]$present, [ref]$acl, [ref]$defaulted)

            if (-not $got -or -not $present -or $acl -eq [IntPtr]::Zero) {
                Write-Output "NO_DACL_IN_SDDL win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
                exit 1
            }

            # SE_KERNEL_OBJECT = 6, DACL_SECURITY_INFORMATION = 4, PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000.
            $code = [HeraldPipeAcl]::SetSecurityInfo($handle, 6, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $acl, [IntPtr]::Zero)

            if ($code -ne 0) {
                Write-Output "SETSECURITY_FAILED win32=$code"
                exit 1
            }
        } finally {
            [void][HeraldPipeAcl]::LocalFree($new)
        }
    }

    $owner = [IntPtr]::Zero
    $group = [IntPtr]::Zero
    $dacl = [IntPtr]::Zero
    $descriptor = [IntPtr]::Zero
    # SE_KERNEL_OBJECT = 6, OWNER (1) | GROUP (2) | DACL (4).
    $result = [HeraldPipeAcl]::GetSecurityInfo($handle, 6, 7, [ref]$owner, [ref]$group, [ref]$dacl, [IntPtr]::Zero, [ref]$descriptor)

    if ($result -ne 0) {
        Write-Output "GETSECURITY_FAILED win32=$result"
        exit 1
    }

    try {
        $text = [IntPtr]::Zero
        $length = 0
        # SDDL_REVISION_1 = 1, OWNER | GROUP | DACL.
        $ok = [HeraldPipeAcl]::ConvertSecurityDescriptorToStringSecurityDescriptorW($descriptor, 1, 7, [ref]$text, [ref]$length)

        if (-not $ok) {
            Write-Output "SDDL_FAILED win32=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            exit 1
        }

        try {
            $sddl = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($text)
            Write-Output "$(if ($ApplySddl) { 'DACL_AFTER_SET' } else { 'SDDL' }) $sddl"
        } finally {
            [void][HeraldPipeAcl]::LocalFree($text)
        }
    } finally {
        [void][HeraldPipeAcl]::LocalFree($descriptor)
    }
} finally {
    [void][HeraldPipeAcl]::CloseHandle($handle)
}
