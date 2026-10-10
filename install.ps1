# Install singularity, procedural memory for coding agents, on Windows:
#
#   irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex
#
# Uses the Node.js on PATH when it is version 24 or later, and otherwise
# fetches its own into ~\.singularity\node (checked against nodejs.org's
# checksums; nothing else on the machine changes). Then it puts the code in
# ~\.singularity\app (a git clone, updated when this runs again), installs its
# dependencies, and starts `singularity setup`, which sets memory up in your
# coding agents. Where memory is set up already, it brings that up to date
# with the new code instead (`singularity update` does all of this too).
#
# $env:SINGULARITY_REF picks a branch or tag (default: main);
# $env:SINGULARITY_OWN_NODE = '1' fetches its own Node.js even when one is on PATH.

& {
  # A script block, so that `irm | iex` leaves nothing behind in the session, and
  # `return` (never `exit`, which would close the window) ends it on an error.
  $repo = if ($env:SINGULARITY_REPO) { $env:SINGULARITY_REPO } else { 'https://github.com/pandacover/singularity.git' }
  $ref = if ($env:SINGULARITY_REF) { $env:SINGULARITY_REF } else { 'main' }
  $root = if ($env:SINGULARITY_HOME) { $env:SINGULARITY_HOME } else { Join-Path $HOME '.singularity' }
  $app = Join-Path $root 'app'
  $nodeMajor = 24
  $dist = "https://nodejs.org/dist/latest-v$nodeMajor.x"
  # Downloads: TLS 1.2, and no progress bar, which slows Windows PowerShell's downloads many times over.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # One line of progress, then setup takes over.
  function Done($text) { Write-Host "  $text " -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline }
  function Fail($text) { Write-Host ''; Write-Host ''; Write-Host '  ' -NoNewline; Write-Host ([char]0x2717) -ForegroundColor Red -NoNewline; Write-Host " $text"; Write-Host '' }
  # A node's major version, 0 if it doesn't run.
  function Major($exe) { try { [int]((& $exe -p 'parseInt(process.versions.node)') | Out-String).Trim() } catch { 0 } }

  Write-Host ''
  Write-Host "  $([char]0x25C6) " -ForegroundColor Magenta -NoNewline
  Write-Host 'getting singularity ' -ForegroundColor DarkGray -NoNewline

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git isn''t installed: get it from https://git-scm.com, then run this again.'; return }

  # The Node.js on PATH if it is new enough, else singularity's own.
  $own = Join-Path $root 'node\node.exe'
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if (-not $env:SINGULARITY_OWN_NODE -and $onPath -and (Major $onPath.Source) -ge $nodeMajor) {
    $node = $onPath.Source
  } elseif ((Test-Path $own) -and (Major $own) -ge $nodeMajor) {
    $node = $own
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    try { $sums = (Invoke-WebRequest -UseBasicParsing "$dist/SHASUMS256.txt").Content } catch { Fail "couldn't reach nodejs.org for Node.js $nodeMajor."; return }
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arch\.zip)\s*$" } | Select-Object -First 1
    if (-not ($line -match "^([0-9a-f]{64})\s+(node-v[\d.]+-win-$arch\.zip)")) { Fail "nodejs.org has no Node.js $nodeMajor for win-$arch."; return }
    $sum = $Matches[1]
    $file = $Matches[2]
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try { Invoke-WebRequest -UseBasicParsing "$dist/$file" -OutFile (Join-Path $tmp $file) } catch { Fail "couldn't download $file."; return }
    if ((Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash -ne $sum.ToUpper()) { Fail "$file doesn't match nodejs.org's checksum; nothing was installed."; return }
    Expand-Archive (Join-Path $tmp $file) -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Remove-Item (Join-Path $root 'node') -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) (Join-Path $root 'node')
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $node = $own
  }
  $version = (& $node -p 'process.versions.node' | Out-String).Trim()
  if ($node -eq $own) { Done "node $version (its own)" } else { Done "node $version" }

  if (Test-Path (Join-Path $app '.git')) {
    git -C $app fetch --quiet --depth 1 origin $ref
    if ($LASTEXITCODE -ne 0) { Fail "couldn't fetch $ref from $repo."; return }
    git -C $app reset --quiet --hard FETCH_HEAD
  } else {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    git clone --quiet --depth 1 --branch $ref $repo $app
    if ($LASTEXITCODE -ne 0) { Fail "couldn't clone $repo."; return }
  }
  Done "code ($ref, $((git -C $app rev-parse --short HEAD).Trim()))"

  # npm through the node it came with, so it never runs another.
  $npmCli = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
  Push-Location $app
  try {
    if (Test-Path $npmCli) { & $node $npmCli ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error | Out-Null }
    else { npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error | Out-Null }
  } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'npm couldn''t install the dependencies; the messages above say why.'; return }
  Done 'dependencies'
  Write-Host ''

  # Set up already (setup writes the command): the new code brings it up to date
  # and asks nothing setup asked. Flags for setup run setup.
  $cli = Join-Path $app 'apps\cli\src\singularity.ts'
  if ($args.Count -eq 0 -and (Test-Path (Join-Path $root 'bin\singularity'))) { & $node $cli update --no-fetch } else { & $node $cli setup @args }

  # The command works in this window too, not only in new ones.
  $bin = Join-Path $root 'bin'
  if ((Test-Path $bin) -and -not (($env:Path -split ';') -contains $bin)) { $env:Path = "$bin;$env:Path" }
} @args
