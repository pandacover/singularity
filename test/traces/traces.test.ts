import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import {
  findTranscript,
  metricsToJson,
  parseSession,
  repeatReads,
  SHELL_WRITE,
  toolCallDuration,
  traceAgentIds,
  traceMetrics,
  traceUsage,
  traceWallTime,
  usageToJson
} from "../../src/traces/index.ts"

const SID = "11111111-2222-3333-4444-555555555555"

const ts = (sec: number) => `2026-10-01T10:00:${String(sec).padStart(2, "0")}.000Z`

const usage = (out: number, read = 1000, write = 100) => ({
  input_tokens: 3,
  output_tokens: out,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write
})

const assistant = (sec: number, id: string, block: object, u: object, extra: object = {}) => ({
  type: "assistant",
  timestamp: ts(sec),
  sessionId: SID,
  cwd: "/repo",
  gitBranch: "main",
  version: "2.1.286",
  message: { id, model: "claude-test", role: "assistant", content: [block], usage: u, stop_reason: "tool_use" },
  ...extra
})

const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input })

const user = (sec: number, content: unknown, extra: object = {}) => ({
  type: "user",
  timestamp: ts(sec),
  sessionId: SID,
  message: { role: "user", content },
  ...extra
})

const result = (id: string, content: unknown, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error: isError
})

/** The same session the Python tests used: a main thread, one subagent, and a few awkward lines. */
const writeSession = Effect.fn("writeSession")(function*(home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const main: Array<unknown> = [
    { type: "queue-operation", operation: "enqueue", timestamp: ts(0), sessionId: SID },
    user(1, "Fix the failing test", { promptSource: "cli" }),
    // One response logged as two lines; the first carries a partial output count.
    assistant(2, "msg_1", { type: "thinking", thinking: "..." }, usage(1)),
    assistant(2, "msg_1", toolUse("t1", "Read", { file_path: "/repo/a.py" }), usage(40)),
    user(3, [result("t1", "print('a')")]),
    assistant(4, "msg_2", toolUse("t2", "Bash", { command: "pytest" }), usage(30)),
    assistant(4, "msg_2", toolUse("t3", "Read", { file_path: "/repo/a.py" }), usage(30)),
    user(5, [result("t2", [{ type: "text", text: "boom" }], true), result("t3", "print('a')")]),
    assistant(6, "msg_3", toolUse("t4", "Agent", { prompt: "find config" }), usage(20)),
    user(20, [result("t4", "config is in setup.cfg")]),
    {
      type: "assistant",
      timestamp: ts(21),
      isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] }
    },
    assistant(22, "msg_4", { type: "text", text: "Done." }, usage(10)),
    user(23, "<system-reminder>meta</system-reminder>", { isMeta: true }),
    { type: "cost-state", sessionId: SID, totalCostUSD: 0.12, modelUsage: { "claude-test": { inputTokens: 9 } } },
    "not json"
  ]
  const sub = [
    user(7, "find config", { isSidechain: true }),
    assistant(8, "msg_s1", toolUse("s1", "Grep", { pattern: "config" }), usage(5), { isSidechain: true }),
    user(9, [result("s1", "setup.cfg")], { isSidechain: true }),
    assistant(10, "msg_s2", { type: "text", text: "setup.cfg" }, usage(5), { isSidechain: true })
  ]
  const project = path.join(home, "projects", "-repo")
  yield* fs.makeDirectory(path.join(project, SID, "subagents"), { recursive: true })
  const transcript = path.join(project, `${SID}.jsonl`)
  const lines = (xs: Array<unknown>) => xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + "\n"
  yield* fs.writeFileString(transcript, lines(main))
  yield* fs.writeFileString(path.join(project, SID, "subagents", "agent-abc.jsonl"), lines(sub))
  return transcript
})

const withTempHome = <A, E>(f: (home: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* f(yield* fs.makeTempDirectoryScoped())
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("parseSession", () => {
  it.effect("reads a session and its subagents", () =>
    withTempHome((home) =>
      Effect.gen(function*() {
        const trace = yield* parseSession(yield* writeSession(home))

        assert.strictEqual(trace.sessionId, SID)
        assert.deepStrictEqual([trace.cwd, trace.gitBranch, trace.version], ["/repo", "main", "2.1.286"])
        assert.deepStrictEqual(trace.prompts.map((p) => p.text), ["Fix the failing test"])
        assert.deepStrictEqual(trace.responses.map((r) => r.id), ["msg_1", "msg_2", "msg_3", "msg_s1", "msg_s2", "msg_4"])
        assert.strictEqual(trace.apiErrors, 1)
        assert.strictEqual(trace.skippedLines, 1)
        assert.deepStrictEqual(traceAgentIds(trace), ["abc"])
        assert.strictEqual(trace.costState?.totalCostUSD, 0.12)
        assert.strictEqual(traceWallTime(trace), 23)

        // Each response counted once, with its final output count.
        assert.deepStrictEqual(trace.responses[0].usage, {
          input_tokens: 3,
          output_tokens: 40,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000
        })
        assert.deepStrictEqual(usageToJson(traceUsage(trace)), {
          input: 18,
          output: 110,
          cache_creation: 600,
          cache_read: 6000,
          total: 6728
        })

        const calls = new Map(trace.toolCalls.map((c) => [c.id, c]))
        assert.deepStrictEqual(trace.toolCalls.map((c) => c.id), ["t1", "t2", "t3", "t4", "s1"])
        assert.isTrue(calls.get("t2")!.isError)
        assert.strictEqual(calls.get("t2")!.result, "boom")
        assert.strictEqual(toolCallDuration(calls.get("t1")!), 1)
        assert.strictEqual(calls.get("s1")!.agentId, "abc")
        assert.isUndefined(calls.get("t1")!.agentId)
        assert.strictEqual(trace.responses.at(-1)!.text, "Done.")
      })
    ))

  it.effect("computes metrics", () =>
    withTempHome((home) =>
      Effect.gen(function*() {
        const m = traceMetrics(yield* parseSession(yield* writeSession(home)))
        assert.deepStrictEqual([m.apiCalls, m.toolCalls, m.toolErrors], [6, 5, 1])
        assert.deepStrictEqual(m.tools, [["Read", 2], ["Bash", 1], ["Agent", 1], ["Grep", 1]])
        assert.deepStrictEqual([m.reads, m.uniqueFilesRead, repeatReads(m)], [2, 1, 1])
        assert.deepStrictEqual([m.shellCommands, m.searches, m.subagents], [1, 1, 1])
        assert.strictEqual(metricsToJson(m).usage.total, 18 + 110 + 600 + 6000)
      })
    ))

  it.effect("finds a transcript by session id", () =>
    withTempHome((home) =>
      Effect.gen(function*() {
        const transcript = yield* writeSession(home)
        assert.strictEqual(yield* findTranscript(SID, home), transcript)
        assert.isUndefined(yield* findTranscript("nope", home))
      })
    ))
})

const shellCases: ReadonlyArray<readonly [string, boolean]> = [
  ["sed -i 's/R/M/' a.ts", true],
  ["sed -n 1,10p a.ts", false],
  ["perl -pi -e 's/a/b/' x", true],
  ["echo hi > out.txt", true],
  ["echo hi >> out.txt", true],
  ["yarn test 2>&1 | tail", false],
  ["yarn tsc > /dev/null", false],
  ["ls | tee files.txt", true],
  ["Set-Content -Path a.ts -Value x", true],
  ["git diff --stat", false],
  [`python -c "open('a.ts', 'w').write('x')"`, true]
]

describe("SHELL_WRITE", () => {
  it.each(shellCases)("%s -> %s", (command, writes) => {
    assert.strictEqual(SHELL_WRITE.test(command), writes)
  })
})
