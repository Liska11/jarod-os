// Outils système, phase 2 (actions réversibles) : les scripts PowerShell qui LISENT ou CHANGENT l'état de la machine. Repris de `winps.py`
// de Herald OS (MIT, voir licenses/HERALD-OS.md) : AUDIO, APPEARANCE, SET_DARK_MODE, TOAST, STOP_PROCESS. APP_PATH est nouveau.
// Les arguments arrivent dans `$A` (JSON de l'environnement), jamais dans le texte du script.

/** Volume du périphérique par défaut, lu et (si percent / muted sont donnés) écrit : COM `IAudioEndpointVolume`. Windows n'a pas de cmdlet. */
export const AUDIO = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace JarodOs {
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
  if (-not [JarodOs.Audio]::Set(0, $percent, $mute)) { throw 'No audio output device is available.' }
}
[pscustomobject]@{ output = [JarodOs.Audio]::Get(0); input = [JarodOs.Audio]::Get(1) } | ConvertTo-Json -Compress
`;

/** Mode sombre (applications et système) et écrans. */
export const APPEARANCE = String.raw`
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$apps = (Get-ItemProperty -Path $key -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
$system = (Get-ItemProperty -Path $key -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace JarodOs -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][JarodOs.Dpi]::SetProcessDPIAware()
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.DeviceName; width = [int]$_.Bounds.Width; height = [int]$_.Bounds.Height; primary = [bool]$_.Primary } })
[pscustomobject]@{ apps_light = $apps; system_light = $system; screens = $screens } | ConvertTo-Json -Compress -Depth 4
`;

/** Bascule le mode sombre (registre) puis prévient les fenêtres ouvertes (`ImmersiveColorSet`). */
export const SET_DARK_MODE = String.raw`
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$value = 1
if ($A.enabled) { $value = 0 }
Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value $value -Type DWord
Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value $value -Type DWord
Add-Type -Namespace JarodOs -Name Broadcast -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
$r = [UIntPtr]::Zero
[void][JarodOs.Broadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 5000, [ref]$r)
'{}'
`;

/** Notification de bureau (toast WinRT) sous l'identité de PowerShell ; le titre et le texte sont échappés en XML. */
export const TOAST = String.raw`
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$title = [System.Security.SecurityElement]::Escape([string]$A.title)
$body = [System.Security.SecurityElement]::Escape([string]$A.body)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
'{}'
`;

/** Éteint les écrans (WM_SYSCOMMAND / SC_MONITORPOWER = 2), posté : une fenêtre figée ne doit pas bloquer l'appel. */
export const SLEEP_DISPLAY = String.raw`
Add-Type -Namespace JarodOs -Name Display -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam);'
if (-not [JarodOs.Display]::PostMessageW([IntPtr]0xFFFF, 0x0112, [UIntPtr]0xF170, [IntPtr]2)) { throw 'could not sleep the display' }
'{}'
`;

/**
 * Ferme poliment la fenêtre principale d'un processus déjà identifié (`CloseMainWindow`), sans le tuer. Le premier mot de l'erreur dit ce qui s'est
 * passé. Le pid peut avoir été réattribué entre l'identification et l'appel : le NOM attendu est vérifié, sinon CHANGED.
 */
export const CLOSE_WINDOW = String.raw`
$p = Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue
if (-not $p) { throw 'NOTFOUND' }
if ($A.name -and $p.ProcessName -ne [string]$A.name) { throw 'CHANGED' }
if (-not $p.CloseMainWindow()) { throw 'NOWINDOW' }
'{}'
`;

/** Arrête un processus déjà identifié, sans appel de politesse : perte du travail non enregistré. Même vérification d'identité que CLOSE_WINDOW. */
export const FORCE_KILL = String.raw`
$p = Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue
if (-not $p) { throw 'NOTFOUND' }
if ($A.name -and $p.ProcessName -ne [string]$A.name) { throw 'CHANGED' }
try { $p.Kill() } catch [System.ComponentModel.Win32Exception] { throw 'DENIED' }
'{}'
`;

/** Un processus par son pid : nom et chemin, ou null s'il n'existe pas (ou plus). */
export const PROC_INFO = String.raw`
$p = Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue
if (-not $p) { 'null' } else {
  $path = ''
  try { $path = [string]$p.Path } catch { }
  [pscustomobject]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; path = $path } | ConvertTo-Json -Compress
}
`;

/**
 * Envoie à la corbeille, JAMAIS de suppression définitive. Contrôles AVANT chaque élément, parce que l'API de la corbeille supprime pour de bon quand
 * elle ne peut pas recycler : disque fixe et local seulement, corbeille non désactivée (stratégie `NoRecycleFiles`, option `NukeOnDelete` du volume),
 * élément plus petit que la capacité réglée de la corbeille. Tout ce qui ne passe pas est rendu dans `errors`, rien n'est supprimé. L'option
 * `AllDialogs` laisse Windows poser sa propre question dans les cas que ces contrôles n'ont pas prévus : sans réponse, le délai de l'appelant
 * arrête le processus et l'opération est annulée.
 */
export const TRASH = String.raw`
Add-Type -AssemblyName Microsoft.VisualBasic
$bb = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket'
$policy = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer' -ErrorAction SilentlyContinue).NoRecycleFiles
$errors = @()
$done = @()
foreach ($path in @($A.paths)) {
  try {
    $full = [System.IO.Path]::GetFullPath([string]$path)
    $isDir = Test-Path -LiteralPath $full -PathType Container
    if (-not $isDir -and -not (Test-Path -LiteralPath $full -PathType Leaf)) { $errors += ($full + ': not found'); continue }
    if ($policy -eq 1) { $errors += ($full + ': the Recycle Bin is disabled by policy, it would be deleted for good'); continue }
    $root = [System.IO.Path]::GetPathRoot($full)
    if (-not $root -or $root.StartsWith('\\')) { $errors += ($full + ': not on a local drive, it would be deleted for good'); continue }
    if ((New-Object System.IO.DriveInfo($root)).DriveType -ne 'Fixed') { $errors += ($full + ': not on a fixed drive, it would be deleted for good'); continue }
    $vol = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $root.TrimEnd('\') + "'") -ErrorAction SilentlyContinue
    $guid = ''
    if ($vol) { $guid = [regex]::Match([string]$vol.DeviceID, '\{[0-9a-fA-F-]+\}').Value }
    if (-not $guid) { $errors += ($full + ': cannot verify the Recycle Bin settings of this drive'); continue }
    $props = Get-ItemProperty -LiteralPath ($bb + '\Volume\' + $guid) -ErrorAction SilentlyContinue
    if ($props -and $props.NukeOnDelete -eq 1) { $errors += ($full + ': the Recycle Bin is turned off for this drive, it would be deleted for good'); continue }
    if ($props -and $props.MaxCapacity) {
      $limit = [int64]$props.MaxCapacity * 1MB
      $size = 0L
      if ($isDir) {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        foreach ($f in [System.IO.Directory]::EnumerateFiles($full, '*', 'AllDirectories')) {
          $size += (New-Object System.IO.FileInfo($f)).Length
          if ($size -gt $limit) { break }
          if ($clock.Elapsed.TotalSeconds -gt 20) { throw 'too large to verify against the Recycle Bin capacity' }
        }
      } else { $size = (New-Object System.IO.FileInfo($full)).Length }
      if ($size -gt $limit) { $errors += ($full + ': larger than the Recycle Bin capacity, it would be deleted for good'); continue }
    }
    if ($isDir) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($full, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($full, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }
    $done += $full
  } catch {
    $errors += ([string]$path + ': ' + $_.Exception.Message)
  }
}
ConvertTo-Json -InputObject @{ trashed = @($done); errors = @($errors) } -Compress
`;

/** Un nom de programme (« notepad ») → son .exe par la clé « App Paths » du registre ; vide s'il n'y en a pas. */
export const APP_PATH = String.raw`
$stem = [string]$A.name
$out = ''
foreach ($hive in @('HKCU', 'HKLM')) {
  $v = (Get-ItemProperty -LiteralPath ($hive + ':\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $stem) -ErrorAction SilentlyContinue).'(default)'
  if ($v) { $v = ([string]$v).Trim('"'); if ($v.ToLower().EndsWith('.exe') -and (Test-Path -LiteralPath $v -PathType Leaf)) { $out = $v; break } }
}
ConvertTo-Json -InputObject @{ path = $out } -Compress
`;
