// Lot 4 (30/10) : scripts PowerShell des outils du quotidien repris de brahma-ai-evo (idées seulement, aucun code copié — licence sans
// redistribution). Les arguments arrivent en JSON dans `$A` (ps.ts) : aucun texte du modèle n'est collé dans un script.
// ATTENTION : ces scripts sont des `String.raw` — jamais d'accent grave ni de « dollar-accolade » dedans.

/** Presse-papiers : lire (texte seul). */
export const CLIPBOARD_GET = String.raw`
$t = Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue
if ($null -eq $t) { $t = '' }
ConvertTo-Json -InputObject @{ text = [string]$t } -Compress
`;

/** Presse-papiers : écrire du texte. */
export const CLIPBOARD_SET = String.raw`
Set-Clipboard -Value ([string]$A.text)
ConvertTo-Json -InputObject @{ ok = $true } -Compress
`;

/** Touches multimédia (lecture/pause, suivant…) envoyées au système : le lecteur actif (Spotify, navigateur, VLC…) les reçoit. */
export const MEDIA_KEY = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarodMediaKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Press(byte vk) { keybd_event(vk, 0, 1, UIntPtr.Zero); keybd_event(vk, 0, 3, UIntPtr.Zero); }
}
'@
[JarodMediaKey]::Press([byte]$A.vk)
ConvertTo-Json -InputObject @{ ok = $true } -Compress
`;

/** Luminosité de l'écran intégré (portables) ; un écran externe n'est pas réglable ainsi : `supported = false`. */
export const BRIGHTNESS = String.raw`
$cur = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $cur) { ConvertTo-Json -InputObject @{ supported = $false } -Compress; return }
if ($null -ne $A -and $null -ne $A.percent) {
  $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1
  Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$A.percent } | Out-Null
  Start-Sleep -Milliseconds 300
  $cur = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1
}
ConvertTo-Json -InputObject @{ supported = $true; percent = [int]$cur.CurrentBrightness } -Compress
`;

const WIN32 = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JarodWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static uint IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; }
}
'@
`;

/** Fenêtre au premier plan (titre, programme) et temps d'inactivité clavier/souris — l'idée du « sensorium » et de `window_context` de brahma. */
export const ACTIVE_WINDOW = WIN32 + String.raw`
$h = [JarodWin]::GetForegroundWindow()
$procId = [uint32]0
[void][JarodWin]::GetWindowThreadProcessId($h, [ref]$procId)
$name = ''
try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
ConvertTo-Json -InputObject @{ title = [JarodWin]::Title($h); process = $name; pid = [int]$procId; idleSeconds = [math]::Round([JarodWin]::IdleMs() / 1000) } -Compress
`;

/**
 * Lire l'écran : capture (écran entier ou fenêtre active) puis reconnaissance de texte de Windows (Windows.Media.Ocr), sur la machine.
 * L'image passe par un fichier temporaire, effacé aussitôt ; rien ne sort de l'ordinateur.
 */
export const SCREEN_OCR = WIN32 + String.raw`
[void][JarodWin]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime
if ($A.target -eq 'window') {
  $r = New-Object JarodWin+RECT
  [void][JarodWin]::GetWindowRect([JarodWin]::GetForegroundWindow(), [ref]$r)
  $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
} else {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $b.X; $y = $b.Y; $w = $b.Width; $hgt = $b.Height
}
if ($w -le 0 -or $hgt -le 0) { throw 'zone de capture vide' }
$file = Join-Path ([System.IO.Path]::GetTempPath()) ('jarod-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
try {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
  function Wait-Rt($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $sf = Wait-Rt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file)) ([Windows.Storage.StorageFile])
  $stream = Wait-Rt ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Wait-Rt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Wait-Rt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'aucune langue de reconnaissance de texte installée dans Windows' }
  $res = Wait-Rt ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($res.Lines | ForEach-Object { $_.Text })
  $stream.Dispose()
  ConvertTo-Json -InputObject @{ width = $w; height = $hgt; language = $engine.RecognizerLanguage.LanguageTag; lines = $lines } -Compress -Depth 3
} finally {
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
`;

/**
 * Capture l'écran (target=screen : tous les écrans ; target=window : la fenêtre au premier plan), réduite à 1280 px de large au plus et
 * encodée en JPEG : c'est ce que brahma envoie à son modèle de vision (screen_processor.py, 640x360 JPEG). Rien n'est écrit sur le disque.
 */
export const SCREEN_SHOT = WIN32 + String.raw`
[void][JarodWin]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
if ($A.target -eq 'window') {
  $r = New-Object JarodWin+RECT
  [void][JarodWin]::GetWindowRect([JarodWin]::GetForegroundWindow(), [ref]$r)
  $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
} else {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $b.X; $y = $b.Y; $w = $b.Width; $hgt = $b.Height
}
if ($w -le 0 -or $hgt -le 0) { throw 'zone de capture vide' }
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()
$max = 1280
$scale = [Math]::Min(1.0, $max / [double]$w)
$tw = [int][Math]::Max(1, [Math]::Round($w * $scale)); $th = [int][Math]::Max(1, [Math]::Round($hgt * $scale))
$small = New-Object System.Drawing.Bitmap $tw, $th
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $tw, $th)
$g2.Dispose(); $bmp.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]75)
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, $codec, $ep)
$small.Dispose()
ConvertTo-Json -InputObject @{ width = $w; height = $hgt; sent_width = $tw; sent_height = $th; jpeg = [Convert]::ToBase64String($ms.ToArray()) } -Compress
`;

/** Ramène au premier plan la fenêtre d'un processus (rouverte si réduite) — « ouvrir ce qui tourne déjà ne lance pas une 2e copie ». */
export const RAISE_WINDOW = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarodRaise {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
$p = Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue
if ($null -eq $p -or $p.MainWindowHandle -eq 0) { ConvertTo-Json -InputObject @{ raised = $false } -Compress; return }
$h = $p.MainWindowHandle
if ([JarodRaise]::IsIconic($h)) { [void][JarodRaise]::ShowWindow($h, 9) }
$ok = [JarodRaise]::SetForegroundWindow($h)
ConvertTo-Json -InputObject @{ raised = [bool]$ok } -Compress
`;
