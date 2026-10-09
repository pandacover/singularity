import { describe, expect, it } from "@effect/vitest"
import { agents, hermesHome } from "../../src/setup/Agents.ts"
import { enablesPlugin, pluginCode, withoutPlugin, withPluginEnabled } from "../../src/setup/HermesPlugin.ts"
import { asClaudeCall } from "../../src/workflows/HookTool.ts"
import { eventOfHook } from "../../src/handover/HookInput.ts"

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
    expect(hermes.reach).toBe("hands-over")
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
    // Python's escapes reach the file as written.
    expect(code).toContain(`return f"{result}\\n\\n{text}" if text else None`)
  })
})

describe("Hermes Agent's tool calls", () => {
  it("reads its terminal as Claude Code's Bash, with the output and exit code of its JSON result", () => {
    const failed = asClaudeCall({
      session_id: "s",
      tool_name: "terminal",
      tool_input: { command: "yarn test:update" },
      tool_response: JSON.stringify({ output: "1 failed", exit_code: 1, error: null })
    })
    expect(failed).toMatchObject({ tool_name: "Bash", tool_input: { command: "yarn test:update" }, error: "1 failed" })
    expect(eventOfHook(failed, "/repo")).toMatchObject({ tool: "Bash", command: "yarn test:update", output: "1 failed", failed: true })
    const passed = asClaudeCall({ session_id: "s", tool_name: "terminal", tool_input: { command: "ls" }, tool_response: "{\"output\": \"a\", \"exit_code\": 0}" })
    expect(passed.error).toBeUndefined()
    expect(eventOfHook(passed, "/repo")).toMatchObject({ output: "a", failed: false })
  })

  it("reads its patch and write_file as Claude Code's Edit and Write, with the file", () => {
    const patch = asClaudeCall({ session_id: "s", tool_name: "patch", tool_input: { path: "/repo/src/a.ts", old_string: "x", new_string: "<Excalidraw" } })
    expect(patch).toMatchObject({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts", new_string: "<Excalidraw" } })
    expect(eventOfHook(patch, "/repo")).toMatchObject({ file: "src/a.ts", text: "<Excalidraw" })
    const write = asClaudeCall({ session_id: "s", tool_name: "write_file", tool_input: { path: "/repo/b.ts", content: "y" } })
    expect(eventOfHook(write, "/repo")).toMatchObject({ tool: "Write", file: "b.ts", text: "y" })
    const raw = asClaudeCall({ session_id: "s", tool_name: "patch", tool_input: { patch: "*** Begin Patch\n@@\n-old\n+new line\n context\n*** End Patch" } })
    expect(raw.tool_input?.new_string).toBe("new line")
    const refused = asClaudeCall({ session_id: "s", tool_name: "patch", tool_input: { path: "a.ts" }, tool_response: "{\"success\": false, \"error\": \"old_string not found\"}" })
    expect(refused.error).toBe("old_string not found")
  })
})
