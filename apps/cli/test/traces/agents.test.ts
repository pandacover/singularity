import { describe, expect, it } from "@effect/vitest"
import { patchEdits } from "../../src/traces/ApplyPatch.ts"
import { isCodexRollout, parseCodexRollout } from "../../src/traces/Codex.ts"
import { type HermesMessage, type HermesSession, hermesRef, hermesTrace, hermesTranscript } from "../../src/traces/Hermes.ts"
import { scriptCalls } from "../../src/traces/JsLiteral.ts"
import { traceUsage } from "../../src/traces/index.ts"
import { decodeHookInput } from "../../src/handover/HookInput.ts"

describe("patches", () => {
  it("are a Write per file added and an Edit per hunk, context in both sides", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1",
      "+export const b = 2",
      "*** Update File: src/app.ts",
      "@@ export const colors",
      " const x = 1",
      "-const y = 2",
      "+const y = 3",
      "@@",
      "-old()",
      "+fresh()",
      "+more()",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
      ""
    ].join("\n")
    expect(patchEdits(patch)).toEqual([
      { tool: "Write", file: "src/new.ts", input: { file_path: "src/new.ts", content: "export const a = 1\nexport const b = 2\n" } },
      { tool: "Edit", file: "src/app.ts", input: { file_path: "src/app.ts", old_string: "const x = 1\nconst y = 2", new_string: "const x = 1\nconst y = 3" } },
      { tool: "Edit", file: "src/app.ts", input: { file_path: "src/app.ts", old_string: "old()", new_string: "fresh()\nmore()" } }
    ])
    expect(patchEdits("not a patch")).toEqual([])
  })
})

describe("code-mode scripts", () => {
  it("give their tool calls with literal arguments, by value or through a name", () => {
    const script = [
      "const patch = \"*** Begin Patch\\n*** End Patch\";",
      "const r = await tools.shell_command({command:\"npm test\", 'workdir': `C:\\\\repo`, timeout_ms: 120_000});",
      "text(r); await tools.apply_patch(patch);",
      "await tools.exec_command({ cmd: `git ${verb}` }); // not a literal",
      "await tools.update_plan()"
    ].join("\n")
    expect(scriptCalls(script)).toEqual([
      { tool: "shell_command", args: { command: "npm test", workdir: "C:\\repo", timeout_ms: 120000 } },
      { tool: "apply_patch", args: "*** Begin Patch\n*** End Patch" },
      { tool: "exec_command", args: undefined },
      { tool: "update_plan", args: {} }
    ])
  })
})

const codexLine = (sec: number, type: string, payload: object) =>
  JSON.stringify({ timestamp: `2026-09-01T10:00:${String(sec).padStart(2, "0")}.000Z`, type, payload })

describe("Codex rollouts", () => {
  const meta = codexLine(0, "session_meta", { id: "019f-codex", cwd: "C:\\repo", cli_version: "0.155.0" })

  it("are told apart by their first line", () => {
    expect(isCodexRollout(meta)).toBe(true)
    expect(isCodexRollout(JSON.stringify({ type: "user", message: {} }))).toBe(false)
    expect(isCodexRollout("not json")).toBe(false)
  })

  it("read as Claude Code's: shells as Bash with their exit codes, patches as edits, a script's calls each with its output", () => {
    const script = "await tools.shell_command({command: \"npm run build\"}); await tools.shell_command({command: \"npm test\"}); await tools.apply_patch(\"*** Begin Patch\\n*** Update File: a.ts\\n@@\\n-a\\n+b\\n*** End Patch\")"
    const text = [
      meta,
      codexLine(0, "turn_context", { cwd: "C:\\repo", model: "gpt-test" }),
      codexLine(0, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for C:\\repo" }] }),
      codexLine(0, "event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Fix the build" }] } }),
      codexLine(1, "response_item", { type: "function_call", call_id: "a", name: "shell", arguments: JSON.stringify({ command: ["powershell.exe", "-Command", "rg build"] }) }),
      codexLine(2, "response_item", { type: "function_call_output", call_id: "a", output: JSON.stringify({ output: "found", metadata: { exit_code: 0 } }) }),
      codexLine(2, "event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } } }),
      // A repeated count spends nothing.
      codexLine(2, "event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } } }),
      codexLine(3, "response_item", { type: "custom_tool_call", call_id: "b", name: "exec", input: script }),
      codexLine(4, "response_item", {
        type: "custom_tool_call_output",
        call_id: "b",
        output: [{ type: "input_text", text: "Script running with cell ID 7\nWall time 10 seconds\nOutput:\n" }, { type: "input_text", text: "Exit code: 0\nWall time: 3 seconds\nOutput:\nbuilt\n" }]
      }),
      codexLine(5, "response_item", { type: "function_call", call_id: "c", name: "wait", arguments: JSON.stringify({ cell_id: "7" }) }),
      codexLine(9, "response_item", {
        type: "function_call_output",
        call_id: "c",
        output: [{ type: "input_text", text: "Script completed\nWall time 4 seconds\nOutput:\n" }, { type: "input_text", text: "Exit code: 1\nWall time: 4 seconds\nOutput:\n1 failed\n" }, { type: "input_text", text: "{}" }]
      }),
      codexLine(9, "event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 140 }, last_token_usage: { input_tokens: 25, cached_input_tokens: 0, output_tokens: 5 } } })
    ].join("\n")
    const trace = parseCodexRollout(text, "C:/codex/rollout.jsonl")
    expect(trace.sessionId).toBe("019f-codex")
    expect(trace.cwd).toBe("C:\\repo")
    expect(trace.prompts.map((p) => p.text)).toEqual(["Fix the build"])
    expect(trace.toolCalls.map((c) => [c.name, c.input.command ?? c.input.file_path, c.isError, c.result])).toEqual([
      ["Bash", "rg build", false, "found"],
      ["Bash", "npm run build", false, "Exit code: 0\nWall time: 3 seconds\nOutput:\nbuilt\n"],
      ["Bash", "npm test", true, "Exit code: 1\nWall time: 4 seconds\nOutput:\n1 failed\n{}"],
      ["Edit", "a.ts", false, ""]
    ])
    expect(trace.responses.map((r) => r.toolCallIds.length)).toEqual([1, 3])
    expect(traceUsage(trace)).toEqual({ input_tokens: 65, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 60 })
  })
})

const session = (over: Partial<HermesSession>): HermesSession => ({ id: "s1", source: "cli", model: "hermes-test", cwd: "C:\\repo", ...over })
const message = (id: number, role: string, over: Partial<HermesMessage> = {}): HermesMessage => ({ id, role, timestamp: 1_788_000_000 + id, ...over })
const calls = (...list: Array<[string, string, object]>) =>
  JSON.stringify(list.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })))

describe("Hermes Agent's sessions", () => {
  it("are named by their database and id", () => {
    const transcript = hermesTranscript("C:\\Users\\a\\AppData\\Local/hermes/state.db", "20260901_100000_abc")
    expect(hermesRef(transcript)).toEqual({ db: "C:\\Users\\a\\AppData\\Local/hermes/state.db", sessionId: "20260901_100000_abc" })
    expect(hermesRef("C:\\Users\\a\\.claude\\projects\\x\\s.jsonl")).toBeUndefined()
  })

  it("read as Claude Code's, with Windows paths for its shell's and the totals on the first response", () => {
    const patch = "*** Begin Patch\n*** Update File: /c/repo/b.ts\n@@\n-x\n+y\n*** End Patch"
    const trace = hermesTrace([{
      session: session({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 300, cache_write_tokens: 0, estimated_cost_usd: 0.05 }),
      messages: [
        message(1, "user", { content: "Rename the flag" }),
        message(2, "assistant", {
          content: "Looking",
          tool_calls: calls(["r", "read_file", { path: "/c/repo/a.ts" }], ["g", "search_files", { pattern: "flag", path: "C:/repo", file_glob: "*.ts" }], ["f", "search_files", { pattern: "*.md", target: "files" }])
        }),
        message(3, "tool", { tool_call_id: "r", tool_name: "read_file", content: JSON.stringify({ content: "1|flag" }) }),
        message(4, "tool", { tool_call_id: "g", tool_name: "search_files", content: JSON.stringify({ total_count: 1 }) }),
        message(5, "tool", { tool_call_id: "f", tool_name: "search_files", content: JSON.stringify({ total_count: 0 }) }),
        message(6, "assistant", { tool_calls: calls(["p", "patch", { mode: "patch", patch }], ["e", "patch", { path: "/c/repo/a.ts", old_string: "flag", new_string: "toggle" }]) }),
        message(7, "tool", { tool_call_id: "p", tool_name: "patch", content: JSON.stringify({ success: true }) }),
        message(8, "tool", { tool_call_id: "e", tool_name: "patch", content: JSON.stringify({ success: false, error: "old_string not found" }) }),
        message(9, "user", { content: "[IMPORTANT: Background process proc_1 finished]" }),
        message(10, "assistant", { tool_calls: calls(["t", "terminal", { command: "npm test", workdir: "/c/repo" }]) }),
        message(11, "tool", { tool_call_id: "t", tool_name: "terminal", content: JSON.stringify({ output: "1 failed", exit_code: 1, error: null }) })
      ]
    }], "C:/hermes/state.db#s1")
    expect(trace.prompts.map((p) => p.text)).toEqual(["Rename the flag"])
    expect(trace.toolCalls.map((c) => [c.name, c.input.file_path ?? c.input.pattern ?? c.input.command, c.isError, c.result])).toEqual([
      ["Read", "C:/repo/a.ts", false, "1|flag"],
      ["Grep", "flag", false, JSON.stringify({ total_count: 1 })],
      ["Glob", "*.md", false, JSON.stringify({ total_count: 0 })],
      ["Edit", "C:/repo/b.ts", false, JSON.stringify({ success: true })],
      ["Edit", "C:/repo/a.ts", true, JSON.stringify({ success: false, error: "old_string not found" })],
      ["Bash", "npm test", true, "1 failed"]
    ])
    expect(trace.toolCalls[1].input).toMatchObject({ path: "C:/repo", glob: "*.ts" })
    expect(trace.responses.map((r) => r.usage.input_tokens)).toEqual([100, 0, 0])
    expect(trace.costState).toEqual({ totalCostUSD: 0.05 })
  })
})

describe("hook input", () => {
  it("takes Codex's session end, whose transcript may be null", () => {
    expect(decodeHookInput(JSON.stringify({ session_id: "s", cwd: "C:\\repo", hook_event_name: "SessionEnd", reason: "other", transcript_path: null }))?.transcript_path).toBeNull()
  })
})
