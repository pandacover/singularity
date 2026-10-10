/**
 * The `singularity` command: small launchers in `<memory home>/bin` that run
 * this checkout's CLI with node, and that directory on the user's PATH.
 * The command is the CLI for daily use (src/singularity.ts); the commands for
 * building and measuring memory stay in src/cli.ts, run from the repo.
 *
 *     <home>/bin/singularity       sh (macOS, Linux, Git Bash)
 *     <home>/bin/singularity.cmd   Windows (cmd and PowerShell)
 *
 * Each launcher runs the node setup ran with, or the `node` on PATH if that
 * one is gone. PATH: on Windows the user's Path in the registry (new
 * terminals see it); elsewhere a line in the shell's startup file, marked so
 * uninstalling removes exactly it.
 */
import { Effect, FileSystem, Path } from "effect"
import { fileURLToPath } from "node:url"
import { runProcess } from "../eval/Proc.ts"
import { join, slashes } from "./Agents.ts"

/** What the command runs: the CLI for daily use, next to this directory. */
export const COMMAND = fileURLToPath(new URL("../singularity.ts", import.meta.url))

/** Marks the line setup adds to a shell's startup file. */
export const RC_MARKER = "# added by singularity setup"

export const binDir = (memoryHome: string) => join(memoryHome, "bin")

const backslashes = (p: string) => p.replace(/\//g, "\\")

export const shLauncher = (node: string, cli: string) =>
  [
    "#!/bin/sh",
    "# singularity's command line, written by `singularity setup`.",
    `node="${slashes(node)}"`,
    "[ -x \"$node\" ] || node=node",
    `exec "$node" "${slashes(cli)}" "$@"`,
    ""
  ].join("\n")

export const cmdLauncher = (node: string, cli: string) =>
  [
    "@echo off",
    "rem singularity's command line, written by `singularity setup`.",
    `set "SINGULARITY_NODE=${backslashes(node)}"`,
    "if not exist \"%SINGULARITY_NODE%\" set \"SINGULARITY_NODE=node\"",
    `"%SINGULARITY_NODE%" "${backslashes(cli)}" %*`,
    ""
  ].join("\r\n")

/** Write the launchers; their directory. */
export const writeLaunchers = Effect.fn("writeLaunchers")(function*(memoryHome: string, node: string, cli: string, platform: NodeJS.Platform) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bin = binDir(memoryHome)
  yield* fs.makeDirectory(bin, { recursive: true })
  const sh = path.join(bin, "singularity")
  yield* fs.writeFileString(sh, shLauncher(node, cli))
  yield* fs.chmod(sh, 0o755).pipe(Effect.ignore)
  if (platform === "win32") yield* fs.writeFileString(path.join(bin, "singularity.cmd"), cmdLauncher(node, cli))
  return bin
})

export const removeLaunchers = Effect.fn("removeLaunchers")(function*(memoryHome: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(binDir(memoryHome), { recursive: true, force: true })
})

const samePath = (a: string, b: string, platform: NodeJS.Platform) => {
  const n = (p: string) => slashes(p).replace(/\/+$/, "")
  return platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/** Whether `dir` is on a PATH value. */
export const onPath = (dir: string, pathValue: string | undefined, platform: NodeJS.Platform): boolean =>
  (pathValue ?? "").split(platform === "win32" ? ";" : ":").some((p) => p !== "" && samePath(p, dir, platform))

/** The shell startup file to put PATH in, for a login shell like `$SHELL`. */
export const rcFile = (home: string, shell: string | undefined, platform: NodeJS.Platform): string => {
  const name = (shell ?? "").replace(/\\/g, "/").split("/").pop() ?? ""
  if (name === "zsh") return join(home, ".zshrc")
  if (name === "fish") return join(home, ".config", "fish", "conf.d", "singularity.fish")
  if (name === "bash") return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc")
  return join(home, ".profile")
}

/** The line that puts `bin` on PATH, `$HOME`-relative when it can be. */
export const rcLine = (bin: string, home: string, fish: boolean): string => {
  const dir = slashes(bin).startsWith(`${slashes(home).replace(/\/+$/, "")}/`) ? `$HOME${slashes(bin).slice(slashes(home).replace(/\/+$/, "").length)}` : slashes(bin)
  return fish ? `set -gx PATH "${dir}" $PATH ${RC_MARKER}` : `export PATH="${dir}:$PATH" ${RC_MARKER}`
}

/** A startup file's text with setup's line in it (once), or without it. */
export const withRcLine = (text: string, line: string | undefined): string => {
  const kept = text.split(/\r?\n/).filter((l) => !l.includes(RC_MARKER))
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop()
  if (line !== undefined) kept.push(line)
  return kept.length === 0 ? "" : kept.join("\n") + "\n"
}

/**
 * The PowerShell that adds `$env:SINGULARITY_BIN` to the user's Path in the
 * registry (or removes it), keeping the other entries as they are written
 * (`%USERPROFILE%` unexpanded), and tells running programs the environment
 * changed, as installers of other tools do.
 */
const WINDOWS_PATH_SCRIPT = (add: boolean) => `
$dir = $env:SINGULARITY_BIN
$key = (Get-Item -Path 'HKCU:').OpenSubKey('Environment', $true)
$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($old -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\\') -ne $dir.TrimEnd('\\') })
${add ? "$parts = @($parts) + $dir" : ""}
$new = ($parts -join ';')
if ($new -ne $old) {
  $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  [Environment]::SetEnvironmentVariable('SINGULARITY_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('SINGULARITY_PATH_CHANGED', $null, 'User')
  'changed'
} else { 'unchanged' }
`

/** Whether the user's Path in the registry changed; undefined if PowerShell failed. */
const windowsPath = (bin: string, add: boolean) =>
  runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PATH_SCRIPT(add)], {
    cwd: process.cwd(),
    timeoutS: 60,
    env: { ...process.env, SINGULARITY_BIN: backslashes(bin) }
  }).pipe(
    Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim().split(/\r?\n/).at(-1)?.trim() === "changed" : undefined)),
    Effect.orElseSucceed(() => undefined)
  )

export interface PathChange {
  /** "already": it was on PATH; "added": new terminals have it; "failed": the user must add it. */
  readonly state: "already" | "added" | "failed"
  /** Unix: the startup file the line went in. */
  readonly file?: string
}

/** Put `bin` on the user's PATH for new terminals. */
export const addToPath = Effect.fn("addToPath")(function*(bin: string, options: { readonly home: string; readonly shell: string | undefined; readonly platform: NodeJS.Platform; readonly pathValue: string | undefined }) {
  if (onPath(bin, options.pathValue, options.platform)) return { state: "already" } satisfies PathChange
  if (options.platform === "win32") {
    const changed = yield* windowsPath(bin, true)
    return { state: changed === undefined ? "failed" : changed ? "added" : "already" } satisfies PathChange
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = rcFile(options.home, options.shell, options.platform)
  const result = yield* Effect.gen(function*() {
    const text = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : ""
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, withRcLine(text, rcLine(bin, options.home, file.endsWith(".fish"))))
  }).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  return { state: result ? "added" : "failed", file } satisfies PathChange
})

/** Take `bin` off the user's PATH: the registry entry, or setup's line in any startup file it may be in. */
export const removeFromPath = Effect.fn("removeFromPath")(function*(bin: string, options: { readonly home: string; readonly platform: NodeJS.Platform }) {
  if (options.platform === "win32") return (yield* windowsPath(bin, false)) === true
  const fs = yield* FileSystem.FileSystem
  let removed = false
  for (const file of [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(options.home, f))) {
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined || !text.includes(RC_MARKER)) continue
    yield* fs.writeFileString(file, withRcLine(text, undefined)).pipe(Effect.ignore)
    removed = true
  }
  const fish = join(options.home, ".config", "fish", "conf.d", "singularity.fish")
  if (yield* fs.exists(fish).pipe(Effect.orElseSucceed(() => false))) {
    yield* fs.remove(fish).pipe(Effect.ignore)
    removed = true
  }
  return removed
})
