import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agents, hermesHome } from "../../src/setup/Agents.ts"
import { enablesPlugin, pluginCode, withoutPlugin, withPluginEnabled } from "../../src/setup/HermesPlugin.ts"

const enabled = (text: string) => {
  const edit = withPluginEnabled(text)
  if ("problem" in edit) throw new Error(edit.problem)
  return edit.text
}
const disabled = (text: string) => {
  const edit = withoutPlugin(text)
  if ("problem" in edit) throw new Error(edit.problem)
  return edit.text
}

/** A Python 3 to run the plugin with, if this machine has one. */
const PYTHON = [["python"], ["python3"], ["py", "-3"]]
  .map(([cmd, ...args]) => ({ cmd: cmd!, args }))
  .find(({ cmd, args }) => {
    const r = spawnSync(cmd, [...args, "-I", "-c", "import sys; print(sys.version_info >= (3, 8))"], { encoding: "utf8", timeout: 10_000 })
    return r.status === 0 && r.stdout.trim() === "True"
  })

/** Loads the plugin from argv[1], stubs its hook script, and prints what each hook gave. */
const DRIVE_PLUGIN = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("singularity_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
calls = []
def hook(event, payload, timeout):
    calls.append([event, payload.get("prompt") or payload.get("tool_input", {}).get("command")])
    return None if payload.get("prompt") == "hi" else "memory's text"
plugin._hook = hook
show = {"command": "git show HEAD~1"}
print(json.dumps({
    "hi": plugin.on_pre_llm_call(session_id="s1", user_message="hi"),
    "task": plugin.on_pre_llm_call(session_id="s1", user_message="add a rule like MD062"),
    "notStarted": plugin.on_transform_tool_result(tool_name="terminal", args=show, result="diff --git a/x b/x", session_id="s2"),
    "started": plugin.on_transform_tool_result(tool_name="terminal", args=show, result="diff --git a/x b/x", session_id="s1"),
    "calls": calls,
}))
`

describe("Hermes Agent's home", () => {
  it("is HERMES_HOME, else its platform's default", () => {
    expect(hermesHome({ home: "/home/a", env: { HERMES_HOME: "~/work/hermes" } })).toBe("/home/a/work/hermes")
    expect(hermesHome({ home: "/home/a", env: {}, platform: "linux" })).toBe("/home/a/.hermes")
    expect(hermesHome({ home: "/home/a", env: { HERMES_DATA_DIR_SUFFIX: "-dev" }, platform: "darwin" })).toBe("/home/a/.hermes-dev")
    expect(hermesHome({ home: "C:\\Users\\a", env: { LOCALAPPDATA: "D:\\Local" }, platform: "win32" })).toBe("D:/Local/hermes")
    expect(hermesHome({ home: "C:\\Users\\a", env: {}, platform: "win32" })).toBe("C:/Users/a/AppData/Local/hermes")
  })

  it("holds the plugin, the config that enables it, and the skills folder Hermes reads", () => {
    const hermes = agents({ home: "/home/a", env: {}, platform: "linux" }).find((a) => a.id === "hermes")!
    expect(hermes.plugin).toEqual({ dir: "/home/a/.hermes/plugins/singularity", config: "/home/a/.hermes/config.yaml" })
    expect(hermes.skillDirs).toEqual(["/home/a/.hermes/skills"])
    expect(hermes.commands).toEqual([])
    expect(hermes.reach).toBe("stores")
  })
})

describe("enabling the plugin in Hermes's config.yaml", () => {
  it("adds it to an enabled list as Hermes writes it, and takes it out to give the file back as it was", () => {
    const config = [
      "model:",
      "  default: stealth/ox-alpha  # mine",
      "plugins:",
      "  enabled:",
      "    - image_gen/openai",
      "    - image_gen/openai-codex",
      "  disabled:",
      "    - browser/browser_use",
      "known_builtin_toolsets:",
      "  - terminal",
      ""
    ].join("\n")
    const on = enabled(config)
    expect(on).toBe(config.replace("    - image_gen/openai-codex\n", "    - image_gen/openai-codex\n    - singularity\n"))
    expect(enablesPlugin(on)).toBe(true)
    expect(enabled(on)).toBe(on)
    expect(disabled(on)).toBe(config)
    expect(disabled(config)).toBe(config)
  })

  it("keeps Windows line endings and a byte order mark", () => {
    const config = "\uFEFFplugins:\r\n  enabled:\r\n  - a\r\n"
    expect(enabled(config)).toBe("\uFEFFplugins:\r\n  enabled:\r\n  - a\r\n  - singularity\r\n")
  })

  it("makes the list under plugins when it's missing, above the comments of what is there", () => {
    const config = "# Plugin Installation\nplugins:\n  # Deadline for each Git clone.\n  clone_timeout_seconds: 300\n\n# Model\nmodel:\n  default: x\n"
    expect(enabled(config)).toBe(
      "# Plugin Installation\nplugins:\n  enabled:\n    - singularity\n  # Deadline for each Git clone.\n  clone_timeout_seconds: 300\n\n# Model\nmodel:\n  default: x\n"
    )
  })

  it("makes a plugins section at the end of a config without one, or of an empty one", () => {
    expect(enabled("model:\n  default: x\n")).toBe("model:\n  default: x\nplugins:\n  enabled:\n    - singularity\n")
    expect(enabled("model: x")).toBe("model: x\nplugins:\n  enabled:\n    - singularity\n")
    expect(enabled("")).toBe("plugins:\n  enabled:\n    - singularity\n")
    expect(enabled("# nothing yet\n")).toBe("# nothing yet\nplugins:\n  enabled:\n    - singularity\n")
  })

  it("edits lists and sections written inline", () => {
    expect(enabled("plugins:\n  enabled: []\n")).toBe("plugins:\n  enabled: [singularity]\n")
    expect(enabled("plugins: {}\n")).toBe("plugins: {enabled: [singularity]}\n")
    expect(enabled("plugins: {enabled: [a], disabled: [singularity, b]}\n")).toBe("plugins: {enabled: [a, singularity], disabled: [b]}\n")
    expect(disabled("plugins:\n  enabled: [a, singularity]\n")).toBe("plugins:\n  enabled: [a]\n")
  })

  it("takes it out of plugins.disabled, which wins, leaving an empty list a list", () => {
    expect(enabled("plugins:\n  enabled:\n    - a\n  disabled:\n    - singularity\n")).toBe("plugins:\n  enabled:\n    - a\n    - singularity\n  disabled: []\n")
    expect(disabled("plugins:\n  enabled:\n    - singularity\n  hook_callback_timeout: 30\n")).toBe("plugins:\n  enabled: []\n  hook_callback_timeout: 30\n")
  })

  it("leaves a config it can't edit safely alone, and says why", () => {
    expect(withPluginEnabled("plugins: [\n")).toEqual({ problem: "isn't valid YAML" })
    expect(withPluginEnabled("a: 1\n---\nb: 2\n")).toEqual({ problem: "isn't valid YAML" })
    expect(withPluginEnabled("plugins:\n  enabled:\n")).toHaveProperty("problem")
    expect(withPluginEnabled("plugins:\n  enabled: some-plugin\n")).toHaveProperty("problem")
    expect(withPluginEnabled("- a\n- b\n")).toHaveProperty("problem")
  })

  it("reads what Hermes would load", () => {
    expect(enablesPlugin("plugins:\n  enabled: [singularity]\n  disabled: [singularity]\n")).toBe(false)
    expect(enablesPlugin("plugins:\n  enabled: [singularity]\n")).toBe(true)
    expect(enablesPlugin("not: [valid\n")).toBe(false)
  })
})

describe("the plugin's code", () => {
  it("runs the hook script with the node setup ran with, by full paths in Python strings", () => {
    const code = pluginCode({ node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\a b\\.singularity\\app\\apps\\cli\\src\\workflows\\hook.ts" })
    expect(code).toContain(`NODE = "C:/Program Files/nodejs/node.exe"`)
    expect(code).toContain(`SCRIPT = "C:/Users/a b/.singularity/app/apps/cli/src/workflows/hook.ts"`)
    expect(code).toContain(`ctx.register_hook("pre_llm_call", on_pre_llm_call)`)
    expect(code).toContain(`ctx.register_hook("transform_tool_result", on_transform_tool_result)`)
    expect(code).toContain(`ctx.register_hook("on_session_finalize", on_session_finalize)`)
    // Python's escapes reach the file as written.
    expect(code).toContain(`return f"{result}\\n\\n{text}" if text else None`)
  })

  // The plugin run by Python, with the hook script stubbed: Hermes isn't needed, a Python 3 is.
  it.skipIf(PYTHON === undefined)("hands each message in a repository to the hook script, which tells the ones that start a task", () => {
    const dir = mkdtempSync(join(tmpdir(), "singularity-hermes-"))
    try {
      const home = join(dir, "home")
      const repo = join(dir, "repo")
      mkdirSync(join(repo, ".git"), { recursive: true })
      mkdirSync(join(home, "tenants", "local", "scripts", "sessions"), { recursive: true })
      writeFileSync(join(home, "config.json"), JSON.stringify({ tenant: "local" }))
      // Session s1 had a task start under memory; s2 has had none.
      writeFileSync(join(home, "tenants", "local", "scripts", "sessions", "s1"), "")
      const plugin = join(dir, "plugin.py")
      writeFileSync(plugin, pluginCode({ node: "C:\\nowhere\\node.exe", script: "C:\\nowhere\\hook.ts" }))
      const run = spawnSync(PYTHON!.cmd, [...PYTHON!.args, "-I", "-c", DRIVE_PLUGIN, plugin], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, SINGULARITY_HOME: home, TERMINAL_CWD: repo }
      })
      expect(run.stderr).toBe("")
      expect(JSON.parse(run.stdout)).toEqual({
        // A message that asks for nothing gets nothing, and the next one is still the hook script's to judge,
        // as is every message after the session's first task.
        hi: null,
        task: { context: "memory's text" },
        notStarted: null,
        started: "diff --git a/x b/x\n\nmemory's text",
        calls: [["user-prompt-submit", "hi"], ["user-prompt-submit", "add a rule like MD062"], ["post-tool-use", "git show HEAD~1"]]
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
