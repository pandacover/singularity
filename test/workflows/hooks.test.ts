import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeSetup } from "../../src/eval/Memory.ts"
import { runSuite } from "../../src/eval/Runner.ts"
import { loadSuite } from "../../src/eval/Suite.ts"
import { identifyRepo } from "../../src/local/Git.ts"
import { loadHome } from "../../src/local/Home.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { placeIdOf } from "../../src/workflows/Evidence.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { FORMAT, type WorkflowCues, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { placeKey, placeOfAddition } from "../../src/workflows/Places.ts"
import { WorkflowStore } from "../../src/workflows/WorkflowStore.ts"
import { FAKE_CLAUDE, git, run, seenByAgent, tempDir, withEnv, writeSuite } from "../eval/helpers.ts"

const CONFIG = ["export const CODES = {", '  A: "KeyA",', '  B: "KeyB",', "} as const;", ""].join("\n")

/** A repo whose first commit has config.ts with a table of key codes; the suite's tasks start there. */
const makeKeysRepo = (root: string): string => {
  const repo = join(root, "src-repo")
  mkdirSync(repo)
  git(repo, "init", "-q")
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n")
  writeFileSync(join(repo, "config.ts"), CONFIG)
  writeFileSync(join(repo, "app.txt"), "v1\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "one")
  writeFileSync(join(repo, "app.txt"), "v2\n")
  git(repo, "commit", "-qam", "two")
  return repo
}

/** A memory home with one workflow at the key-code table (with `cues`, if given), and a pitfall that fires on the doubled watch flag. */
const seedHome = (homeDir: string, repo: string, cues?: WorkflowCues) =>
  run(Effect.gen(function*() {
    const home = yield* loadHome(homeDir)
    const subject = yield* Effect.gen(function*() {
      return (yield* (yield* RecordStore).subjectFor((yield* identifyRepo(repo))!, { create: true }))!
    }).pipe(Effect.provide(JsonRecordStore.layer(home.tenantDir, home.tenant)))
    const shape = placeOfAddition("config.ts", CONFIG.split("\n"), 3, 2)
    const place = placeIdOf(subject.id, placeKey(shape))
    const memory: WorkflowMemory = {
      format: FORMAT,
      tenant: home.tenant,
      places: [{ id: place, subject: subject.id, ...shape, new_file: null, evidence: ["r1", "r2"], tasks: ["t0"], edits: { add: 2, change: 0, create: 0 } }],
      workflows: [{
        id: "add-key-code",
        subject: subject.id,
        name: "Add a key code",
        use_when: "a task needs a new key",
        ...(cues === undefined ? {} : { cues }),
        only_if_asked: false,
        blanks: [{ name: "letter", meaning: "the new key's letter" }],
        steps: [{ do: "Add `{letter}: \"Key{letter}\"` to the table.", place, when: null }],
        checks: ["yarn test:update"],
        pitfalls: ["watch-flag"],
        evidence: ["r1", "r2"],
        tasks: ["t0"]
      }],
      edges: [
        { from: "start", to: "add-key-code", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null },
        { from: "add-key-code", to: "end", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null }
      ],
      pitfalls: [{
        id: "watch-flag",
        subject: subject.id,
        text: "`yarn test:update` already passes --watch=false; don't add it again.",
        trigger: { on: "command", all: ["test:update", "--watch=false"], none: [], file: null },
        evidence: ["r1"],
        cost_tokens: 40000
      }]
    }
    yield* Effect.gen(function*() {
      const store = yield* WorkflowStore
      yield* store.commit((yield* store.propose(memory, { rationale: "test", records: [] })).id)
    }).pipe(Effect.provide(JsonWorkflowStore.layer(join(home.tenantDir, "workflows"), home.tenant)))
    return place
  }))

describe("the workflows setup (memory v1)", () => {
  it("hands workflows over through v1's own hooks during the run, and counts the selection's model call", async () => {
    const root = tempDir()
    const repo = makeKeysRepo(root)
    const claudeHome = join(root, "claude-home")
    const homeDir = join(root, "memory-home")
    const answers = join(root, "answers.json")
    await withEnv({
      CLAUDE_CONFIG_DIR: claudeHome,
      SINGULARITY_WORKSPACES: join(root, "workspaces"),
      FAKE_CLAUDE_ANSWERS: answers,
      FAKE_CLAUDE_BASH: "yarn test:update --watch=false"
    }, async () => {
      const place = await seedHome(homeDir, repo)
      writeFileSync(answers, JSON.stringify([{ workflows: [{ id: "add-key-code", applies: true, why: "needs a key", skip_steps: [] }] }]))
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const setup = await run(makeSetup("workflows", homeDir, true, { selector: { claude: FAKE_CLAUDE, cwd: join(root, "llm"), model: "sonnet" } }))
      const out = join(root, "out")
      const [r] = (await run(runSuite(suite, setup, out, FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] }))) as Array<Record<string, any>>
      const runDir = join(out, "runs", r.run_id)
      assert.isTrue(r.success)
      const errors = join(runDir, "memory-home", "hook-errors.log")
      assert.isFalse(existsSync(errors), existsSync(errors) ? readFileSync(errors, "utf-8") : "")

      const seen = seenByAgent(claudeHome, r.session_id)
      assert.strictEqual(seen.env.SINGULARITY_HOME, join(runDir, "memory-home"))
      const said = (event: string): Array<string> =>
        seen.hook_outputs.filter((o) => o.event === event && o.stdout !== "").map((o) => JSON.parse(o.stdout).hookSpecificOutput.additionalContext)
      // The workflow at the first prompt, with its place found in the run's working tree.
      const log = join(runDir, "memory-home", "tenants", "local", "workflows", "handovers.jsonl")
      const start = said("UserPromptSubmit")[0]
      assert.isDefined(start, JSON.stringify({ outputs: seen.hook_outputs, log: existsSync(log) ? readFileSync(log, "utf-8") : null }))
      assert.include(start, "## 1. Add a key code")
      assert.include(start, "`config.ts:1-4` in export const CODES = {")
      assert.include(start, '    3|   B: "KeyB",')
      // The pitfall at the start, and once more when its trigger appeared.
      assert.include(start, "Watch out: `yarn test:update` already passes --watch=false")
      assert.strictEqual(said("PostToolUse").length, 1)
      assert.include(said("PostToolUse")[0], "--watch=false")

      // The run's record says what was handed over, and the selection's call ($0.01, 150 tokens) counts toward it.
      assert.deepStrictEqual([r.injection.task_start, r.injection.nodes, r.injection.version, r.injection.hook_errors], [true, ["add-key-code"], 1, 0])
      assert.deepStrictEqual(r.injection.shown, [{ place, file: "config.ts", from: 1, to: 4 }])
      assert.deepStrictEqual(r.injection.fired.map((f: { pitfall: string }) => f.pitfall), ["watch-flag"])
      assert.strictEqual(r.memory_spent.cost_usd, 0.01)
      assert.strictEqual(r.tokens.total, 1360 + 150)
      assert.include(readFileSync(join(runDir, "injected.md"), "utf-8"), "Add a key code")

      // The home is as it was; the run's copy keeps only what the session wrote.
      const tenant = (home: string) => join(home, "tenants", "local")
      assert.isFalse(existsSync(join(tenant(homeDir), "workflows", "sessions")))
      assert.isTrue(existsSync(join(tenant(join(runDir, "memory-home")), "workflows", "handovers.jsonl")))
      assert.isFalse(existsSync(join(tenant(join(runDir, "memory-home")), "workflows", "versions")))
    })
  }, 60_000)

  it("with workflows-draft, hands over the change drafted at task start, and counts both model calls", async () => {
    const root = tempDir()
    const repo = makeKeysRepo(root)
    const claudeHome = join(root, "claude-home")
    const homeDir = join(root, "memory-home")
    const answers = join(root, "answers.json")
    await withEnv({ CLAUDE_CONFIG_DIR: claudeHome, SINGULARITY_WORKSPACES: join(root, "workspaces"), FAKE_CLAUDE_ANSWERS: answers }, async () => {
      await seedHome(homeDir, repo)
      writeFileSync(answers, JSON.stringify([
        { workflows: [{ id: "add-key-code", applies: true, why: "needs a key", skip_steps: [] }] },
        {
          edits: [
            { file: "config.ts", old: '  B: "KeyB",', new: '  B: "KeyB",\n  M: "KeyM",' },
            { file: "config.ts", old: '  Q: "KeyQ",', new: '  Q: "KeyQ",\n  R: "KeyR",' }
          ],
          files: [],
          after: ["Run `yarn test:update`."],
          unsure: []
        }
      ]))
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const setup = await run(makeSetup("workflows-draft", homeDir, true, { selector: { claude: FAKE_CLAUDE, cwd: join(root, "llm"), model: "sonnet" } }))
      const out = join(root, "out")
      const [r] = (await run(runSuite(suite, setup, out, FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] }))) as Array<Record<string, any>>
      const runDir = join(out, "runs", r.run_id)
      const errors = join(runDir, "memory-home", "hook-errors.log")
      assert.isFalse(existsSync(errors), existsSync(errors) ? readFileSync(errors, "utf-8") : "")
      assert.strictEqual(r.setup, "workflows-draft")
      // The task-start hook may take long enough for both calls.
      assert.strictEqual(JSON.parse(readFileSync(join(runDir, "hooks.json"), "utf-8")).hooks.UserPromptSubmit[0].hooks[0].timeout, 420)

      const start = seenByAgent(claudeHome, r.session_id).hook_outputs
        .filter((o) => o.event === "UserPromptSubmit" && o.stdout !== "")
        .map((o) => JSON.parse(o.stdout).hookSpecificOutput.additionalContext)[0]
      assert.include(start, "# The change for this task")
      assert.include(start, '`config.ts`, line 3:\n```diff\n   B: "KeyB",\n+  M: "KeyM",\n```')
      assert.include(start, "1. Run `yarn test:update`.")
      assert.include(start, "Watch out: `yarn test:update` already passes --watch=false")
      // The edit whose old line isn't in the file is left out, and said so in the record.
      assert.deepStrictEqual([r.injection.draft.used, r.injection.draft.edits, r.injection.draft.dropped.length], [true, 1, 1])
      // Both calls ($0.01 and 150 tokens each) count toward the run.
      assert.strictEqual(r.memory_spent.cost_usd, 0.02)
      assert.strictEqual(r.tokens.total, 1360 + 300)
    })
  }, 60_000)

  it("with workflows-cues, picks by memory's cues without a model call, and fills the blanks the task states", async () => {
    const root = tempDir()
    const repo = makeKeysRepo(root)
    const claudeHome = join(root, "claude-home")
    const homeDir = join(root, "memory-home")
    // No answers for the fake model: a model call would fail, and words would pick instead.
    await withEnv({ CLAUDE_CONFIG_DIR: claudeHome, SINGULARITY_WORKSPACES: join(root, "workspaces") }, async () => {
      await seedHome(homeDir, repo, { any: ["answer.txt"], none: [], steps: [], fills: [{ placeholder: "{letter}", from: "after", n: 1, phrase: "Write" }] })
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const setup = await run(makeSetup("workflows-cues", homeDir, true, { selector: { claude: FAKE_CLAUDE, cwd: join(root, "llm"), model: "sonnet" } }))
      const out = join(root, "out")
      const [r] = (await run(runSuite(suite, setup, out, FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] }))) as Array<Record<string, any>>
      const runDir = join(out, "runs", r.run_id)
      const errors = join(runDir, "memory-home", "hook-errors.log")
      assert.isFalse(existsSync(errors), existsSync(errors) ? readFileSync(errors, "utf-8") : "")
      assert.strictEqual(r.setup, "workflows-cues")

      const start = seenByAgent(claudeHome, r.session_id).hook_outputs
        .filter((o) => o.event === "UserPromptSubmit" && o.stdout !== "")
        .map((o) => JSON.parse(o.stdout).hookSpecificOutput.additionalContext)[0]
      assert.include(start, "Values your task states are filled in")
      assert.include(start, "Filled from your task: {letter} = `42`")
      assert.include(start, 'Add `42: "Key42"` to the table.')
      assert.include(start, "`config.ts:1-4` in export const CODES = {")
      // No model call: nothing spent beyond the agent's own tokens, and the log says the cues picked.
      assert.isTrue(r.memory_spent == null, JSON.stringify(r.memory_spent))
      assert.strictEqual(r.tokens.total, 1360)
      const log = readFileSync(join(runDir, "memory-home", "tenants", "local", "workflows", "handovers.jsonl"), "utf-8")
      assert.deepStrictEqual(JSON.parse(log.split("\n")[0]).picked_by, "cues")
    })
  }, 60_000)
})
