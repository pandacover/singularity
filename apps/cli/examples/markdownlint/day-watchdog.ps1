# Ends what a timed-out tool call left running under the day runs' agents
# (day-driver.mjs): Claude Code's Bash tool gives up on a call after at most
# ten minutes, but on Windows the shell can stay, waiting on stdin (a stray
# `cat >> /dev/null`), and `claude -p` doesn't exit while it does. Every
# minute, any process under a day-driver's claude.exe that has run for more
# than 12 minutes is killed with its tree, and logged. The same for every arm.
# Stops when no day-driver has run for 10 minutes.
#
#   powershell -NoProfile -File day-watchdog.ps1 [-Log <file>]
param([string]$Log = 'C:\singularity-workspaces\eval-1016\ml\day-watchdog.log')
$idle = 0
while ($idle -lt 10) {
  $all = Get-CimInstance Win32_Process
  $drivers = $all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'day-driver\.mjs' }
  if (-not $drivers) { $idle++ } else { $idle = 0 }
  $agents = $all | Where-Object { $_.Name -eq 'claude.exe' -and ($drivers.ProcessId -contains $_.ParentProcessId) }
  foreach ($agent in $agents) {
    $under = @($all | Where-Object { $_.ParentProcessId -eq $agent.ProcessId -and $_.Name -ne 'conhost.exe' })
    foreach ($p in $under) {
      $age = (Get-Date) - $p.CreationDate
      if ($age.TotalMinutes -gt 12) {
        $driver = $drivers | Where-Object { $_.ProcessId -eq $agent.ParentProcessId }
        $arm = if ($driver.CommandLine -match '--repo\s+\S*(day-[a-z]+-p\d+)') { $Matches[1] } else { '?' }
        $what = $p.CommandLine
        if ($what.Length -gt 300) { $what = $what.Substring($what.Length - 300) }
        & taskkill /PID $p.ProcessId /T /F | Out-Null
        Add-Content -Path $Log -Value "$((Get-Date).ToUniversalTime().ToString('s'))Z killed $($p.ProcessId) ($($p.Name), under $arm's claude $($agent.ProcessId), $([int]$age.TotalMinutes) min): $($what -replace '\s+', ' ')"
      }
    }
  }
  Start-Sleep -Seconds 60
}
Add-Content -Path $Log -Value "$((Get-Date).ToUniversalTime().ToString('s'))Z watchdog done: no day-driver for 10 minutes"
