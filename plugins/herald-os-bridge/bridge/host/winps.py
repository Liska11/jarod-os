"""PowerShell plumbing for the Windows adapter: one runner and the scripts it runs.

Every script is passed with ``-EncodedCommand`` (no quoting to get wrong) and receives its arguments
as JSON in ``$env:JAROD_OS_ARGS``, parsed into ``$A``; user-supplied text is therefore never part of
the script source. Output is UTF-8 JSON (``ConvertTo-Json -Compress``) on stdout; a failure is one
plain line on stderr and exit code 1. Windows PowerShell 5.1 is used because every supported Windows
ships it."""

from __future__ import annotations

import base64
import json
import os
import shutil
from typing import Any, Mapping

from ..util import run

_PRELUDE = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$A = $null
if ($env:JAROD_OS_ARGS) { $A = $env:JAROD_OS_ARGS | ConvertFrom-Json }
try {
"""

_POSTLUDE = r"""
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
"""

# Command lines are capped at 32,767 characters and UTF-16 base64 is 2.7x the source.
_MAX_SCRIPT_CHARS = 11000


class PowerShellError(RuntimeError):
    """The script failed; the message is the one line it wrote to stderr."""


def powershell_exe() -> str | None:
    """Windows PowerShell by absolute path (not whatever ``PATH`` resolves first), or None."""
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    candidate = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return candidate if os.path.exists(candidate) else shutil.which("powershell.exe")


def build_argv(script: str, exe: str) -> list[str]:
    body = _PRELUDE + script + _POSTLUDE
    if len(body) > _MAX_SCRIPT_CHARS:
        raise ValueError(f"PowerShell script too long ({len(body)} characters)")
    encoded = base64.b64encode(body.encode("utf-16-le")).decode("ascii")
    return [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]


def ps_text(script: str, args: Mapping[str, Any] | None = None, *, timeout: float = 20.0) -> str:
    """Run ``script`` and return its stdout; raises ``PowerShellError`` on failure."""
    exe = powershell_exe()
    if exe is None:
        raise PowerShellError("Windows PowerShell was not found")
    env = {"JAROD_OS_ARGS": json.dumps(args, ensure_ascii=False)} if args is not None else {}
    result = run(build_argv(script, exe), timeout=timeout, env=env, encoding="utf-8")
    if result.code == 124:
        raise PowerShellError(f"PowerShell timed out after {timeout:g}s")
    if not result.ok:
        message = next((line.strip() for line in result.stderr.splitlines() if line.strip()), "") or f"PowerShell exited with {result.code}"
        raise PowerShellError(message)
    return result.stdout


def ps_json(script: str, args: Mapping[str, Any] | None = None, *, timeout: float = 20.0) -> Any:
    """Run ``script`` and parse its stdout as JSON (None when it printed nothing)."""
    text = ps_text(script, args, timeout=timeout).strip().lstrip("\ufeff")
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise PowerShellError(f"PowerShell returned malformed JSON: {exc}") from exc


def as_list(value: Any) -> list[Any]:
    """ConvertTo-Json writes one object where there is one element; normalise to a list."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


# --- scripts ---------------------------------------------------------------------------------

SYSTEM_INFO = r"""
$os = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor)
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{ mount = ($_.DeviceID + '\'); total_bytes = [int64]$_.Size; free_bytes = [int64]$_.FreeSpace } })
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$battery = $null
if ($bat) { $battery = [pscustomobject]@{ percent = [int]$bat.EstimatedChargeRemaining; status = [int]$bat.BatteryStatus } }
[pscustomobject]@{
  caption = [string]$os.Caption; version = [string]$os.Version; build = [string]$os.BuildNumber
  total_kb = [int64]$os.TotalVisibleMemorySize; free_kb = [int64]$os.FreePhysicalMemory
  uptime_seconds = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
  chip = [string]($cpu | Select-Object -First 1).Name
  logical = [int]($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum
  disks = $disks; battery = $battery
} | ConvertTo-Json -Compress -Depth 4
"""

# Two samples of the processes' cumulative CPU time half a second apart give a percentage; without
# `sample` the CPU column is zero and the call takes a fraction of the time.
PROCESSES = r"""
$before = @{}
$t0 = [DateTime]::UtcNow
if ($A.sample) {
  Get-CimInstance Win32_Process | ForEach-Object { $before[[int]$_.ProcessId] = [int64]$_.KernelModeTime + [int64]$_.UserModeTime }
  $t0 = [DateTime]::UtcNow
  Start-Sleep -Milliseconds 500
}
$procs = @(Get-CimInstance Win32_Process)
$seconds = ([DateTime]::UtcNow - $t0).TotalSeconds
if ($seconds -le 0) { $seconds = 1 }
$total = [int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$rows = @($procs | Where-Object { $_.ProcessId -ne 0 } | ForEach-Object {
  $id = [int]$_.ProcessId
  $cpu = 0.0
  if ($A.sample -and $before.ContainsKey($id)) {
    $cpu = ((([int64]$_.KernelModeTime + [int64]$_.UserModeTime) - $before[$id]) / 1e7) / $seconds * 100
  }
  [pscustomobject]@{ pid = $id; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; path = [string]$_.ExecutablePath; rss = [int64]$_.WorkingSetSize; cpu = [math]::Round($cpu, 1) }
})
[pscustomobject]@{ total_memory = $total; rows = $rows } | ConvertTo-Json -Compress -Depth 4
"""

OWNERS = r"""
$out = @(@($A.pids) | ForEach-Object {
  $id = [int]$_
  $user = ''
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    $o = $p | Invoke-CimMethod -MethodName GetOwner
    if ($o -and $o.User) { $user = [string]$o.User }
  } catch { }
  [pscustomobject]@{ pid = $id; user = $user }
})
ConvertTo-Json -InputObject $out -Compress
"""

LISTENERS = r"""
$port = [int]$A.port
$found = @()
$found += @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; protocol = 'tcp' } })
$found += @(Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; protocol = 'udp' } })
$out = @($found | Sort-Object pid, protocol -Unique | ForEach-Object {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.pid) -ErrorAction SilentlyContinue
  $user = ''
  try { $o = $p | Invoke-CimMethod -MethodName GetOwner; if ($o -and $o.User) { $user = [string]$o.User } } catch { }
  [pscustomobject]@{ pid = $_.pid; protocol = $_.protocol; name = [string]$p.Name; user = $user }
})
ConvertTo-Json -InputObject $out -Compress
"""

INSTALLED_APPS = r"""
$out = @(Get-StartApps | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; id = [string]$_.AppID } })
ConvertTo-Json -InputObject $out -Compress
"""

RUNNING_APPS = r"""
$out = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $desc = ''
  $path = ''
  try { $path = [string]$_.MainModule.FileName; $desc = [string]$_.MainModule.FileVersionInfo.FileDescription } catch { }
  [pscustomobject]@{ pid = [int]$_.Id; process = [string]$_.ProcessName; description = $desc; path = $path; title = [string]$_.MainWindowTitle }
})
ConvertTo-Json -InputObject $out -Compress
"""

# Stops a process the caller already identified by pid. Politely (close its main window) or, with
# force, outright. The first word of the error tells the caller what happened.
STOP_PROCESS = r"""
$p = Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue
if (-not $p) { throw 'NOTFOUND' }
if ($A.force) {
  try { $p.Kill() } catch [System.ComponentModel.Win32Exception] { throw 'DENIED' }
} else {
  if (-not $p.CloseMainWindow()) { throw 'NOWINDOW' }
}
'{}'
"""

NETWORK = r"""
$cfg = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.InterfaceAlias; description = [string]$_.InterfaceDescription
    ipv4 = [string]($_.IPv4Address | Select-Object -First 1).IPAddress
    gateway = [string]($_.IPv4DefaultGateway | Select-Object -First 1).NextHop
    dns = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { @($_.ServerAddresses) } | Select-Object -Unique)
  } })
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; mac = [string]$_.MacAddress; status = [string]$_.Status; media = [string]$_.PhysicalMediaType } })
$wlan = ''
try { $wlan = (netsh wlan show interfaces) -join "`n" } catch { }
[pscustomobject]@{ config = $cfg; adapters = $adapters; wlan = $wlan } | ConvertTo-Json -Compress -Depth 5
"""

BLUETOOTH = r"""
$devices = @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.FriendlyName; id = [string]$_.InstanceId; status = [string]$_.Status; present = [bool]$_.Present } })
ConvertTo-Json -InputObject $devices -Compress
"""

APPEARANCE = r"""
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$apps = (Get-ItemProperty -Path $key -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
$system = (Get-ItemProperty -Path $key -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace JarodOS -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][JarodOS.Dpi]::SetProcessDPIAware()
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.DeviceName; width = [int]$_.Bounds.Width; height = [int]$_.Bounds.Height; primary = [bool]$_.Primary } })
[pscustomobject]@{ apps_light = $apps; system_light = $system; screens = $screens } | ConvertTo-Json -Compress -Depth 4
"""

SET_DARK_MODE = r"""
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$value = 1
if ($A.enabled) { $value = 0 }
Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value $value -Type DWord
Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value $value -Type DWord
Add-Type -Namespace JarodOS -Name Broadcast -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
$r = [UIntPtr]::Zero
[void][JarodOS.Broadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 5000, [ref]$r)
'{}'
"""

# Windows has no volume cmdlet: the default endpoint's IAudioEndpointVolume through COM.
AUDIO = r"""
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace JarodOS {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int _0(); [PreserveSig] int _1(); [PreserveSig] int _2(); [PreserveSig] int _3();
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int _5();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int _7(); [PreserveSig] int _8(); [PreserveSig] int _9(); [PreserveSig] int _10();
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int _0();
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
  public static class Audio {
    static IAudioEndpointVolume Endpoint(int flow) {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      if (enumerator.GetDefaultAudioEndpoint(flow, 1, out device) != 0) return null;
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object endpoint;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out endpoint) != 0) return null;
      return (IAudioEndpointVolume)endpoint;
    }
    // "level|muted" for the default device of that flow (0 playback, 1 capture); empty when there is none.
    public static string Get(int flow) {
      var v = Endpoint(flow);
      if (v == null) return "";
      float level; bool muted;
      v.GetMasterVolumeLevelScalar(out level); v.GetMute(out muted);
      return ((int)Math.Round(level * 100)).ToString() + "|" + (muted ? "1" : "0");
    }
    public static bool Set(int flow, int percent, int mute) {
      var v = Endpoint(flow);
      if (v == null) return false;
      Guid ctx = Guid.Empty;
      if (percent >= 0) v.SetMasterVolumeLevelScalar(percent / 100f, ref ctx);
      if (mute >= 0) v.SetMute(mute == 1, ref ctx);
      return true;
    }
  }
}
'@
$percent = -1
$mute = -1
if ($null -ne $A) {
  if ($null -ne $A.percent) { $percent = [int]$A.percent }
  if ($null -ne $A.muted) { if ($A.muted) { $mute = 1 } else { $mute = 0 } }
}
if ($percent -ge 0 -or $mute -ge 0) {
  if (-not [JarodOS.Audio]::Set(0, $percent, $mute)) { throw 'No audio output device is available.' }
}
[pscustomobject]@{ output = [JarodOS.Audio]::Get(0); input = [JarodOS.Audio]::Get(1) } | ConvertTo-Json -Compress
"""

EVENT_LOG = r"""
$filter = @{ LogName = @('Application', 'System'); StartTime = (Get-Date).AddMinutes(-[int]$A.minutes) }
if ($A.levels -and @($A.levels).Count -gt 0) { $filter.Level = @($A.levels | ForEach-Object { [int]$_ }) }
$needle = [string]$A.process
$events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents 3000 -ErrorAction SilentlyContinue)
if ($needle) {
  $events = @($events | Where-Object { $_.ProviderName -like "*$needle*" -or ($_.Message -and $_.Message -like "*$needle*") })
}
$out = @($events | Select-Object -First ([int]$A.limit) | ForEach-Object {
  $first = ''
  if ($_.Message) { $first = ($_.Message -split "`r?`n")[0] }
  [pscustomobject]@{ time = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); level = [int]$_.Level; provider = [string]$_.ProviderName; message = $first }
})
ConvertTo-Json -InputObject $out -Compress
"""

# Event 1000 of "Application Error" is Windows Error Reporting's record of a crashed program.
CRASHES = r"""
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = (Get-Date).AddDays(-7) } -MaxEvents ([int]$A.limit) -ErrorAction SilentlyContinue)
$out = @($events | ForEach-Object {
  $p = @($_.Properties | ForEach-Object { [string]$_.Value })
  [pscustomobject]@{ record = [string]$_.RecordId; time = $_.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss'); app = $p[0]; version = $p[1]; module = $p[3]; code = $p[6] }
})
ConvertTo-Json -InputObject $out -Compress
"""

CRASH = r"""
$id = [int64]$A.record
$e = Get-WinEvent -LogName Application -FilterXPath "*[System[EventRecordID=$id]]" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $e) { throw "No crash record $id" }
$p = @($e.Properties | ForEach-Object { [string]$_.Value })
[pscustomobject]@{
  record = [string]$e.RecordId; time = $e.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss'); provider = [string]$e.ProviderName
  app = $p[0]; version = $p[1]; module = $p[3]; module_version = $p[4]; code = $p[6]; offset = $p[7]
  pid = $p[8]; app_path = $p[10]; module_path = $p[11]; message = [string]$e.Message
} | ConvertTo-Json -Compress
"""

# To the Recycle Bin, never a delete: the shell asks (and the call fails) where it would otherwise
# have to remove an item for good, such as one too large for the bin.
TRASH = r"""
Add-Type -AssemblyName Microsoft.VisualBasic
$errors = @()
foreach ($path in @($A.paths)) {
  try {
    if (Test-Path -LiteralPath $path -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'AllDialogs', 'SendToRecycleBin', 'ThrowException')
    } elseif (Test-Path -LiteralPath $path) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'AllDialogs', 'SendToRecycleBin', 'ThrowException')
    } else {
      $errors += ($path + ': not found')
    }
  } catch {
    $errors += ($path + ': ' + $_.Exception.Message)
  }
}
ConvertTo-Json -InputObject @{ errors = @($errors) } -Compress
"""

TOAST = r"""
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$title = [System.Security.SecurityElement]::Escape([string]$A.title)
$body = [System.Security.SecurityElement]::Escape([string]$A.body)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
'{}'
"""
