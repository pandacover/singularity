/**
 * Stands in for `claude -p` in harness tests.
 *
 * Writes `answer.txt` in the working directory, logs a transcript where Claude
 * Code would, and prints a result object. Records the arguments and
 * environment it saw, so tests can check what the harness passed through.
 *
 * With `--json-schema` it stands in for a structured LLM call instead: it
 * answers with the next entry of the JSON array in $FAKE_CLAUDE_ANSWERS (the
 * last one repeats), and records each call as `<that file>.call<n>.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log("0.0.0 (fake)")
  process.exit(0)
}

if (args.includes("--json-schema")) {
  const file = process.env.FAKE_CLAUDE_ANSWERS!
  const answers: Array<unknown> = JSON.parse(readFileSync(file, "utf-8"))
  const counter = `${file}.calls`
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf-8")) : 0
  writeFileSync(counter, String(n + 1))
  const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf-8")
  writeFileSync(`${file}.call${n}.json`, JSON.stringify({ args, cwd: process.cwd(), system, prompt: readFileSync(0, "utf-8") }))
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.01,
    modelUsage: { "claude-fake": { inputTokens: 100, outputTokens: 50 } },
    structured_output: answers[Math.min(n, answers.length - 1)]
  }))
  process.exit(0)
}

const sessionId = args[args.indexOf("--session-id") + 1]
const prompt = readFileSync(0, "utf-8")
const cwd = process.cwd()
writeFileSync(join(cwd, "answer.txt"), "42\n")

const ts = (s: number) => `2026-10-01T10:00:0${s}.000Z`
const usage = { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }
const lines = [
  { type: "user", timestamp: ts(0), cwd, message: { role: "user", content: prompt } },
  {
    type: "assistant",
    timestamp: ts(1),
    message: {
      id: "msg_1",
      model: "claude-fake",
      content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: join(cwd, "answer.txt"), content: "42" } }],
      usage
    }
  },
  { type: "user", timestamp: ts(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "assistant", timestamp: ts(3), message: { id: "msg_2", model: "claude-fake", content: [{ type: "text", text: "Done" }], usage } }
]
const project = join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"))
mkdirSync(project, { recursive: true })
writeFileSync(join(project, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
writeFileSync(join(project, `${sessionId}.env.json`), JSON.stringify({ args, env: process.env }))

console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    duration_ms: 1234,
    session_id: sessionId,
    total_cost_usd: 0.0123,
    permission_denials: [],
    // Includes a side call the transcript doesn't show.
    modelUsage: {
      "claude-fake": { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 200, cacheCreationInputTokens: 100 },
      "claude-side": { inputTokens: 1000, outputTokens: 10 }
    }
  })
)
