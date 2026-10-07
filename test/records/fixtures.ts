/**
 * Builders for traces and records in tests.
 */
import { DateTime } from "effect"
import type { Response, ToolCall, Trace } from "../../src/traces/index.ts"

export interface CallSpec {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly result?: string | undefined
  readonly isError?: boolean | undefined
}

export const bash = (command: string, result: string, isError = false): CallSpec => ({
  name: "Bash",
  input: { command },
  result,
  isError
})

export const edit = (file: string, newString: string, result = "ok", isError = false): CallSpec => ({
  name: "Edit",
  input: { file_path: file, old_string: "x", new_string: newString },
  result,
  isError
})

export const CWD = "C:\\work\\repo"

/**
 * A session where each element of `turns` is one model response and the
 * calls it made. Response i uses 10,000 × (i + 1) tokens, so detour costs are
 * easy to check.
 */
export const session = (prompt: string, turns: ReadonlyArray<ReadonlyArray<CallSpec>>, cwd = CWD): Trace => {
  const at = (s: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 10, 0, s))
  const responses: Array<Response> = []
  const toolCalls: Array<ToolCall> = []
  turns.forEach((calls, i) => {
    const ids = calls.map((_, j) => `t${i}-${j}`)
    responses.push({
      id: `msg_${i}`,
      model: "claude-test",
      agentId: undefined,
      timestamp: at(i * 2),
      usage: { input_tokens: 0, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000 * (i + 1) - 1000 },
      text: "",
      toolCallIds: ids,
      stopReason: "tool_use"
    })
    calls.forEach((c, j) =>
      toolCalls.push({
        id: ids[j],
        name: c.name,
        input: c.input,
        agentId: undefined,
        startedAt: at(i * 2),
        finishedAt: at(i * 2 + 1),
        result: c.result,
        isError: c.isError ?? false
      })
    )
  })
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    path: "session.jsonl",
    cwd,
    gitBranch: "main",
    version: "2.1.286",
    prompts: [{ text: prompt, timestamp: at(0) }],
    responses,
    toolCalls,
    apiErrors: 0,
    costState: undefined,
    startedAt: at(0),
    endedAt: at(turns.length * 2),
    skippedLines: 0
  }
}

/** The same session as `session`, as the JSONL transcript Claude Code would write. */
export const sessionJsonl = (prompt: string, turns: ReadonlyArray<ReadonlyArray<CallSpec>>, cwd = CWD): string => {
  const ts = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString()
  const lines: Array<unknown> = [{ type: "user", timestamp: ts(0), cwd, message: { role: "user", content: prompt } }]
  turns.forEach((calls, i) => {
    const usage = { input_tokens: 0, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000 * (i + 1) - 1000 }
    const blocks = calls.map((c, j) => ({ type: "tool_use", id: `t${i}-${j}`, name: c.name, input: c.input }))
    lines.push({ type: "assistant", timestamp: ts(i * 2 + 1), cwd, message: { id: `msg_${i}`, model: "claude-test", content: blocks, usage } })
    lines.push({
      type: "user",
      timestamp: ts(i * 2 + 2),
      message: {
        role: "user",
        content: calls.map((c, j) => ({ type: "tool_result", tool_use_id: `t${i}-${j}`, content: c.result ?? "", is_error: c.isError ?? false }))
      }
    })
  })
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

export const DIFF = `diff --git a/src/keys.ts b/src/keys.ts
index 1..2 100644
--- a/src/keys.ts
+++ b/src/keys.ts
@@ -1,2 +1,3 @@
 A: "a",
-Z: "z",
+M: "m",
+N: "n",
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const x = 1
diff --git a/tests/__snapshots__/a.test.tsx.snap b/tests/__snapshots__/a.test.tsx.snap
--- a/tests/__snapshots__/a.test.tsx.snap
+++ b/tests/__snapshots__/a.test.tsx.snap
@@ -1 +1 @@
-old
+new
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/img.png b/img.png
GIT binary patch
literal 10
Rcmb=-

`
