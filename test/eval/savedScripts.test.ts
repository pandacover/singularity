import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { learnFrom } from "../../src/eval/Learn.ts"
import { makeSetup } from "../../src/eval/Memory.ts"
import { runSuite } from "../../src/eval/Runner.ts"
import {
  bestMatch,
  makeEntry,
  makeSavedScripts,
  MIN_SIMILARITY,
  render,
  reportsFailure,
  splitDiff
} from "../../src/eval/SavedScripts.ts"
import type { Outcome } from "../../src/eval/Setups.ts"
import { NoMemory } from "../../src/eval/Setups.ts"
import type { Task } from "../../src/eval/Suite.ts"
import { loadSuite } from "../../src/eval/Suite.ts"
import type { ToolCall, Trace } from "../../src/traces/index.ts"
import { FAKE_CLAUDE, run, makeRepo, tempDir, withEnv, writeSuite } from "./helpers.ts"


const DIFF = `diff --git a/src/keys.ts b/src/keys.ts
--- a/src/keys.ts
+++ b/src/keys.ts
@@ -1 +1,2 @@
 A: "a",
+M: "m",
diff --git a/tests/__snapshots__/x.test.tsx.snap b/tests/__snapshots__/x.test.tsx.snap
--- a/tests/__snapshots__/x.test.tsx.snap
+++ b/tests/__snapshots__/x.test.tsx.snap
@@ -1 +1 @@
-old
+new
`

const task = (prompt = "Change the zen mode shortcut from Alt+Z to Alt+M", id = "zen"): Task => ({
  id,
  prompt,
  base: "HEAD",
  family: undefined,
  checks: [],
  checkFiles: undefined
})

/** A trace with `calls` successful shell commands; makeEntry only reads its tool calls. */
const fakeTrace = (calls: number): Trace => ({
  sessionId: "s",
  path: "s.jsonl",
  cwd: undefined,
  gitBranch: undefined,
  version: undefined,
  prompts: [],
  responses: [],
  toolCalls: Array.from({ length: calls }, (_, i): ToolCall => ({
    id: `t${i}`,
    name: "Bash",
    input: { command: `echo ${i}` },
    agentId: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    result: undefined,
    isError: false
  })),
  apiErrors: 0,
  costState: undefined,
  startedAt: undefined,
  endedAt: undefined,
  skippedLines: 0
})

const outcome = (success: boolean | null, trace?: Trace, t = task()): Outcome => ({ task: t, success, trace, diff: DIFF })

describe("saved-scripts", () => {
  it("splits snapshots out of the diff", () => {
    const [files, snaps, source] = splitDiff(DIFF)
    assert.deepStrictEqual(files, ["src/keys.ts"])
    assert.deepStrictEqual(snaps, ["tests/__snapshots__/x.test.tsx.snap"])
    assert.include(source, 'M: "m"')
    assert.notInclude(source, "+new")
  })

  it("learns only from successes, and not when frozen", async () => {
    const mem = join(tempDir(), "mem")
    const s = makeSavedScripts(mem)
    await run(s.afterRun(outcome(false)))
    assert.deepStrictEqual(await run(s.entries), [])
    await run(makeSavedScripts(mem, true).afterRun(outcome(true)))
    assert.deepStrictEqual(await run(s.entries), [])
    await run(s.afterRun(outcome(true)))
    const [e] = await run(s.entries)
    assert.strictEqual(e.task_id, "zen")
    assert.deepStrictEqual(e.files_changed, ["src/keys.ts"])
  })

  it("keeps the cheapest run per prompt", async () => {
    const s = makeSavedScripts(join(tempDir(), "mem"))
    for (const calls of [10, 5, 8]) await run(s.afterRun(outcome(true, fakeTrace(calls))))
    const entries = await run(s.entries)
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].tool_calls, 5)
    assert.strictEqual(entries[0].commands.at(-1), "echo 4")
  })

  it("retrieves by prompt similarity", async () => {
    const root = tempDir()
    const s = makeSavedScripts(join(root, "mem"))
    await run(s.afterRun(outcome(true)))
    const similar = await run(s.beforeRun(task("Change the view mode shortcut from Alt+R to Alt+J", "view"), root))
    assert.include(similar.systemPrompt ?? "", "Alt+Z to Alt+M")
    assert.deepStrictEqual((similar.info.retrieved as { task_id: string }).task_id, "zen")
    assert.isAtLeast(similar.info.similarity as number, MIN_SIMILARITY)
    const unrelated = await run(s.beforeRun(task("Add a minimap toggle stored in appState", "minimap"), root))
    assert.isUndefined(unrelated.systemPrompt)
    assert.isNull(unrelated.info.retrieved)
    assert.deepStrictEqual(bestMatch("anything", []), [undefined, 0])
  })

  it("doesn't save commands whose output reports a failure", () => {
    const trace = fakeTrace(0)
    const call = (command: string, result: string, isError = false): ToolCall => ({
      ...fakeTrace(1).toolCalls[0],
      input: { command },
      result,
      isError
    })
    const yarnFailed = "$ vitest --update --watch=false --watch=false\nerror Command failed with exit code 1.\n"
    const testsFailed = "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m2361 passed"
    const entry = makeEntry(outcome(true, {
      ...trace,
      toolCalls: [
        call("yarn test:update --watch=false 2>&1 | tail -40", yarnFailed),
        call("yarn vitest run x.test.tsx | tail -5", testsFailed),
        call("yarn tsc | head", "src/a.ts(1,7): error TS2322: Type 'string' is not assignable"),
        call("exit 3", "Exit code 3", true),
        call("yarn test:update 2>&1 | tail -40", "Tests  2362 passed | 0 failed (2410)\nDone in 95.76s.")
      ]
    }))
    assert.deepStrictEqual(entry.commands, ["yarn test:update 2>&1 | tail -40"])
    assert.isFalse(reportsFailure("Test Files  139 passed (139)"))
  })

  it("lists snapshots in the notes without their content", () => {
    const text = render(makeEntry(outcome(true)))
    assert.include(text, "x.test.tsx.snap")
    assert.notInclude(text, "+new")
    assert.include(text, "```diff")
  })

  it("builds setups by name", async () => {
    assert.strictEqual((await run(makeSetup("no-memory"))).name, "no-memory")
    assert.include((await run(Effect.flip(makeSetup("saved-scripts")))).message, "memory")
    assert.include((await run(Effect.flip(makeSetup("nope")))).message, "unknown")
  })

  it("learns, then helps a frozen run, end to end", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    await withEnv({ CLAUDE_CONFIG_DIR: join(root, "claude-home") }, async () => {
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const mem = join(root, "mem")
      const ws = join(root, "ws")
      const [first] = await run(runSuite(suite, makeSavedScripts(mem), join(root, "learn"), FAKE_CLAUDE, { workspaces: ws, taskIds: ["t1"] }))
      assert.isTrue(first.success as boolean)
      assert.isNull((first.injection as Record<string, unknown>).retrieved)
      assert.strictEqual((await run(makeSavedScripts(mem).entries)).length, 1)

      // A relative output dir, as the CLI passes it: the injected file's path
      // must still resolve from the agent's working directory (the workspace).
      const cwd = process.cwd()
      process.chdir(root)
      try {
        const [second] = (await run(
          runSuite(suite, makeSavedScripts(mem, true), "measure", FAKE_CLAUDE, { workspaces: ws, taskIds: ["t1"] })
        )) as Array<Record<string, any>>
        assert.strictEqual(second.status, "completed")
        assert.strictEqual(second.injection.retrieved.task_id, "t1")
        assert.isTrue(second.injection.frozen)
        const args: Array<string> = second.agent.command
        const injected = args[args.indexOf("--append-system-prompt-file") + 1]
        assert.isTrue(/^([A-Za-z]:[\\/]|\/)/.test(injected))
        assert.include(readFileSync(injected, "utf-8"), "answer.txt")
      } finally {
        process.chdir(cwd)
      }
    })
  })

  it("learns from recorded runs", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    await withEnv({ CLAUDE_CONFIG_DIR: join(root, "claude-home") }, async () => {
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const base = join(root, "base")
      await run(runSuite(suite, NoMemory, base, FAKE_CLAUDE, { workspaces: join(root, "ws"), reps: 2 }))
      const mem = join(root, "mem")
      const n = await run(learnFrom(makeSavedScripts(mem), suite, [base], ["t1"]))
      assert.strictEqual(n, 2)
      const [e] = await run(makeSavedScripts(mem).entries) // two successful t1 runs, deduped by prompt
      assert.strictEqual(e.task_id, "t1")
      assert.deepStrictEqual(e.files_changed, ["answer.txt"])
      assert.strictEqual(e.tool_calls, 1)
    })
  })
})
