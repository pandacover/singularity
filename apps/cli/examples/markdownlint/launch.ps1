# Starts both arms of the markdownlint long task at the same moment, through
# WMI so they outlive the session that starts them (a child of a Claude Code
# tool call is killed when the call ends), with no window: Windows Terminal,
# when it is the default terminal, shows a started console in a window of its
# own, and closing it (or Ctrl+C in it) stops the run. Each arm's log:
# <runs>\<arm>\driver.log.
# -Tag names a later run's clones and memory home (arm-with-2, sg-home-2 for
# -Tag "-2"); -App runs memory code that isn't installed (driver.mjs --app).
param(
  [string]$Runs = "C:\singularity-workspaces\long\runs",
  [string]$From = "1",
  [string]$To = "99",
  [string[]]$Arms = @("without", "with"),
  [string]$Tag = "",
  [string]$App = ""
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force $Runs | Out-Null
foreach ($arm in $Arms) {
  $repo = "C:/singularity-workspaces/long/arm-$arm$Tag"
  $out = Join-Path $Runs $arm
  $home_ = if ($arm -eq "with") { " --home C:/singularity-workspaces/long/sg-home$Tag" } else { "" }
  $app_ = if ($arm -eq "with" -and $App -ne "") { " --app $App" } else { "" }
  $cmd = "cmd /c `"node driver.mjs --arm $arm --repo $repo --out $out --from $From --to $To$home_$app_ >> $Runs\$arm.out 2>&1`""
  $hidden = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $here; ProcessStartupInformation = $hidden }
  "$arm started: return $($r.ReturnValue), pid $($r.ProcessId)"
}
