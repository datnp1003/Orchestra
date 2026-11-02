# Auto-capture watcher (ASCII-only to avoid PS 5.1 encoding issues)
# Waits for unlock (LogonUI.exe gone) then auto-captures 6 pages + reruns E2E
$ErrorActionPreference = 'SilentlyContinue'
$exe = 'C:\Users\Nitro V 15\Desktop\Source\Orchestra\desktop\release\win-unpacked\Orchestra Desktop.exe'
$shots = 'C:\Users\Nitro V 15\Desktop\Source\Orchestra\desktop\docs\e2e-shots'
$ps1 = 'C:\Users\Nitro V 15\Desktop\Source\Orchestra\desktop\test\screenshot.ps1'
$out = 'C:\Users\Nitro V 15\Desktop\Source\Orchestra\desktop\docs\e2e-shots\AUTO-CAPTURE-RESULT.txt'
$e2e = 'C:\Users\Nitro V 15\Desktop\Source\Orchestra\desktop\test\e2e-headless.mjs'

"watcher started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File $out -Encoding utf8

$unlocked = $false
for ($i = 0; $i -lt 4320; $i++) {
  Start-Sleep -Seconds 20
  $logonui = Get-Process -Name LogonUI -ErrorAction SilentlyContinue
  if (-not $logonui) {
    $unlocked = $true
    "UNLOCKED detected at $(Get-Date -Format 'HH:mm:ss')" | Out-File $out -Append -Encoding utf8
    break
  }
}
if (-not $unlocked) { "TIMEOUT after 24h - machine still locked" | Out-File $out -Append -Encoding utf8; exit 1 }

Start-Sleep -Seconds 5
foreach ($pg in @('dashboard', 'chat', 'terminal', 'matrix', 'wizard', 'settings')) {
  $png = Join-Path $shots "$pg.png"
  $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $ps1 -Exe $exe -Page $pg -Out $png -WaitSec 8 2>&1
  "[$pg] $r" | Out-File $out -Append -Encoding utf8
  Start-Sleep -Seconds 2
}
"E2E headless rerun after unlock:" | Out-File $out -Append -Encoding utf8
$e2eOut = & node $e2e 2>&1 | Select-Object -Last 8
$e2eOut | Out-File $out -Append -Encoding utf8
"watcher done $(Get-Date -Format 'HH:mm:ss')" | Out-File $out -Append -Encoding utf8
