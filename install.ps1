# Install singularity, procedural memory for coding agents, on Windows:
#
#   irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex
#
# Checks for Node.js 24+ and git, puts the code in ~\.singularity\app (a git
# clone, updated when this runs again), installs its dependencies, then starts
# `singularity setup`, which sets memory up in your coding agents.
#
# $env:SINGULARITY_REF picks a branch or tag (default: main).

& {
  # A script block, so that `irm | iex` leaves nothing behind in the session, and
  # `return` (never `exit`, which would close the window) ends it on an error.
  $repo = if ($env:SINGULARITY_REPO) { $env:SINGULARITY_REPO } else { 'https://github.com/pandacover/singularity.git' }
  $ref = if ($env:SINGULARITY_REF) { $env:SINGULARITY_REF } else { 'main' }
  $root = if ($env:SINGULARITY_HOME) { $env:SINGULARITY_HOME } else { Join-Path $HOME '.singularity' }
  $app = Join-Path $root 'app'

  # One line of progress, then setup takes over.
  function Done($text) { Write-Host "  $text " -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline }
  function Fail($text) { Write-Host ''; Write-Host ''; Write-Host '  ' -NoNewline; Write-Host ([char]0x2717) -ForegroundColor Red -NoNewline; Write-Host " $text"; Write-Host '' }

  Write-Host ''
  Write-Host "  $([char]0x25C6) " -ForegroundColor Magenta -NoNewline
  Write-Host 'getting singularity ' -ForegroundColor DarkGray -NoNewline

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js isn''t installed: get version 24 or later from https://nodejs.org, then run this again.'; return }
  $nodeVersion = (node -p 'process.versions.node').Trim()
  if ([int]($nodeVersion.Split('.')[0]) -lt 24) { Fail "Node.js $nodeVersion is too old: singularity needs 24 or later (https://nodejs.org)."; return }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm isn''t on your PATH (it comes with Node.js).'; return }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git isn''t installed: get it from https://git-scm.com, then run this again.'; return }
  Done "node $nodeVersion"

  if (Test-Path (Join-Path $app '.git')) {
    git -C $app fetch --quiet --depth 1 origin $ref
    if ($LASTEXITCODE -ne 0) { Fail "couldn't fetch $ref from $repo"; return }
    git -C $app reset --quiet --hard FETCH_HEAD
  } else {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    git clone --quiet --depth 1 --branch $ref $repo $app
    if ($LASTEXITCODE -ne 0) { Fail "couldn't clone $repo"; return }
  }
  Done "code ($ref, $((git -C $app rev-parse --short HEAD).Trim()))"

  Push-Location $app
  try { npm ci --omit=dev --no-audit --no-fund --loglevel=error | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'npm couldn''t install the dependencies; the messages above say why.'; return }
  Done 'dependencies'
  Write-Host ''

  node (Join-Path $app 'src\cli.ts') setup @args

  # The command works in this window too, not only in new ones.
  $bin = Join-Path $root 'bin'
  if ((Test-Path $bin) -and -not (($env:Path -split ';') -contains $bin)) { $env:Path = "$bin;$env:Path" }
} @args
