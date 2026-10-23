// Outils système (phase 1, lecture seule) : les scripts PowerShell. SYSTEM_INFO, INSTALLED_APPS, RUNNING_APPS, NETWORK, BLUETOOTH,
// EVENT_LOG, CRASHES et CRASH sont repris de `winps.py` de Herald OS (MIT) ; PROCESSES et LISTENERS sont réécrits (voir leur note).
// Les accents graves de PowerShell (`n, `r) sont écrits « @BT@ » dans les chaînes brutes, remplacés au chargement.
const bt = (s: string) => s.replaceAll("@BT@", "`");

/**
 * Le propriétaire d'un processus lu directement dans son jeton (OpenProcessToken), au lieu de `Win32_Process.GetOwner` : ce dernier coûte
 * ~200 ms PAR processus (8 s pour 40 lignes, la cause des 9 à 10 s mesurées sur le port de Herald) ; celui-ci, 69 ms pour tous.
 * Vide pour un processus système auquel un compte ordinaire n'a pas accès.
 */
const OWNER_TYPE = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Security.Principal;
namespace JarodOs {
  public static class Owner {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int pid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static string Of(int pid) {
      IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "";
      try { IntPtr t; if (!OpenProcessToken(h, 0x8, out t)) return ""; try { return new WindowsIdentity(t).Name; } finally { CloseHandle(t); } }
      catch { return ""; } finally { CloseHandle(h); }
    }
  }
}
'@
`;

export const SYSTEM_INFO = String.raw`
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
`;

/**
 * Réécrit. Herald échantillonnait `Win32_Process` deux fois (CIM) puis lisait le propriétaire par `GetOwner` : 9 à 10 s. Ici : deux
 * échantillons de `Get-Process` (temps CPU cumulé, ~0,5 s d'écart, seulement pour le tri par CPU), le parent lu par UNE requête CIM
 * limitée aux lignes retenues, le propriétaire par `Owner.Of`. Le CPU est la somme sur les cœurs : le TypeScript le ramène à 0-100.
 */
export const PROCESSES = OWNER_TYPE + String.raw`
$sort = [string]$A.sort
$needle = ([string]$A.name).ToLowerInvariant()
$limit = [int]$A.limit
$before = @{}
$t0 = [DateTime]::UtcNow
if ($sort -eq 'cpu') {
  Get-Process | ForEach-Object { try { $before[$_.Id] = $_.TotalProcessorTime.TotalSeconds } catch { } }
  Start-Sleep -Milliseconds 500
}
$t1 = [DateTime]::UtcNow
$procs = @(Get-Process)
$seconds = ($t1 - $t0).TotalSeconds
if ($seconds -le 0) { $seconds = 1 }
$total = [int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$rows = @($procs | Where-Object { $_.Id -ne 0 } | ForEach-Object {
  $cpu = 0.0
  if ($before.ContainsKey($_.Id)) { try { $cpu = ($_.TotalProcessorTime.TotalSeconds - $before[$_.Id]) / $seconds * 100 } catch { } }
  $path = ''
  try { $path = [string]$_.Path } catch { }
  [pscustomobject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName; path = $path; rss = [int64]$_.WorkingSet64; cpu = [math]::Round($cpu, 1) }
})
if ($needle) { $rows = @($rows | Where-Object { $_.name.ToLowerInvariant().Contains($needle) -or $_.path.ToLowerInvariant().Contains($needle) }) }
if ($sort -eq 'memory') { $rows = @($rows | Sort-Object rss -Descending) } else { $rows = @($rows | Sort-Object cpu -Descending) }
$rows = @($rows | Select-Object -First $limit)
$ppid = @{}
if ($rows.Count -gt 0) {
  Get-CimInstance Win32_Process -Filter (($rows | ForEach-Object { 'ProcessId=' + $_.pid }) -join ' OR ') | ForEach-Object { $ppid[[int]$_.ProcessId] = [int]$_.ParentProcessId }
}
$out = @($rows | ForEach-Object {
  [pscustomobject]@{ pid = $_.pid; ppid = [int]$ppid[$_.pid]; name = $_.name; path = $_.path; rss = $_.rss; cpu = $_.cpu; user = [JarodOs.Owner]::Of($_.pid) } })
[pscustomobject]@{ total_memory = $total; rows = $out } | ConvertTo-Json -Compress -Depth 4
`;

/** Réécrit : le nom par `Get-Process` et le propriétaire par `Owner.Of` (voir PROCESSES). */
export const LISTENERS = OWNER_TYPE + String.raw`
$port = [int]$A.port
$found = @()
$found += @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; protocol = 'tcp' } })
$found += @(Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; protocol = 'udp' } })
$out = @($found | Sort-Object pid, protocol -Unique | ForEach-Object {
  $name = ''
  try { $name = [string](Get-Process -Id $_.pid -ErrorAction Stop).ProcessName } catch { }
  [pscustomobject]@{ pid = $_.pid; protocol = $_.protocol; name = $name; user = [JarodOs.Owner]::Of($_.pid) } })
ConvertTo-Json -InputObject $out -Compress
`;

export const INSTALLED_APPS = String.raw`
$out = @(Get-StartApps | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; id = [string]$_.AppID } })
ConvertTo-Json -InputObject $out -Compress
`;

export const RUNNING_APPS = String.raw`
$out = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $desc = ''
  $path = ''
  try { $path = [string]$_.MainModule.FileName; $desc = [string]$_.MainModule.FileVersionInfo.FileDescription } catch { }
  [pscustomobject]@{ pid = [int]$_.Id; process = [string]$_.ProcessName; description = $desc; path = $path; title = [string]$_.MainWindowTitle }
})
ConvertTo-Json -InputObject $out -Compress
`;

/**
 * `Get-NetIPConfiguration` lève une exception TERMINANTE (que `-ErrorAction` n'arrête pas) quand une interface porte plusieurs adaptateurs
 * (« Cannot convert System.Object[] … to CimInstance », observé sur un runner Windows de la CI le 2026-10-23) : tout l'outil échouait. Repli
 * sur les cmdlets de plus bas niveau, qui ne passent pas par cette propriété : même forme rendue. `$A.forceFallback` : le test qui prouve le repli.
 */
export const NETWORK = bt(String.raw`
$adapterList = @(Get-NetAdapter -ErrorAction SilentlyContinue)
$cfg = $null
if (-not ($A -and $A.forceFallback)) {
  try {
    $cfg = @(Get-NetIPConfiguration -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.InterfaceAlias; description = [string]$_.InterfaceDescription
        ipv4 = [string]($_.IPv4Address | Select-Object -First 1).IPAddress
        gateway = [string]($_.IPv4DefaultGateway | Select-Object -First 1).NextHop
        dns = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { @($_.ServerAddresses) } | Select-Object -Unique)
      } })
  } catch { $cfg = $null }
}
if ($null -eq $cfg) {
  $cfg = @(Get-NetIPInterface -AddressFamily IPv4 -ConnectionState Connected -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notlike 'Loopback*' } | ForEach-Object {
    $i = $_.InterfaceIndex
    $adapter = $adapterList | Where-Object { $_.ifIndex -eq $i } | Select-Object -First 1
    $ip = Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
    $gw = Get-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
    [pscustomobject]@{
      name = [string]$_.InterfaceAlias; description = [string]$(if ($adapter) { $adapter.InterfaceDescription } else { '' })
      ipv4 = [string]$(if ($ip) { $ip.IPAddress } else { '' })
      gateway = [string]$(if ($gw) { $gw.NextHop } else { '' })
      dns = @(Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { @($_.ServerAddresses) } | Select-Object -Unique)
    } })
}
$adapters = @($adapterList | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; mac = [string]$_.MacAddress; status = [string]$_.Status; media = [string]$_.PhysicalMediaType } })
$wlan = ''
try { $wlan = (netsh wlan show interfaces) -join "@BT@n" } catch { }
[pscustomobject]@{ config = $cfg; adapters = $adapters; wlan = $wlan } | ConvertTo-Json -Compress -Depth 5
`);

export const BLUETOOTH = String.raw`
$devices = @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.FriendlyName; id = [string]$_.InstanceId; status = [string]$_.Status; present = [bool]$_.Present } })
ConvertTo-Json -InputObject $devices -Compress
`;

export const EVENT_LOG = bt(String.raw`
$filter = @{ LogName = @('Application', 'System'); StartTime = (Get-Date).AddMinutes(-[int]$A.minutes) }
if ($A.levels -and @($A.levels).Count -gt 0) { $filter.Level = @($A.levels | ForEach-Object { [int]$_ }) }
$needle = [string]$A.process
$events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents 3000 -ErrorAction SilentlyContinue)
if ($needle) {
  $events = @($events | Where-Object { $_.ProviderName -like "*$needle*" -or ($_.Message -and $_.Message -like "*$needle*") })
}
$out = @($events | Select-Object -First ([int]$A.limit) | ForEach-Object {
  $first = ''
  if ($_.Message) { $first = ($_.Message -split "@BT@r?@BT@n")[0] }
  [pscustomobject]@{ time = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); level = [int]$_.Level; provider = [string]$_.ProviderName; message = $first }
})
ConvertTo-Json -InputObject $out -Compress
`);

/** L'événement 1000 de « Application Error » est la trace que Windows Error Reporting garde d'un programme planté. */
export const CRASHES = String.raw`
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = (Get-Date).AddDays(-7) } -MaxEvents ([int]$A.limit) -ErrorAction SilentlyContinue)
$out = @($events | ForEach-Object {
  $p = @($_.Properties | ForEach-Object { [string]$_.Value })
  [pscustomobject]@{ record = [string]$_.RecordId; time = $_.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss'); app = $p[0]; version = $p[1]; module = $p[3]; code = $p[6] }
})
ConvertTo-Json -InputObject $out -Compress
`;

export const CRASH = String.raw`
$id = [int64]$A.record
$e = Get-WinEvent -LogName Application -FilterXPath "*[System[EventRecordID=$id]]" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $e) { throw "No crash record $id" }
$p = @($e.Properties | ForEach-Object { [string]$_.Value })
[pscustomobject]@{
  record = [string]$e.RecordId; time = $e.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss'); provider = [string]$e.ProviderName
  app = $p[0]; version = $p[1]; module = $p[3]; module_version = $p[4]; code = $p[6]; offset = $p[7]
  pid = $p[8]; app_path = $p[10]; module_path = $p[11]; message = [string]$e.Message
} | ConvertTo-Json -Compress
`;
