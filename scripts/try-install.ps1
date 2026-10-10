# Try the install as a user gets it, with the code as it is in this checkout,
# uncommitted changes included, in a sandbox: nothing outside it changes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\try-install.ps1 [-Fresh] [-Update] [-Setup] [-OwnNode] [--setup-flags]
#
# The first run installs from zero, the way `irm .../install.ps1 | iex` does,
# and runs setup; a run after that updates, the way running the installer again
# does. -Fresh starts over; -Update updates (and says so when nothing is
# installed yet); -Setup runs `singularity setup` from this checkout instead,
# the way a user runs it again later, with no install; -OwnNode makes the
# installer fetch its own Node.js. Setup's own flags start with two dashes.
#
# The sandbox (%TEMP%\singularity-try) is a home of its own: agents found on
# PATH get memory in its copies of their folders, not yours, and the installer
# serves this checkout from a git repository there. Setup gets --no-path, since
# Windows keeps PATH in the registry, outside any home.
param([switch]$Fresh, [switch]$Update, [switch]$Setup, [switch]$OwnNode, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Flags)

$ErrorActionPreference = 'Stop'
$Flags = @($Flags | Where-Object { $_ })
# An option this script doesn't know isn't passed on: setup would read -Word as letters (-W -o -r -d).
$unknown = @($Flags | Where-Object { $_ -match '^-[^-]' -and $_ -ne '-y' })
if ($unknown) {
  Write-Host "try-install: no option $($unknown -join ', '). It takes -Fresh, -Update, -Setup and -OwnNode; setup's flags start with two dashes (--yes, --agent claude)." -ForegroundColor Red
  exit 2
}
if ($Update -and ($Fresh -or $Setup -or $Flags)) {
  Write-Host 'try-install: -Update runs the installer the way it updates, with no flags; it goes with nothing else.' -ForegroundColor Red
  exit 2
}
$repo = Split-Path $PSScriptRoot
$sandbox = Join-Path ([IO.Path]::GetTempPath()) 'singularity-try'
$home2 = Join-Path $sandbox 'home'
$memory = Join-Path $home2 '.singularity'
$served = Join-Path $sandbox 'served.git'

if ($Fresh) { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $home2 | Out-Null

# This checkout as one commit, untracked files too (not ignored ones), made
# with an index of its own: the checkout's index, branches and stash stay as they are.
$index = Join-Path $sandbox 'index'
Remove-Item -Force $index -ErrorAction SilentlyContinue
$env:GIT_INDEX_FILE = $index
git -C $repo -c core.safecrlf=false add -A
$tree = git -C $repo write-tree
Remove-Item Env:GIT_INDEX_FILE
Remove-Item -Force $index
$commit = git -C $repo -c user.name=try -c user.email=try@localhost commit-tree $tree -p HEAD -m 'try-install snapshot'
if (-not (Test-Path $served)) { git init -q --bare $served }
git -C $repo push -q -f $served "${commit}:refs/heads/main"
if ($LASTEXITCODE -ne 0) { throw "couldn't serve the checkout from $served" }

# The sandbox's home, for setup and every agent it finds.
$env:USERPROFILE = $home2
$env:HOME = $home2
$env:LOCALAPPDATA = Join-Path $home2 'AppData\Local'
$env:APPDATA = Join-Path $home2 'AppData\Roaming'
foreach ($name in 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'XDG_CONFIG_HOME') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
$env:SINGULARITY_HOME = $memory
$env:SINGULARITY_REPO = "file:///$($served -replace '\\', '/')"
$env:SINGULARITY_REF = 'main'
$env:SINGULARITY_AUTOLEARN = 'off'
if ($OwnNode) { $env:SINGULARITY_OWN_NODE = '1' }

# `singularity setup` on its own, from this checkout, kept off PATH.
if ($Setup) {
  Write-Host "try-install: singularity setup from $repo, in $sandbox" -ForegroundColor DarkGray
  & node (Join-Path $repo 'apps\cli\src\singularity.ts') setup --no-path @Flags
  Write-Host ''
  Write-Host "try-install: -Setup again changes the answers; without it, the installer updates." -ForegroundColor DarkGray
  return
}

# Installed already: no flags, so the installer updates. Otherwise setup, kept off PATH.
$installed = Test-Path (Join-Path $memory 'bin\singularity')
if ($Update -and -not $installed) {
  Write-Host "try-install: nothing is installed in $sandbox yet, so there is nothing to update; run it without -Update first." -ForegroundColor Red
  exit 2
}
# (Assigned in each branch: an if that yields @() yields nothing, and splatting that passes one $null, which runs setup.)
if ($installed -and -not $Flags) { $arguments = @() } else { $arguments = @('--no-path') + $Flags }
Write-Host "try-install: $($commit.Substring(0, 7)) of $repo, $(if ($arguments.Count -eq 0) { 'updating' } else { 'installing' }) in $sandbox" -ForegroundColor DarkGray

try {
  & ([scriptblock]::Create((Get-Content -Raw (Join-Path $repo 'install.ps1')))) @arguments
} finally {
  # Should setup have put the sandbox on your PATH all the same, it comes off again.
  $key = (Get-Item -Path 'HKCU:').OpenSubKey('Environment', $true)
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kept = @($old -split ';' | Where-Object { $_ -notlike "$sandbox*" })
  if ($kept.Count -lt @($old -split ';').Count) {
    $key.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    Write-Host "try-install: took the sandbox back off your PATH" -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host "try-install: run it again to try the update; -Fresh starts over." -ForegroundColor DarkGray
