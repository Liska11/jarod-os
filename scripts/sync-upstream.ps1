# Fetch the pinned upstream Hermes Agent snapshot into upstream/hermes-agent (Windows twin of
# sync-upstream.sh). Idempotent: skips when the sha already matches.
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 renders a progress bar per downloaded chunk, which makes a 70 MB download take minutes.
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Lock = Join-Path $Root 'upstream/UPSTREAM.lock'
$Dest = Join-Path $Root 'upstream/hermes-agent'
$Stamp = Join-Path $Dest '.herald-os-upstream-sha'

$lines = Get-Content -LiteralPath $Lock
$repo = ($lines | Where-Object { $_ -match '^repo=' } | Select-Object -First 1) -replace '^repo=', '' -replace '\s', ''
$sha = ($lines | Where-Object { $_ -match '^sha=' } | Select-Object -First 1) -replace '^sha=', '' -replace '\s', ''

if (-not $repo -or -not $sha) {
    Write-Error 'sync-upstream: UPSTREAM.lock must define repo= and sha='
    exit 1
}

if ((Test-Path $Stamp) -and ((Get-Content -LiteralPath $Stamp -Raw).Trim() -eq $sha)) {
    Write-Host "sync-upstream: $repo@$sha already present"
    exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("herald-upstream-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    Write-Host "sync-upstream: fetching $repo@$sha"
    $archive = Join-Path $tmp 'upstream.tar.gz'
    $extract = Join-Path $tmp 'extract'
    New-Item -ItemType Directory -Path $extract | Out-Null

    # GitHub rate-limits (429) when many builds fetch at once; retry like the shell version does.
    $attempt = 0
    while ($true) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/archive/$sha.tar.gz" -OutFile $archive
            break
        } catch {
            $attempt++
            if ($attempt -ge 6) { throw }
            Start-Sleep -Seconds 20
        }
    }

    # bsdtar from System32 (tar.exe ships with Windows 10 1803+). A bare `tar` may resolve to Git's GNU
    # tar, which reads "C:\..." as a remote host. bsdtar reports the archive's symlinks as errors when
    # the symlink privilege is missing; the files this repo reads are regular, so only the result counts.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & (Join-Path $env:SystemRoot 'System32/tar.exe') -xzf $archive -C $extract --strip-components=1 2>$null
    $ErrorActionPreference = $previous
    if (-not (Test-Path (Join-Path $extract 'hermes_cli'))) {
        throw 'sync-upstream: the archive did not extract (no hermes_cli/ in it)'
    }

    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
    Move-Item -LiteralPath $extract -Destination $Dest
    Set-Content -LiteralPath $Stamp -Value $sha -NoNewline -Encoding ascii
    Write-Host "sync-upstream: done -> $Dest"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
