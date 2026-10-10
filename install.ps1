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
# Node.js and the code are fetched side by side; the dependencies need both.
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
  # Downloads: TLS 1.2 (for the whole process, the steps' threads included).
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  function Fail($text) { Write-Host ''; Write-Host '  ' -NoNewline; Write-Host ([char]0x2717) -ForegroundColor Red -NoNewline; Write-Host " $text"; Write-Host '' }
  # A node's major version, 0 if it doesn't run.
  function Major($exe) { try { [int]((& $exe -p 'parseInt(process.versions.node)') | Out-String).Trim() } catch { 0 } }

  # The steps. Each runs on a thread of its own (a runspace), so steps that
  # don't need each other run side by side, and returns what it did:
  # @{ ok = $true; text = ...; note = ... } or @{ ok = $false; text = why; output = its messages }.
  $nodeStep = {
    param($node, $fetch, $own, $root, $dist, $nodeMajor)
    # No progress bar: it slows Windows PowerShell's downloads many times over.
    $ProgressPreference = 'SilentlyContinue'
    try {
      if ($fetch) {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        try { $sums = (Invoke-WebRequest -UseBasicParsing "$dist/SHASUMS256.txt").Content } catch { return @{ ok = $false; text = "couldn't reach nodejs.org for Node.js $nodeMajor." } }
        $line = ($sums -split "`n") | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arch\.zip)\s*$" } | Select-Object -First 1
        if (-not ($line -match "^([0-9a-f]{64})\s+(node-v[\d.]+-win-$arch\.zip)")) { return @{ ok = $false; text = "nodejs.org has no Node.js $nodeMajor for win-$arch." } }
        $sum = $Matches[1]
        $file = $Matches[2]
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $zip = Join-Path $tmp $file
        try { Invoke-WebRequest -UseBasicParsing "$dist/$file" -OutFile $zip } catch { return @{ ok = $false; text = "couldn't download $file." } }
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sum.ToUpper()) { return @{ ok = $false; text = "$file doesn't match nodejs.org's checksum; nothing was installed." } }
        # .NET's unzip: Expand-Archive takes minutes over node's thousands of files.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        Remove-Item (Join-Path $root 'node') -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) (Join-Path $root 'node')
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      }
      $version = (& $node -p 'process.versions.node' | Out-String).Trim()
      @{ ok = $true; text = "node $version"; note = $(if ($own) { '(its own)' } else { '' }) }
    } catch { @{ ok = $false; text = $_.Exception.Message } }
  }

  $codeStep = {
    param($app, $root, $repo, $ref)
    $messages = { param($out) ($out | ForEach-Object { "$_" }) -join "`n" }
    if (Test-Path (Join-Path $app '.git')) {
      $out = git -C $app fetch --quiet --depth 1 origin $ref 2>&1
      if ($LASTEXITCODE -ne 0) { return @{ ok = $false; text = "couldn't fetch $ref from $repo."; output = (& $messages $out) } }
      $out = git -C $app reset --quiet --hard FETCH_HEAD 2>&1
      if ($LASTEXITCODE -ne 0) { return @{ ok = $false; text = "couldn't update $app to the code fetched."; output = (& $messages $out) } }
    } else {
      New-Item -ItemType Directory -Force -Path $root | Out-Null
      $out = git clone --quiet --depth 1 --branch $ref $repo $app 2>&1
      if ($LASTEXITCODE -ne 0) { return @{ ok = $false; text = "couldn't clone $repo."; output = (& $messages $out) } }
    }
    @{ ok = $true; text = 'code'; note = "($ref, $((git -C $app rev-parse --short HEAD | Out-String).Trim()))" }
  }

  # npm through the node it came with, so it never runs another.
  $dependenciesStep = {
    param($app, $node)
    $npmCli = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
    Set-Location $app
    $flags = @('ci', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error')
    $out = if (Test-Path $npmCli) { & $node $npmCli @flags 2>&1 } else { npm @flags 2>&1 }
    if ($LASTEXITCODE -ne 0) { return @{ ok = $false; text = 'npm couldn''t install the dependencies; its messages are above.'; output = (($out | ForEach-Object { "$_" }) -join "`n") } }
    @{ ok = $true; text = 'dependencies' }
  }

  function Start-Step($name, $script, $params) {
    $ps = [powershell]::Create()
    [void]$ps.AddScript($script.ToString()).AddParameters($params)
    [pscustomobject]@{ Name = $name; Ps = $ps; Handle = $ps.BeginInvoke(); Result = $null }
  }

  function Receive-Step($step) {
    try { $result = $step.Ps.EndInvoke($step.Handle) | Select-Object -Last 1 } catch { $result = @{ ok = $false; text = $_.Exception.InnerException.Message } }
    $step.Ps.Dispose()
    if ($null -eq $result) { $result = @{ ok = $false; text = "$($step.Name) stopped without saying why." } }
    $result
  }

  # One step's line: a spinner frame while it runs, then a check mark and what it did, or a cross.
  # Live, it fills the line, to cover what the frame before left.
  function Show-Step($step, $frame, $width) {
    Write-Host '    ' -NoNewline
    $text = " $($step.Name)"
    $note = ''
    if ($null -eq $step.Result) { Write-Host $frame -ForegroundColor Magenta -NoNewline }
    elseif ($step.Result.ok) { Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; $text = " $($step.Result.text)"; if ($step.Result.note) { $note = " $($step.Result.note)" } }
    else { Write-Host ([char]0x2717) -ForegroundColor Red -NoNewline }
    Write-Host $text -NoNewline
    Write-Host $note -ForegroundColor DarkGray -NoNewline
    Write-Host (' ' * [Math]::Max(0, $width - 5 - $text.Length - $note.Length))
  }

  # Wait for the steps, redrawing their lines where the console can (elsewhere
  # each prints its line once done); false, having said why, when one failed.
  function Wait-Steps($steps) {
    $live = $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsOutputRedirected
    $width = 0
    if ($live) { try { $width = [Console]::WindowWidth - 1 } catch { $live = $false } }
    # Braille where the font has it (Windows Terminal, VS Code); a plain spinner in the old console.
    $frames = if ($env:WT_SESSION -or $env:TERM_PROGRAM) { 0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F | ForEach-Object { [string][char]$_ } } else { '|', '/', '-', '\' }
    $top = -1
    $n = 0
    try {
      if ($live) { try { [Console]::CursorVisible = $false } catch {} }
      while ($true) {
        foreach ($s in $steps) { if ($null -eq $s.Result -and $s.Handle.IsCompleted) { $s.Result = Receive-Step $s } }
        if ($live) {
          if ($top -ge 0) { [Console]::SetCursorPosition(0, $top) }
          foreach ($s in $steps) { Show-Step $s $frames[$n % $frames.Count] $width }
          # Where the lines start, once the console scrolled to make room for them.
          if ($top -lt 0) { $top = [Console]::CursorTop - $steps.Count }
        }
        if (-not ($steps | Where-Object { $null -eq $_.Result })) { break }
        $n++
        Start-Sleep -Milliseconds 100
      }
    } finally {
      if ($live) { try { [Console]::CursorVisible = $true } catch {} }
      # Stopped with Ctrl+C: steps still running are stopped too.
      foreach ($s in $steps) { if ($null -eq $s.Result) { $s.Ps.Stop(); $s.Ps.Dispose() } }
    }
    if (-not $live) { foreach ($s in $steps) { Show-Step $s '' 0 } }
    foreach ($s in $steps) {
      if (-not $s.Result.ok) {
        if ($s.Result.output) { Write-Host ''; Write-Host $s.Result.output }
        Fail $s.Result.text
        return $false
      }
    }
    $true
  }

  Write-Host ''
  Write-Host "  $([char]0x25C6) " -ForegroundColor Magenta -NoNewline
  Write-Host 'getting singularity' -ForegroundColor DarkGray

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git isn''t installed: get it from https://git-scm.com, then run this again.'; return }

  # The Node.js on PATH if it is new enough, else singularity's own, fetched when it isn't there yet.
  $own = Join-Path $root 'node\node.exe'
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  $fetch = $false
  if (-not $env:SINGULARITY_OWN_NODE -and $onPath -and (Major $onPath.Source) -ge $nodeMajor) {
    $node = $onPath.Source
  } else {
    $node = $own
    $fetch = -not ((Test-Path $own) -and (Major $own) -ge $nodeMajor)
  }

  $fetched = Wait-Steps @(
    (Start-Step 'node' $nodeStep @{ node = $node; fetch = $fetch; own = ($node -eq $own); root = $root; dist = $dist; nodeMajor = $nodeMajor }),
    (Start-Step 'code' $codeStep @{ app = $app; root = $root; repo = $repo; ref = $ref })
  )
  if (-not $fetched) { return }
  if (-not (Wait-Steps @(Start-Step 'dependencies' $dependenciesStep @{ app = $app; node = $node }))) { return }
  Write-Host ''

  # Set up already (setup writes the command): the new code brings it up to date
  # and asks nothing setup asked. Flags for setup run setup.
  $cli = Join-Path $app 'apps\cli\src\singularity.ts'
  if ($args.Count -eq 0 -and (Test-Path (Join-Path $root 'bin\singularity'))) { & $node $cli update --no-fetch } else { & $node $cli setup @args }

  # The command works in this window too, not only in new ones.
  $bin = Join-Path $root 'bin'
  if ((Test-Path $bin) -and -not (($env:Path -split ';') -contains $bin)) { $env:Path = "$bin;$env:Path" }
} @args
