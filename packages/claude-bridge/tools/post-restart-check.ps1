#Requires -Version 5.1
<#
.SYNOPSIS
  Post-restart verification for the Claude subscription route (claude-bridge).

.DESCRIPTION
  Runs after a machine restart (and can be run by hand at any time). It:
    1. waits for the DeepSeek Harness process,
    2. waits for claude-bridge /health to report loggedIn,
    3. checks that the DSH profile really carries the claude-bridge route,
    4. parses the profile with js-yaml (when the module is cached next to this script),
    5. sends a real prompt through the bridge — proof that the subscription answers,
    6. writes a Markdown report and, when credentials are available, a Telegram note.

  Exit code 0 = everything passed, 1 = something failed (visible as LastTaskResult).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\post-restart-check.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\post-restart-check.ps1 -NoTelegram
#>
[CmdletBinding()]
param(
  [int]$BridgePort = 8790,
  [int]$WaitForDshSec = 600,
  [int]$WaitForBridgeSec = 300,
  [int]$ProbeTimeoutSec = 180,
  [switch]$NoTelegram,
  [string]$ReportDir = (Join-Path $env:USERPROFILE '.dsh\reports')
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$profilePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$bridgeUrl = "http://127.0.0.1:$BridgePort"
$results = New-Object System.Collections.Generic.List[object]

function Add-Result($name, $ok, $detail) {
  $results.Add([pscustomobject]@{ Name = $name; Ok = [bool]$ok; Detail = $detail })
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1}: {2}" -f $(if ($ok) { 'OK' } else { 'FAIL' }), $name, $detail) -ForegroundColor $color
}

Write-Host "== claude post-restart check, $stamp ==" -ForegroundColor Cyan

# 1. DeepSeek Harness process
$dsh = $null
$deadline = (Get-Date).AddSeconds($WaitForDshSec)
while ((Get-Date) -lt $deadline) {
  $dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dsh) { break }
  Start-Sleep -Seconds 5
}
if ($dsh) { Add-Result 'DSH process' $true ("pid {0}, started {1}" -f $dsh.Id, $dsh.StartTime) }
else { Add-Result 'DSH process' $false "не появился за $WaitForDshSec с" }

# 2. Bridge health
$health = $null
$deadline = (Get-Date).AddSeconds($WaitForBridgeSec)
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 10 -ErrorAction Stop
    if ($health.ok -and $health.loggedIn) { break }
  } catch { $health = $null }
  Start-Sleep -Seconds 5
}
if ($health -and $health.ok -and $health.loggedIn) {
  Add-Result 'bridge /health' $true ("loggedIn=True, authMethod={0}" -f $health.authMethod)
} else {
  Add-Result 'bridge /health' $false 'мост не ответил или CLI не авторизован'
}

# 3. Scheduled task state
$task = Get-ScheduledTask -TaskName 'Claude Bridge' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') { Add-Result 'task "Claude Bridge"' $true 'Running' }
else { Add-Result 'task "Claude Bridge"' $false ("state={0}" -f $(if ($task) { $task.State } else { 'нет задачи' })) }

# 4. Profile route
if (Test-Path $profilePath) {
  $text = [IO.File]::ReadAllText($profilePath, [Text.Encoding]::UTF8)
  $hasRoute = $text -match 'claude-bridge:'
  $hasApi = $text -match 'api:\s*anthropic-messages'
  $hasUrl = $text -match [regex]::Escape("http://127.0.0.1:$BridgePort")
  $ok = $hasRoute -and $hasApi -and $hasUrl
  Add-Result 'profile route' $ok ("claude-bridge={0}, anthropic-messages={1}, url={2}" -f $hasRoute, $hasApi, $hasUrl)
} else {
  Add-Result 'profile route' $false "профиль не найден: $profilePath"
}

# 5. YAML parse (optional, if js-yaml.mjs is cached beside this script)
$yamlCheck = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'js-yaml.mjs'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($node -and (Test-Path $yamlCheck) -and (Test-Path $profilePath)) {
  $js = @'
import fs from 'node:fs';
import { load } from 'file:///__YAML__';
const doc = load(fs.readFileSync(process.argv[2], 'utf8'));
const entry = (doc || []).find((e) => e && e.id === 'llm-pi-ai');
const providers = entry && entry.config && entry.config.providers ? Object.keys(entry.config.providers) : [];
const has = providers.includes('claude-bridge');
console.log(JSON.stringify({ entries: (doc || []).length, providers, has }));
process.exit(has ? 0 : 3);
'@ -replace '__YAML__', ($yamlCheck -replace '\\', '/')
  $tmpJs = Join-Path $env:TEMP "yaml-postcheck-$ts.mjs"
  Set-Content -Path $tmpJs -Value $js -Encoding utf8
  $out = & $node $tmpJs $profilePath 2>&1
  $code = $LASTEXITCODE
  Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue
  if ($code -eq 0) { Add-Result 'YAML parse' $true ($out -join ' ') }
  else { Add-Result 'YAML parse' $false (($out -join ' ') + " (exit $code)") }
} else {
  Add-Result 'YAML parse' $true 'пропущено: js-yaml.mjs или node не найдены (проверка не требуется)'
}

# 6. Real request through the bridge (end-to-end proof)
if ($health -and $health.ok) {
  $body = '{"model":"claude-sonnet-5","max_tokens":32,"messages":[{"role":"user","content":"Ответь одним словом: работает"}]}'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-RestMethod -Uri "$bridgeUrl/v1/messages" -Method Post -TimeoutSec $ProbeTimeoutSec `
      -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ErrorAction Stop
    $sw.Stop()
    $answer = ''
    if ($resp.content -and $resp.content.Count -gt 0) { $answer = $resp.content[0].text }
    if ($answer) { Add-Result 'end-to-end prompt' $true ("{0:N1} с, ответ: {1}" -f $sw.Elapsed.TotalSeconds, ($answer -replace '\s+', ' ').Substring(0, [Math]::Min(80, $answer.Length))) }
    else { Add-Result 'end-to-end prompt' $false 'пустой ответ' }
  } catch {
    $sw.Stop()
    Add-Result 'end-to-end prompt' $false ("{0:N1} с, ошибка: {1}" -f $sw.Elapsed.TotalSeconds, $_.Exception.Message)
  }
} else {
  Add-Result 'end-to-end prompt' $false 'пропущено: мост недоступен'
}

# 7. Report
$failed = @($results | Where-Object { -not $_.Ok })
$verdict = if ($failed.Count -eq 0) { 'PASS' } else { "FAIL ($($failed.Count))" }
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Проверка Claude после перезагрузки — $stamp")
$lines.Add('')
$lines.Add("**Итог:** $verdict")
$lines.Add('')
$lines.Add('| Проверка | Результат | Детали |')
$lines.Add('|---|---|---|')
foreach ($r in $results) {
  $mark = if ($r.Ok) { '✅' } else { '❌' }
  $lines.Add("| $($r.Name) | $mark | $($r.Detail) |")
}
$lines.Add('')
$lines.Add('Запуск вручную: `powershell -NoProfile -ExecutionPolicy Bypass -File post-restart-check.ps1`')

if (-not (Test-Path $ReportDir)) { New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null }
$reportPath = Join-Path $ReportDir "claude-post-restart-$ts.md"
[IO.File]::WriteAllLines($reportPath, $lines, (New-Object Text.UTF8Encoding($false)))
$latestPath = Join-Path $ReportDir 'claude-post-restart-latest.md'
Copy-Item $reportPath $latestPath -Force
Write-Host "отчёт: $reportPath" -ForegroundColor Cyan

# 8. Telegram note (best effort)
if (-not $NoTelegram) {
  $tokenFile = (Join-Path $env:USERPROFILE '.openclaw\credentials\telegram-bridge.token')
  $chatId = $env:CLAUDE_BRIDGE_CHAT_ID
  if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
    $summary = (($results | ForEach-Object { "{0} {1}" -f $(if ($_.Ok) { '✅' } else { '❌' }), $_.Name }) -join "`n")
    $message = "Claude после перезагрузки: $verdict`n$summary`n$reportPath"
    try {
      $null = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" -Method Post -TimeoutSec 20 `
        -Body @{ chat_id = $chatId; text = $message; disable_web_page_preview = $true } -ErrorAction Stop
      Write-Host 'Telegram: отправлено' -ForegroundColor Green
    } catch {
      Write-Host ("Telegram: не отправлено ({0})" -f $_.Exception.Message) -ForegroundColor Yellow
    }
  } else {
    Write-Host 'Telegram: токен не найден, пропущено' -ForegroundColor Yellow
  }
}

if ($failed.Count -eq 0) { exit 0 } else { exit 1 }
