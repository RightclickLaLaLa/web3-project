$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

Set-Location "C:\Users\Administrator\Documents\web3"
if (!(Test-Path "logs\ai-monitor.log")) {
  New-Item -ItemType Directory -Path "logs" -Force | Out-Null
  [System.IO.File]::WriteAllText(
    "logs\ai-monitor.log",
    [char]0xFEFF,
    [System.Text.UTF8Encoding]::new($true)
  )
}

Write-Host "AI request/response monitor: logs\ai-monitor.log"
Get-Content -LiteralPath "logs\ai-monitor.log" -Encoding UTF8 -Wait
