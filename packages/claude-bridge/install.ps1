#Requires -Version 5.1
<#
.SYNOPSIS
  Installs claude-bridge: a loopback Anthropic-Messages endpoint backed by the
  local Claude Code CLI (Claude Pro/Max subscription), plus an autostart task and
  an optional DeepSeek Harness profile patch.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 8790 -ProfilePatch
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [int]$Port = 8790,
  [switch]$ProfilePatch,
  [switch]$SkipTask,
  [switch]$WithCheck,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Claude Bridge'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $here 'claude-bridge.mjs'
$profilePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

if ($Uninstall) {
  Write-Step "Removing scheduled task '$TaskName'"
  if (Get-ScheduledTask -TaskName 'Claude Post-Restart Check' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'Claude Post-Restart Check' -Confirm:$false
    Write-Ok 'post-restart check task removed'
  }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok 'task removed'
  } else { Write-Ok 'task was not registered' }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$server*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Ok 'done. Remove the claude-bridge block from the profile by hand if you added it.'
  return
}

Write-Step 'Checking prerequisites'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found in PATH' }
Write-Ok "node: $node"
if (-not (Test-Path $server)) { throw "missing $server" }

$claudeCmd = Join-Path $env:APPDATA 'npm\claude.cmd'
if (-not (Test-Path $claudeCmd)) {
  Write-Warn2 "Claude Code CLI not found at $claudeCmd"
  Write-Warn2 'install it first: npm install -g @anthropic-ai/claude-code'
  throw 'Claude Code CLI is required'
}
$auth = & $claudeCmd auth status 2>$null | ConvertFrom-Json
if (-not $auth.loggedIn) {
  Write-Warn2 'Claude Code is not signed in. Run: claude auth login --claudeai'
  throw 'Not signed in to the Claude subscription'
}
Write-Ok "cli: $claudeCmd (authMethod=$($auth.authMethod))"

if (-not $SkipTask) {
  Write-Step "Registering scheduled task '$TaskName' (at logon, port $Port)"
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$server`" --port $Port" -WorkingDirectory $here
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Ok 'task registered and started'
}

Write-Step "Waiting for http://127.0.0.1:$Port/health"
$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    if ($health.ok) { $healthy = $true; break }
  } catch { }
}
if (-not $healthy) { throw "bridge did not answer on port $Port" }
Write-Ok "bridge is up: loggedIn=$($health.loggedIn), authMethod=$($health.authMethod)"

if ($ProfilePatch) {
  Write-Step "Patching $profilePath"
  if (-not (Test-Path $profilePath)) { throw "profile patch not found: $profilePath" }
  $text = [IO.File]::ReadAllText($profilePath, [Text.Encoding]::UTF8)
  if ($text -match 'claude-bridge:') {
    Write-Ok 'claude-bridge route already present, nothing to do'
  } else {
    $backup = "$profilePath.bak-claude-bridge-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $profilePath $backup -Force
    Write-Ok "backup: $backup"
    $anchor = "      openai-codex: {}`n      kimi-coding: {}"
    if (-not $text.Contains($anchor)) { $anchor = $anchor -replace "`n", "`r`n" }
    if (-not $text.Contains($anchor)) { throw 'anchor "openai-codex/kimi-coding" not found; add the route from cordis.patch.yml by hand' }
    $block = @"

      # Claude subscription: claude-bridge on 127.0.0.1:$Port
      claude-bridge:
        displayName: Claude (subscription)
        api: anthropic-messages
        baseURL: http://127.0.0.1:$Port
        models:
          - id: claude-sonnet-5
            name: Claude Sonnet 5 (subscription)
            contextWindow: 200000
          - id: claude-opus-5
            name: Claude Opus 5 (subscription)
            contextWindow: 200000
"@
    $text = $text.Replace($anchor, $anchor + ($block -replace "`r`n", "`n"))
    [IO.File]::WriteAllText($profilePath, $text, (New-Object Text.UTF8Encoding($false)))
    Write-Ok 'route added to llm-pi-ai providers'
  }
}

if ($WithCheck) {
  Write-Step "Registering post-restart check"
  $checkScript = Join-Path $here 'tools\post-restart-check.ps1'
  if (-not (Test-Path $checkScript)) { Write-Warn2 "missing $checkScript"; }
  else {
    $checkAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$checkScript`""
    $checkT1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $checkT1.Delay = 'PT2M'
    $checkT2 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $checkT2.Delay = 'PT10M'
    $checkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
      -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName 'Claude Post-Restart Check' -Action $checkAction `
      -Trigger @($checkT1, $checkT2) -Settings $checkSettings -Force | Out-Null
    Write-Ok 'task "Claude Post-Restart Check" registered (2 min and 10 min after logon)'
  }
}
Write-Step 'Next steps'
Write-Host "    1. Restart DeepSeek Harness so the profile is re-read." -ForegroundColor Gray
Write-Host "    2. Settings -> Models -> 'Claude (subscription)' -> Claude Sonnet 5." -ForegroundColor Gray
Write-Host "    3. Health check: curl http://127.0.0.1:$Port/health" -ForegroundColor Gray
