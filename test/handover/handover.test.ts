import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { eventOfHook } from "../../src/handover/HookInput.ts"
import { hasOurHooks, withOurHooks, withoutOurHooks } from "../../src/handover/Install.ts"
import { firing, onToolEvent } from "../../src/handover/OnTool.ts"
import { readSession } from "../../src/handover/Session.ts"
import { recordSession } from "../../src/handover/SessionEnd.ts"
import { chosenSteps, taskStart } from "../../src/handover/TaskStart.ts"
import { identifyRepo } from "../../src/local/Git.ts"
import { loadHome } from "../../src/local/Home.ts"
import { buildGraph } from "../../src/memory/Build.ts"
import * as JsonMemoryStore from "../../src/memory/JsonMemoryStore.ts"
import { diffGraphs, emptyGraph } from "../../src/memory/Models.ts"
import { MemoryStore } from "../../src/memory/MemoryStore.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { FAKE_CLAUDE, git, makeRepo, run, tempDir, withEnv } from "../eval/helpers.ts"
import { flagLesson, readRecord, step } from "../memory/fixtures.ts"
import { bash, sessionJsonl } from "../records/fixtures.ts"

const HOOK = fileURLToPath(new URL("../../src/hook.ts", import.meta.url))
const ZEN = "Change the zen mode keyboard shortcut from Alt+Z to Alt+M"

describe("installing hooks", () => {
  const script = "C:/tools/singularity/src/hook.ts"
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "lint-on-save" }] }
  const settings = { model: "sonnet", hooks: { PostToolUse: [other] } }

  it("adds ours next to other hooks and settings, once", () => {
    const once = withOurHooks(settings, "node", script)
    const twice = withOurHooks(once, "node", script)
    assert.deepStrictEqual(twice, once)
    assert.strictEqual(once.model, "sonnet")
    const post = (once.hooks as Record<string, Array<unknown>>).PostToolUse
    assert.strictEqual(post.length, 2)
    assert.deepStrictEqual(post[0], other)
    assert.deepStrictEqual(Object.keys(once.hooks as object).sort(), ["PostToolUse", "PostToolUseFailure", "SessionEnd", "UserPromptSubmit"])
    assert.isTrue(hasOurHooks(once, script))
  })

  it("removes only ours", () => {
    const removed = withoutOurHooks(withOurHooks(settings, "node", script), script)
    assert.deepStrictEqual(removed, settings)
    assert.deepStrictEqual(withoutOurHooks(withOurHooks({}, "node", script), script), {})
  })
})

describe("hook events", () => {
  it("reads shell calls, edits and failures as triggers see them", () => {
    const bashOut = eventOfHook({
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: "yarn test" },
      tool_response: { stdout: "Tests  1 failed", stderr: "" }
    }, "C:/repo")
    assert.deepStrictEqual([bashOut?.command, bashOut?.output, bashOut?.failed], ["yarn test", "Tests  1 failed", true])
    const editOut = eventOfHook({
      session_id: "s",
      tool_name: "Edit",
      tool_input: { file_path: "C:\\repo\\src\\a.test.tsx", old_string: "x", new_string: "render(<App />)" }
    }, "C:/repo")
    assert.deepStrictEqual([editOut?.file, editOut?.text, editOut?.failed], ["src/a.test.tsx", "render(<App />)", false])
    const failure = eventOfHook({
      session_id: "s",
      tool_name: "Edit",
      tool_input: { file_path: "C:/repo/a.ts", new_string: "y" },
      error: "Found 2 matches of the string to replace"
    }, "C:/repo")
    assert.deepStrictEqual([failure?.failed, failure?.output], [true, "Found 2 matches of the string to replace"])
  })

  it("fires each warning once a session", () => {
    const [w] = buildGraph([readRecord(ZEN, "k", [step("run the tests")], { flag: true, lessons: [flagLesson("run the tests")] })], { tenant: "local" }).warnings
    const event = { tool: "Bash", command: "yarn test:update --watch=false", file: undefined, text: undefined, output: undefined, failed: false }
    assert.deepStrictEqual(firing([w], new Set(), event).map((x) => x.id), [w.id])
    assert.deepStrictEqual(firing([w], new Set([w.id]), event), [])
    assert.deepStrictEqual(firing([w], new Set(), { ...event, command: "yarn test:update" }), [])
  })

  it("hands over without a model when one kind clearly matches", () => {
    const g = buildGraph([
      readRecord(ZEN, "k", [step("a", "asked"), step("b", "needed"), step("c", "chosen")]),
      readRecord(ZEN, "k", [step("a", "asked"), step("c", "chosen")])
    ], { tenant: "local" })
    // a: every run took it; b: half the runs needed it; c: only ever the agent's own choice.
    assert.deepStrictEqual(chosenSteps(g.kinds[0], undefined), ["s-a"])
    assert.deepStrictEqual(
      chosenSteps(g.kinds[0], { kind: g.kinds[0].id, why: "", steps: [{ id: "s-b", why: "", applies: true }, { id: "s-a", why: "", applies: false }] }),
      ["s-b"]
    )
  })
})

describe("a session with memory", () => {
  it("is handed its route, warned once at the trigger, and recorded with what it did with the warning", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const homeDir = join(root, "home")
    const answers = join(root, "answers.json")
    const llm = join(root, "llm")
    mkdirSync(llm)

    const outcome = await withEnv({ SINGULARITY_HOME: homeDir, FAKE_CLAUDE_ANSWERS: answers }, () =>
      run(Effect.gen(function*() {
        const home = yield* loadHome()
        const stores = Layer.merge(
          JsonRecordStore.layer(home.tenantDir, home.tenant),
          JsonMemoryStore.layer(join(home.tenantDir, "memory"), home.tenant)
        )
        return yield* Effect.gen(function*() {
          // Memory for this repo: one kind, with the doubled-flag warning on its test step.
          const subject = (yield* (yield* RecordStore).subjectFor((yield* identifyRepo(repo))!, { create: true }))!
          const g = buildGraph([
            readRecord(ZEN, "change a shortcut", [step("change the key", "asked", ["app.txt"]), step("run the tests", "needed")], {
              subject: subject.id,
              flag: true,
              lessons: [flagLesson("run the tests")]
            })
          ], { tenant: home.tenant })
          const memory = yield* MemoryStore
          yield* memory.commit((yield* memory.propose(diffGraphs(emptyGraph, g), { rationale: "test", records: [] })).id)
          const kind = g.kinds[0]
          writeFileSync(answers, JSON.stringify([{ kind: kind.id, why: "same task", steps: kind.route.map((e) => ({ id: e.step, why: "needed", applies: true })) }]))

          const start = yield* taskStart(
            { sessionId: "s1", prompt: "Change the zen mode keyboard shortcut from Alt+Z to Alt+J", cwd: repo },
            { tenantDir: home.tenantDir, selector: { claude: FAKE_CLAUDE, cwd: llm, model: "sonnet" } }
          )
          const event = { tool: "Bash", command: "yarn test:update --watch=false", file: undefined, text: undefined, output: undefined, failed: false }
          const first = yield* onToolEvent(home.tenantDir, "s1", event)
          const second = yield* onToolEvent(home.tenantDir, "s1", event)

          // The session commits a change and its last test run passes.
          writeFileSync(join(repo, "app.txt"), "v3\n")
          git(repo, "commit", "-qam", "three")
          const transcript = join(root, "s1.jsonl")
          writeFileSync(transcript, sessionJsonl("Change the zen mode shortcut", [
            [bash("yarn test:update --watch=false", "Error: Expected a single value for option\nerror Command failed with exit code 1.")],
            [bash("yarn test:update", "Tests  9 passed (9)")]
          ], repo))
          const ended = yield* recordSession({ sessionId: "s1", transcript, cwd: repo }, home.tenantDir)
          const record = ended.record === undefined ? undefined : yield* (yield* RecordStore).get(ended.record)
          return { start, first, second, ended, record, state: yield* readSession(home.tenantDir, "s1"), log: readFileSync(join(home.tenantDir, "handovers.jsonl"), "utf-8") }
        }).pipe(Effect.provide(stores))
      })))

    assert.include(outcome.start.text, "1. **change the key**")
    // One run edited the file: not enough to call it usual.
    assert.notInclude(outcome.start.text, "Usually edits")
    assert.include(outcome.start.text, "Watch out: test:update already passes --watch=false")
    assert.strictEqual(outcome.state?.triggers.length, 1)
    assert.include(outcome.first, "test:update already passes --watch=false")
    assert.isUndefined(outcome.second)
    assert.strictEqual(outcome.ended.reason, "recorded")
    assert.strictEqual(outcome.record?.run.source, "session")
    assert.strictEqual(outcome.record?.files[0]?.path, "app.txt")
    // The warning was handed over at the start and fired, and the mistake was made anyway, then not again.
    assert.deepStrictEqual(outcome.record?.memory?.items.filter((i) => i.kind === "warning").map((i) => [i.moment, i.outcome]), [
      ["start", "ignored"],
      ["trigger", "followed"]
    ])
    assert.deepStrictEqual(outcome.log.trim().split("\n").map((l) => JSON.parse(l).moment), ["start", "trigger"])
  })

  it("is handed the code at its route's spots as the working tree has it now", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    mkdirSync(join(repo, "src"))
    // Not committed, and with Windows line endings: the hand-over reads the working tree as it is.
    writeFileSync(join(repo, "src", "menu.ts"), ["export const items = [", "  actionCopy,", "  actionToggleGrid,", "  actionToggleZen,", "  actionPaste,", "]", ""].join("\r\n"))
    const task = "Add a Rulers toggle setting to the right-click menu"

    const outcome = await withEnv({ SINGULARITY_HOME: join(root, "home") }, () =>
      run(Effect.gen(function*() {
        const home = yield* loadHome()
        const stores = Layer.merge(
          JsonRecordStore.layer(home.tenantDir, home.tenant),
          JsonMemoryStore.layer(join(home.tenantDir, "memory"), home.tenant)
        )
        return yield* Effect.gen(function*() {
          const subject = (yield* (yield* RecordStore).subjectFor((yield* identifyRepo(repo))!, { create: true }))!
          // Two runs put their line between these two; one spot's line has left the code since.
          const spots = [
            { file: "src/menu.ts", above: "actionToggleGrid,", below: "actionToggleZen," },
            { file: "src/menu.ts", above: "actionToggleGone,", below: null }
          ]
          const records = [0, 1].map(() => ({
            ...readRecord(task, "add a toggle setting", [step("add the action to the menu", "asked", ["src/menu.ts"])], { subject: subject.id }),
            spots
          }))
          const memory = yield* MemoryStore
          yield* memory.commit((yield* memory.propose(diffGraphs(emptyGraph, buildGraph(records, { tenant: home.tenant })), { rationale: "test", records: [] })).id)
          const start = yield* taskStart({ sessionId: "s3", prompt: task, cwd: repo }, { tenantDir: home.tenantDir })
          return { start, log: readFileSync(join(home.tenantDir, "handovers.jsonl"), "utf-8") }
        }).pipe(Effect.provide(stores))
      })))

    // The file's lines are shown with the step, so the step doesn't list the file as well.
    assert.notInclude(outcome.start.text, "Usually edits")
    assert.include(
      outcome.start.text,
      "`src/menu.ts` (step 1):\n```\n@@ lines 1-6 @@\nexport const items = [\n  actionCopy,\n  actionToggleGrid,\n  actionToggleZen,\n  actionPaste,\n]\n```\n"
    )
    assert.notInclude(outcome.start.text, "\r")
    assert.notInclude(outcome.start.text, "actionToggleGone")
    assert.deepStrictEqual(JSON.parse(outcome.log.trim()).excerpts, [{ file: "src/menu.ts", from: 1, to: 6, steps: [1] }])
  })

  it("isn't recorded when nothing was committed", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    const transcript = join(root, "s2.jsonl")
    writeFileSync(transcript, sessionJsonl("x", [[bash("yarn test", "Tests 3 passed")]], repo))
    const ended = await withEnv({ SINGULARITY_HOME: join(root, "home") }, () =>
      run(Effect.gen(function*() {
        const home = yield* loadHome()
        return yield* recordSession({ sessionId: "s2", transcript, cwd: repo }, home.tenantDir).pipe(
          Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant))
        )
      })))
    assert.deepStrictEqual(ended, { record: undefined, reason: "nothing was committed" })
  })
})

describe("the hook script", () => {
  const hook = (event: string, input: object, env: Record<string, string>) =>
    execFileSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: "utf-8" })

  it("answers a tool call with the warning, and stays quiet when off or without memory", async () => {
    const root = tempDir()
    const homeDir = join(root, "home")
    const tenantDir = join(homeDir, "tenants", "local")
    const [w] = buildGraph([readRecord(ZEN, "k", [step("run the tests")], { flag: true, lessons: [flagLesson("run the tests")] })], { tenant: "local" }).warnings
    mkdirSync(join(tenantDir, "sessions"), { recursive: true })
    writeFileSync(join(homeDir, "config.json"), JSON.stringify({ tenant: "local" }))
    writeFileSync(join(tenantDir, "sessions", "s1.json"), JSON.stringify({
      session_id: "s1", tenant: "local", subject: "repo", repo: root, head: null, started_at: "2026-10-01T10:00:00Z",
      prompt: "x", version: 1, kind: null, steps: [], warnings: [], triggers: [w], selection: null
    }))
    const call = { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "yarn test:update --watch=false" }, tool_response: { stdout: "", stderr: "" } }
    const out = JSON.parse(hook("post-tool-use", call, { SINGULARITY_HOME: homeDir }))
    assert.strictEqual(out.hookSpecificOutput.hookEventName, "PostToolUse")
    assert.include(out.hookSpecificOutput.additionalContext, "--watch=false")
    assert.strictEqual(hook("post-tool-use", call, { SINGULARITY_HOME: homeDir }), "")
    assert.strictEqual(hook("post-tool-use", { ...call, session_id: "s9" }, { SINGULARITY_HOME: homeDir }), "")
    assert.strictEqual(hook("post-tool-use", { ...call, session_id: "s1" }, { SINGULARITY_HOME: homeDir, SINGULARITY_HOOKS: "off" }), "")
    assert.isFalse(existsSync(join(homeDir, "hook-errors.log")))
  })
})
