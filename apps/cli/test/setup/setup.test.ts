import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { agents, hookEvents, isMemoryHookCommand, type Launch } from "../../src/setup/Agents.ts"
import { HookFileError, installHooks, memoryHookEvents, removeHooks, withMemoryHooks, withoutMemoryHooks } from "../../src/setup/HookFiles.ts"
import { cmdLauncher, onPath, rcFile, rcLine, RC_MARKER, shLauncher, withRcLine } from "../../src/setup/Launcher.ts"
import { readLearn } from "../../src/setup/Preferences.ts"
import { runSetup, type SetupOptions } from "../../src/setup/Setup.ts"
import { SKILL_TEXT, skillState } from "../../src/setup/Skill.ts"
import { agentStates, detectAgents, isWindowsFromWsl, unwireAll } from "../../src/setup/Wiring.ts"
import { commandOfShim } from "../../src/eval/Agent.ts"
import { asClaudeCall } from "../../src/workflows/HookTool.ts"
import { run, tempDir, withEnv } from "../eval/helpers.ts"

const json = (file: string) => JSON.parse(readFileSync(file, "utf-8"))

const nodeLayer = NodeServices.layer

const claudeLaunch: Launch = { node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\app\\src\\workflows\\hook.ts" }
const bareLaunch: Launch = { node: "node", script: "C:\\app\\src\\workflows\\hook.ts" }

describe("hook entries", () => {
  it("gives Claude Code the measured form, the hand-over in two parts and the session's end", () => {
    const events = hookEvents("claude", claudeLaunch, bareLaunch)
    expect(Object.keys(events)).toEqual(["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SessionEnd"])
    expect(events.UserPromptSubmit.map((e) => e.hooks[0].command)).toEqual([
      "\"C:/Program Files/nodejs/node.exe\" \"C:/app/src/workflows/hook.ts\" user-prompt-submit --parts=2",
      "\"C:/Program Files/nodejs/node.exe\" \"C:/app/src/workflows/hook.ts\" user-prompt-submit-2 --parts=2"
    ])
    expect(events.SessionEnd[0].hooks[0].timeout).toBe(30)
  })

  it("starts other agents' hooks with a bare node, in their own events, matchers and units", () => {
    const codex = hookEvents("codex", claudeLaunch, bareLaunch)
    expect(codex.UserPromptSubmit[0].hooks[0]).toMatchObject({
      command: "node \"C:/app/src/workflows/hook.ts\" user-prompt-submit",
      timeout: 90,
      additionalContextLimit: 4000
    })
    expect(codex.SessionEnd).toBeUndefined()
    const gemini = hookEvents("gemini", claudeLaunch, bareLaunch)
    expect(Object.keys(gemini)).toEqual(["BeforeAgent", "AfterTool"])
    expect(gemini.BeforeAgent[0].hooks[0].timeout).toBe(90_000)
    expect(gemini.AfterTool[0].matcher).toBe("run_shell_command|replace|write_file")
    expect(hookEvents("droid", claudeLaunch, bareLaunch).PostToolUse[0].matcher).toBe("Execute|Edit|Create|ApplyPatch")
    expect(hookEvents("cursor", claudeLaunch, bareLaunch)).toEqual({})
    // Without a new enough node on PATH, other agents get the full path too.
    expect(hookEvents("codex", claudeLaunch, claudeLaunch).UserPromptSubmit[0].hooks[0].command).toMatch(/^"C:\/Program Files/)
  })

  it("recognizes memory's hook commands from any checkout, v0's included, and nothing else", () => {
    expect(isMemoryHookCommand("node \"/home/a/.singularity/app/src/workflows/hook.ts\" post-tool-use")).toBe(true)
    expect(isMemoryHookCommand("\"C:\\node.exe\" \"C:\\Users\\a\\singularity\\src\\hook.ts\" session-end")).toBe(true)
    expect(isMemoryHookCommand("node /x/src/hook.ts format")).toBe(false)
    expect(isMemoryHookCommand("npx prettier --write")).toBe(false)
  })

  it("finds agents' directories where their environment moves them", () => {
    const list = agents({ home: "/home/a", env: { CLAUDE_CONFIG_DIR: "/cfg/claude", CODEX_HOME: "/cfg/codex", XDG_CONFIG_HOME: "/xdg" } })
    const dir = (id: string) => list.find((a) => a.id === id)!.dir
    expect(dir("claude")).toBe("/cfg/claude")
    expect(dir("codex")).toBe("/cfg/codex")
    expect(dir("opencode")).toBe("/xdg/opencode")
    expect(dir("gemini")).toBe("/home/a/.gemini")
  })
})

describe("hook files", () => {
  const ours = hookEvents("claude", claudeLaunch, bareLaunch)
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "my-linter", timeout: 5 }] }

  it("adds memory's hooks after the user's own, and replaces an earlier copy instead of adding another", () => {
    const once = withMemoryHooks({ PostToolUse: [theirs] }, ours)
    expect((once.PostToolUse as Array<unknown>)[0]).toEqual(theirs)
    expect(memoryHookEvents(once)).toEqual(["PostToolUse", "UserPromptSubmit", "PostToolUseFailure", "SessionEnd"])
    expect(withMemoryHooks(once, ours)).toEqual(once)
    // An install from another checkout is replaced too.
    const elsewhere = withMemoryHooks({}, hookEvents("claude", claudeLaunch, { node: "node", script: "/old/src/workflows/hook.ts" }))
    expect(withMemoryHooks(elsewhere, ours)).toEqual(withMemoryHooks({}, ours))
  })

  it("takes out only memory's hooks, and events left empty", () => {
    expect(withoutMemoryHooks(withMemoryHooks({ PostToolUse: [theirs] }, ours))).toEqual({ PostToolUse: [theirs] })
  })

  it.live("keeps the rest of a settings file, and the file as it was before the first change", () =>
    Effect.gen(function*() {
      const dir = tempDir()
      const file = join(dir, "settings.json")
      writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { PostToolUse: [theirs] } }))
      yield* installHooks({ file, layout: "wrapped" }, ours)
      const after = json(file)
      expect(after.theme).toBe("dark")
      expect(memoryHookEvents(after.hooks)).toContain("SessionEnd")
      expect(json(`${file}.before-singularity`)).toEqual({ theme: "dark", hooks: { PostToolUse: [theirs] } })
      expect(yield* removeHooks({ file, layout: "wrapped" })).toBe(true)
      expect(json(file)).toEqual({ theme: "dark", hooks: { PostToolUse: [theirs] } })
      expect(yield* removeHooks({ file, layout: "wrapped" })).toBe(false)

      // Droid's hooks.json holds the events at its top level.
      const droid = join(dir, "hooks.json")
      yield* installHooks({ file: droid, layout: "events" }, hookEvents("droid", claudeLaunch, bareLaunch))
      expect(Object.keys(json(droid))).toEqual(["UserPromptSubmit", "PostToolUse"])
    }).pipe(Effect.provide(nodeLayer)))

  it.live("leaves a file that isn't plain JSON alone", () =>
    Effect.gen(function*() {
      const file = join(tempDir(), "settings.json")
      writeFileSync(file, "{ // my settings\n}")
      const error = yield* Effect.flip(installHooks({ file, layout: "wrapped" }, ours))
      expect(error).toBeInstanceOf(HookFileError)
      expect(readFileSync(file, "utf-8")).toBe("{ // my settings\n}")
    }).pipe(Effect.provide(nodeLayer)))
})

describe("other agents' tool calls", () => {
  it("reads Gemini CLI's and Droid's shell and edit tools as Claude Code's", () => {
    expect(asClaudeCall({ session_id: "s", tool_name: "run_shell_command", tool_input: { command: "yarn test" } })).toMatchObject({ tool_name: "Bash", tool_input: { command: "yarn test" } })
    expect(asClaudeCall({ session_id: "s", tool_name: "Execute", tool_input: { cmd: ["git", "status"] } })).toMatchObject({ tool_name: "Bash", tool_input: { command: "git status" } })
    expect(asClaudeCall({ session_id: "s", tool_name: "replace", tool_input: { file_path: "a.ts", new_str: "x" } })).toMatchObject({ tool_name: "Edit", tool_input: { new_string: "x" } })
    expect(asClaudeCall({ session_id: "s", tool_name: "Edit", tool_input: { file_path: "a.ts", new_string: "y" } }).tool_name).toBe("Edit")
  })
})

describe("finding agents", () => {
  it("in WSL, leaves out the Windows programs WSL puts on PATH", () => {
    const wsl = { WSL_DISTRO_NAME: "Ubuntu" }
    expect(isWindowsFromWsl("/mnt/c/Users/a/AppData/Roaming/npm", wsl, "linux")).toBe(true)
    expect(isWindowsFromWsl("/mnt/c", wsl, "linux")).toBe(true)
    expect(isWindowsFromWsl("/usr/local/bin", wsl, "linux")).toBe(false)
    expect(isWindowsFromWsl("/mnt/data/bin", wsl, "linux")).toBe(false)
    expect(isWindowsFromWsl("/mnt/c/tools", {}, "linux")).toBe(false)
  })
})

describe("finding Claude Code", () => {
  it("runs npm's claude.cmd as the script it runs, since node won't start a .cmd without a shell", () => {
    const shim = [
      "@ECHO off",
      String.raw`IF EXIST "%dp0%\node.exe" (`,
      String.raw`  SET "_prog=%dp0%\node.exe"`,
      ")",
      String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`
    ].join("\r\n")
    expect(commandOfShim(shim, String.raw`C:\npm`, "node.exe")).toEqual(["node.exe", String.raw`C:\npm\node_modules\@anthropic-ai\claude-code\cli.js`])
    expect(commandOfShim(String.raw`"%dp0%\bin\claude.exe" %*`, String.raw`C:\npm`)).toEqual([String.raw`C:\npm\bin\claude.exe`])
    expect(commandOfShim("@echo off", String.raw`C:\npm`)).toBeUndefined()
  })
})

describe("the singularity command", () => {
  it("writes launchers that fall back to the node on PATH", () => {
    expect(shLauncher("C:\\node.exe", "C:\\app\\src\\cli.ts")).toContain('exec "$node" "C:/app/src/cli.ts" "$@"')
    const cmd = cmdLauncher("C:/Program Files/nodejs/node.exe", "C:/app/src/cli.ts")
    expect(cmd).toContain('set "SINGULARITY_NODE=C:\\Program Files\\nodejs\\node.exe"')
    expect(cmd).toContain('"%SINGULARITY_NODE%" "C:\\app\\src\\cli.ts" %*')
  })

  it("knows whether a directory is on PATH, and puts one line in the shell's startup file", () => {
    expect(onPath("C:\\Users\\a\\.singularity\\bin", "C:\\Windows;c:/users/a/.singularity/bin/", "win32")).toBe(true)
    expect(onPath("/home/a/.singularity/bin", "/usr/bin:/bin", "linux")).toBe(false)
    expect(rcFile("/home/a", "/bin/zsh", "linux")).toBe("/home/a/.zshrc")
    expect(rcFile("/Users/a", "/bin/bash", "darwin")).toBe("/Users/a/.bash_profile")
    expect(rcFile("/home/a", "/usr/bin/fish", "linux")).toBe("/home/a/.config/fish/conf.d/singularity.fish")
    const line = rcLine("/home/a/.singularity/bin", "/home/a", false)
    expect(line).toBe(`export PATH="$HOME/.singularity/bin:$PATH" ${RC_MARKER}`)
    const once = withRcLine("alias ll='ls -l'\n", line)
    expect(withRcLine(once, line)).toBe(once)
    expect(withRcLine(once, undefined)).toBe("alias ll='ls -l'\n")
  })
})

/**
 * Claude Code as npm installs it on Windows: a `claude.cmd` shim that runs a
 * script with node (and `claude` for other systems); its script prints a version.
 */
const fakeClaude = (bin: string) => {
  mkdirSync(join(bin, "node_modules", "fake-claude"), { recursive: true })
  writeFileSync(join(bin, "node_modules", "fake-claude", "cli.js"), "console.log('2.1.0 (Claude Code)')\n")
  writeFileSync(join(bin, "claude.cmd"), [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    String.raw`IF EXIST "%dp0%\node.exe" (`,
    String.raw`  SET "_prog=%dp0%\node.exe"`,
    ") ELSE (",
    `  SET "_prog=node"`,
    ")",
    String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\fake-claude\cli.js" %*`,
    ""
  ].join("\r\n"))
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec node "${join(bin, "node_modules", "fake-claude", "cli.js")}" "$@"\n`)
  chmodSync(join(bin, "claude"), 0o755)
}

/** A home with agents' directories, and the options setup runs with there (only Claude Code on PATH, so directories decide the rest). */
const sandbox = (agentDirs: ReadonlyArray<string>) => {
  const root = tempDir()
  const home = join(root, "home")
  for (const d of agentDirs) mkdirSync(join(home, d), { recursive: true })
  fakeClaude(join(root, "bin"))
  const options: SetupOptions = {
    yes: true,
    only: [],
    path: false,
    cwd: root,
    home,
    env: { PATH: join(root, "bin"), PATHEXT: ".EXE;.CMD;.BAT" },
    interactive: false,
    color: false
  }
  return { root, home, memory: join(home, ".singularity"), options }
}

describe("setup", () => {
  it("sets memory up in every agent found, writes the command and the skill, and turns learning on", async () => {
    const { home, memory, options } = sandbox([".claude", ".codex", ".gemini", ".factory", ".cursor"])
    // The user's own hooks and settings stay.
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }))
    await withEnv({ SINGULARITY_HOME: memory }, () => run(runSetup(options)))

    const claude = json(join(home, ".claude", "settings.json"))
    expect(claude.model).toBe("opus")
    expect(Object.keys(claude.hooks)).toEqual(["Stop", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SessionEnd"])
    expect(Object.keys(json(join(home, ".codex", "hooks.json")).hooks)).toEqual(["UserPromptSubmit", "PostToolUse"])
    expect(Object.keys(json(join(home, ".gemini", "settings.json")).hooks)).toEqual(["BeforeAgent", "AfterTool"])
    expect(Object.keys(json(join(home, ".factory", "hooks.json")))).toEqual(["UserPromptSubmit", "PostToolUse"])
    expect(existsSync(join(home, ".cursor", "hooks.json"))).toBe(false)
    for (const d of [".claude/skills", ".agents/skills", ".factory/skills"]) {
      expect(readFileSync(join(home, d, "singularity", "SKILL.md"), "utf-8")).toBe(SKILL_TEXT)
    }
    expect(existsSync(join(memory, "bin", "singularity"))).toBe(true)
    expect((await withEnv({ SINGULARITY_HOME: memory }, () => run(readLearn(memory)))).auto).toBe(true)

    // Run again: nothing doubles.
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf-8")
    await withEnv({ SINGULARITY_HOME: memory }, () => run(runSetup(options)))
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).toBe(before)

    // Status sees it; uninstall takes it all out and leaves the user's own.
    const dirs = { home, env: options.env }
    const states = await run(Effect.gen(function*() {
      return yield* agentStates(yield* detectAgents(dirs, () => Effect.succeed(false)), dirs)
    }))
    expect(states.filter((s) => s.hookEvents.length > 0).map((s) => s.agent.id)).toEqual(["claude", "codex", "gemini", "droid"])
    expect(states.find((s) => s.agent.id === "cursor")?.skill).toBe(true)
    const removed = await run(unwireAll(dirs))
    expect(removed.hookFiles).toHaveLength(4)
    expect(json(join(home, ".claude", "settings.json"))).toEqual({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } })
    // Files setup made itself go.
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false)
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(false)
    expect(await run(skillState(join(home, ".agents", "skills")))).toBe("missing")
  }, 60_000)

  it("puts Droid's hooks in its settings.json when the user keeps theirs there", async () => {
    const { home, memory, options } = sandbox([".factory"])
    writeFileSync(join(home, ".factory", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }))
    await withEnv({ SINGULARITY_HOME: memory }, () => run(runSetup(options)))
    expect(existsSync(join(home, ".factory", "hooks.json"))).toBe(false)
    expect(Object.keys(json(join(home, ".factory", "settings.json")).hooks)).toEqual(["Stop", "UserPromptSubmit", "PostToolUse"])
  })

  it("never removes a skill of the user's own that has the same name", async () => {
    const { home, memory, options } = sandbox([".claude"])
    mkdirSync(join(home, ".claude", "skills", "singularity"), { recursive: true })
    writeFileSync(join(home, ".claude", "skills", "singularity", "SKILL.md"), "---\nname: singularity\ndescription: mine\n---\n")
    await withEnv({ SINGULARITY_HOME: memory }, () => run(runSetup(options)))
    expect(readFileSync(join(home, ".claude", "skills", "singularity", "SKILL.md"), "utf-8")).toContain("description: mine")
    await run(unwireAll({ home, env: options.env }))
    expect(existsSync(join(home, ".claude", "skills", "singularity", "SKILL.md"))).toBe(true)
  })
})
