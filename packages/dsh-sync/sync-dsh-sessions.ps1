#requires -Version 5.1
<#
Two-way session sync between this Windows DSH desktop install and a remote
Linux DSH instance reached over SSH (alias from DSH_SYNC_SSH, default debian17-root).

What it does, per run:
  1. hashes every session log on both sides,
  2. copies the ones that changed, converting the header cwd through a path map
     (C:\Users\<user>\Documents\deepseek-harness\X  <->  /root/dsh-ws/X),
  3. keeps the newest version when both sides changed and backs up the loser.

No model calls happen here: only file hashing, ssh/scp and zstd re-framing.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$ForceInitialPush,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
# SSH-алиас удалённого хоста: из env DSH_SYNC_SSH, иначе debian17-root (~/.ssh/config).
$Ssh = if ($env:DSH_SYNC_SSH) { $env:DSH_SYNC_SSH } else { 'debian17-root' }
$SshArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', $Ssh)
$ScpArgs = @('-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')

$LocalRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
$StateDir = Join-Path $env:USERPROFILE '.dsh\sync'
$StateFile = Join-Path $StateDir 'state.json'
$LockFile = Join-Path $StateDir 'sync.lock'
$LogFile = Join-Path $StateDir 'sync.log'
$BackupDir = Join-Path $StateDir 'backup'
$RemoteRoot = '/root/.dsh/sessions'
$RemoteIncoming = '/root/dsh-sync/incoming'
$TempRoot = Join-Path $env:TEMP 'dsh-sync'
$StageRoot = Join-Path $TempRoot 'stage'
$ConvertLocal = Join-Path $PSScriptRoot 'convert.js'

$NodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue).Source,
  (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\node.exe')
)
$Node = $NodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Node) { throw 'node.exe not found: install Node.js 22+ or add it to PATH' }

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  if (-not $script:Quiet) { Write-Host $line }
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return @{ version = 1; sessions = @{} } }
  try {
    $raw = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  } catch {
    Write-Log "state.json unreadable, starting fresh: $($_.Exception.Message)"
    return @{ version = 1; sessions = @{} }
  }
  $sessions = @{}
  if ($raw.sessions) {
    foreach ($p in $raw.sessions.PSObject.Properties) {
      $v = $p.Value
      $sessions[$p.Name] = @{
        pcHash = [string]$v.pcHash
        dbHash = [string]$v.dbHash
        pcPath = [string]$v.pcPath
        dbPath = [string]$v.dbPath
        at     = [string]$v.at
      }
    }
  }
  return @{ version = 1; sessions = $sessions }
}

function Write-State($State) {
  $obj = [ordered]@{ version = 1; sessions = [ordered]@{} }
  foreach ($k in ($State.sessions.Keys | Sort-Object)) {
    $e = $State.sessions[$k]
    $obj.sessions[$k] = [ordered]@{
      pcHash = $e.pcHash; dbHash = $e.dbHash; pcPath = $e.pcPath; dbPath = $e.dbPath; at = $e.at
    }
  }
  $tmp = "$StateFile.tmp"
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $StateFile -Force
}

function Get-VersionOf([string]$Name) {
  if ($Name -match '^session\.v(\d+)\.jsonl(\.zstd)?$') { return [int]$Matches[1] }
  return -1
}

function Get-LocalInventory {
  $map = @{}
  if (-not (Test-Path -LiteralPath $LocalRoot)) { return $map }
  foreach ($project in Get-ChildItem -LiteralPath $LocalRoot -Directory) {
    foreach ($session in Get-ChildItem -LiteralPath $project.FullName -Directory) {
      $best = $null
      foreach ($file in Get-ChildItem -LiteralPath $session.FullName -File) {
        $version = Get-VersionOf $file.Name
        if ($version -lt 0) { continue }
        if (-not $best -or $version -gt $best.Version) {
          $best = [pscustomobject]@{ Version = $version; File = $file }
        }
      }
      if (-not $best) { continue }
      $rel = '{0}/{1}/{2}' -f $project.Name, $session.Name, $best.File.Name
      $map[$session.Name] = [pscustomobject]@{
        Id       = $session.Name
        Rel      = $rel
        Abs      = $best.File.FullName
        FileName = $best.File.Name
        Hash     = (Get-FileHash -LiteralPath $best.File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        Mtime    = ([DateTimeOffset]$best.File.LastWriteTimeUtc).ToUnixTimeSeconds()
        Version  = $best.Version
      }
    }
  }
  return $map
}

function Get-RemoteInventory {
  $map = @{}
  $lines = & ssh @SshArgs 'bash /root/dsh-sync/remote-inventory.sh'
  if ($LASTEXITCODE -ne 0) { throw "remote inventory failed (exit $LASTEXITCODE)" }
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|'
    if ($parts.Count -ne 4) { continue }
    $rel = $parts[0].TrimStart('.', '/')
    $segments = $rel -split '/'
    if ($segments.Count -lt 3) { continue }
    $id = $segments[$segments.Count - 2]
    $version = Get-VersionOf $segments[$segments.Count - 1]
    if ($version -lt 0) { continue }
    $entry = [pscustomobject]@{
      Id       = $id
      Rel      = $rel
      FileName = $segments[$segments.Count - 1]
      Hash     = $parts[3].Trim().ToLowerInvariant()
      Size     = [int64]$parts[1]
      Mtime    = [int64]$parts[2]
      Version  = $version
    }
    if (-not $map.ContainsKey($id) -or $version -gt $map[$id].Version) { $map[$id] = $entry }
  }
  return $map
}

function Backup-Local([string]$Path, [string]$Id) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path (Join-Path $BackupDir $stamp) $Id
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item -LiteralPath $Path -Destination (Join-Path $dir (Split-Path -Leaf $Path)) -Force
}

function Invoke-Push($PcEntry, $DbEntry) {
  Write-Log ("push {0} ({1})" -f $PcEntry.Id, $PcEntry.Rel)
  if ($DryRun) { return $true }
  $remoteDir = "$RemoteIncoming/$($PcEntry.Id)"
  $remoteTmp = "$remoteDir/$($PcEntry.FileName)"
  & ssh @SshArgs "mkdir -p $remoteDir"
  if ($LASTEXITCODE -ne 0) { throw "cannot create $remoteDir" }
  & scp @ScpArgs $PcEntry.Abs "${Ssh}:$remoteTmp"
  if ($LASTEXITCODE -ne 0) { throw "scp upload failed for $($PcEntry.Id)" }
  $out = & ssh @SshArgs "bash /root/dsh-sync/remote-push.sh $($PcEntry.Id) $remoteTmp"
  if ($LASTEXITCODE -ne 0) { throw "remote push failed for $($PcEntry.Id): $out" }
  $meta = ($out | Select-Object -Last 1) | ConvertFrom-Json
  $script:State.sessions[$PcEntry.Id] = @{
    pcHash = $PcEntry.Hash
    dbHash = [string]$meta.sha256
    pcPath = $PcEntry.Rel
    dbPath = [string]$meta.rel
    at     = (Get-Date).ToString('o')
  }
  return $true
}

function Invoke-Pull($DbEntry, $PcEntry) {
  Write-Log ("pull {0} (remote cwd {1})" -f $DbEntry.Id, $DbEntry.Rel)
  if ($DryRun) { return $true }
  if (-not (Test-Path -LiteralPath $TempRoot)) { New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null }
  if (Test-Path -LiteralPath $StageRoot) { Remove-Item -LiteralPath $StageRoot -Recurse -Force }
  $localDir = Join-Path $TempRoot $DbEntry.Id
  New-Item -ItemType Directory -Path $localDir -Force | Out-Null
  $tmpLog = Join-Path $localDir $DbEntry.FileName
  & scp @ScpArgs "${Ssh}:$RemoteRoot/$($DbEntry.Rel)" $tmpLog
  if ($LASTEXITCODE -ne 0) { throw "scp download failed for $($DbEntry.Id)" }
  $metaFile = Join-Path $TempRoot 'meta.json'
  & $Node $ConvertLocal --in $tmpLog --root $StageRoot --direction posix2win --meta $metaFile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "local conversion failed for $($DbEntry.Id)" }
  $meta = Get-Content -LiteralPath $metaFile -Raw | ConvertFrom-Json
  $dst = Join-Path $LocalRoot $meta.rel
  Backup-Local -Path $dst -Id $DbEntry.Id
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
  Move-Item -LiteralPath (Join-Path $StageRoot $meta.rel) -Destination $dst -Force
  $script:State.sessions[$DbEntry.Id] = @{
    pcHash = [string]$meta.sha256
    dbHash = $DbEntry.Hash
    pcPath = [string]$meta.rel
    dbPath = $DbEntry.Rel
    at     = (Get-Date).ToString('o')
  }
  return $true
}

# --- attachments ----------------------------------------------------------
$LocalAttachments = Join-Path $env:USERPROFILE '.dsh\attachments\v1\objects'
$RemoteAttachments = '/root/.dsh/attachments/v1/objects'

function Sync-Attachments {
  $result = [pscustomobject]@{ Pushed = 0; Pulled = 0 }
  if (-not (Test-Path -LiteralPath $LocalAttachments)) { return $result }
  $local = @{}
  foreach ($file in Get-ChildItem -LiteralPath $LocalAttachments -Recurse -File) {
    $rel = $file.FullName.Substring($LocalAttachments.Length).TrimStart('\', '/') -replace '\\', '/'
    $local[$rel] = $file.Length
  }
  $remote = @{}
  $lines = & ssh @SshArgs "mkdir -p $RemoteAttachments; find $RemoteAttachments -type f -printf '%P|%s\n' 2>/dev/null"
  if ($LASTEXITCODE -ne 0) { Write-Log "attachments: remote scan failed (exit $LASTEXITCODE)" }
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|'
    if ($parts.Count -ne 2) { continue }
    $remote[$parts[0]] = [int64]$parts[1]
  }
  $push = @()
  $pull = @()
  foreach ($rel in $local.Keys) {
    if ($remote.ContainsKey($rel) -and $remote[$rel] -eq $local[$rel]) { continue }
    $push += $rel
  }
  foreach ($rel in $remote.Keys) {
    if ($local.ContainsKey($rel)) { continue }
    $pull += $rel
  }
  if ($push.Count -gt 0 -and -not $DryRun) {
    $dirs = $push | ForEach-Object { "'$RemoteAttachments/" + ($_ -replace '/[^/]+$', '') + "'" } | Sort-Object -Unique
    & ssh @SshArgs ("mkdir -p " + ($dirs -join ' '))
  }
  foreach ($rel in $push) {
    if ($DryRun) { $result.Pushed++; continue }
    & scp @ScpArgs (Join-Path $LocalAttachments ($rel -replace '/', '\')) "${Ssh}:$RemoteAttachments/$rel"
    if ($LASTEXITCODE -eq 0) { $result.Pushed++ }
  }
  foreach ($rel in $pull) {
    if ($DryRun) { $result.Pulled++; continue }
    $dst = Join-Path $LocalAttachments ($rel -replace '/', '\')
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    & scp @ScpArgs "${Ssh}:$RemoteAttachments/$rel" $dst
    if ($LASTEXITCODE -eq 0) { $result.Pulled++ }
  }
  return $result
}

# --- main -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$lock = $null
try {
  $lock = [System.IO.File]::Open($LockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  exit 0
}

try {
  if (-not (Test-Path -LiteralPath $LogFile)) { New-Item -ItemType File -Path $LogFile -Force | Out-Null }
  if ((Get-Item -LiteralPath $LogFile).Length -gt 512KB) { Clear-Content -LiteralPath $LogFile }

  $script:State = Read-State
  $pc = Get-LocalInventory
  $db = Get-RemoteInventory
  Write-Log ("scan: {0} local, {1} remote sessions" -f $pc.Count, $db.Count)

  $pushed = 0
  $pulled = 0
  $skipped = 0
  $ids = @($pc.Keys) + @($db.Keys) | Sort-Object -Unique
  foreach ($id in $ids) {
    $p = $pc[$id]
    $d = $db[$id]
    $st = $script:State.sessions[$id]
    try {
      if ($p -and $d) {
        if ($st -and $st.pcHash -eq $p.Hash -and $st.dbHash -eq $d.Hash) { continue }
        $pcChanged = (-not $st) -or ($st.pcHash -ne $p.Hash)
        $dbChanged = (-not $st) -or ($st.dbHash -ne $d.Hash)
        if ($pcChanged -and (-not $dbChanged)) { Invoke-Push $p $d | Out-Null; $pushed++ }
        elseif ($dbChanged -and (-not $pcChanged)) { Invoke-Pull $d $p | Out-Null; $pulled++ }
        elseif ($p.Mtime -ge $d.Mtime) { Invoke-Push $p $d | Out-Null; $pushed++ }
        else { Invoke-Pull $d $p | Out-Null; $pulled++ }
      }
      elseif ($p -and (-not $d)) {
        if ($st -and (-not $ForceInitialPush)) { $skipped++; continue }
        Invoke-Push $p $null | Out-Null
        $pushed++
      }
      elseif ($d -and (-not $p)) {
        if ($st) { $skipped++; continue }
        Invoke-Pull $d $null | Out-Null
        $pulled++
      }
    } catch {
      Write-Log ("ERROR {0}: {1}" -f $id, $_.Exception.Message)
    }
  }

  Write-State $script:State
  Write-Log ("done: pushed {0}, pulled {1}, skipped {2}" -f $pushed, $pulled, $skipped)

  # Content-addressed attachments are mirrored by file name; no conflicts possible.
  try {
    $att = Sync-Attachments
    if ($att.Pushed -gt 0 -or $att.Pulled -gt 0) {
      Write-Log ("attachments: pushed {0}, pulled {1}" -f $att.Pushed, $att.Pulled)
    }
  } catch {
    Write-Log ("ERROR attachments: {0}" -f $_.Exception.Message)
  }
}
finally {
  if ($lock) { $lock.Dispose() }
}
