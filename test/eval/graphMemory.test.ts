import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { toEditSet } from "../../src/eval/GraphLearner.ts"
import type { LearnedEdits } from "../../src/eval/GraphLearner.ts"
import { LEARN_LOG, makeGraphMemory, renderChecklist, stepOrder } from "../../src/eval/GraphMemory.ts"
import { makeSetup } from "../../src/eval/Memory.ts"
import { runKind } from "../../src/eval/Report.ts"
import { runSuite } from "../../src/eval/Runner.ts"
import { makeSavedScripts } from "../../src/eval/SavedScripts.ts"
import type { MemorySetup, Outcome } from "../../src/eval/Setups.ts"
import type { Task } from "../../src/eval/Suite.ts"
import { loadSuite } from "../../src/eval/Suite.ts"
import { Edge, EdgeFacts, Graph, GraphStore, JsonGraphStore, Node } from "../../src/graph/index.ts"
import { FAKE_CLAUDE, makeRepo, run, tempDir, withEnv, writeSuite } from "./helpers.ts"

const DIFF = `diff --git a/src/keys.ts b/src/keys.ts
--- a/src/keys.ts
+++ b/src/keys.ts
@@ -1 +1,2 @@
 A: "a",
+M: "m",
`

const task = (prompt: string, id = "zen"): Task => ({
  id,
  prompt,
  base: "HEAD",
  family: undefined,
  checks: [],
  checkFiles: undefined
})

const ZEN = "Change the zen mode keyboard shortcut from Alt+Z to Alt+M and update the help dialog"

const outcome = (t = task(ZEN)): Outcome => ({ task: t, success: true, trace: undefined, diff: DIFF })

const noFacts = { paths: [], commands: [], dead_ends: [] }

const node = (id: string, type: "start" | "action" | "end", description: string) => ({
  id,
  type,
  description,
  command_patterns: [],
  script: null
})

/** start -> add_key_code -> update_help_dialog -> run_checks -> end */
const ANSWER: LearnedEdits = {
  rationale: "first run",
  delete_edges: [],
  delete_nodes: [],
  add_nodes: [
    node("start", "start", "Task begins"),
    { ...node("add_key_code", "action", "Add the key code for the keyboard shortcut"), command_patterns: ["keys\\.ts"] },
    node("update_help_dialog", "action", "List the keyboard shortcut in the help dialog"),
    node("run_checks", "action", "Run the scoped checks"),
    node("end", "end", "Done")
  ],
  add_edges: [
    {
      source: "start",
      target: "add_key_code",
      relation: "leads_to",
      condition: "when the task adds or changes a shortcut",
      guidance: "Add an entry to the key code table",
      pitfalls: null,
      facts: { ...noFacts, paths: ["src/keys.ts"] }
    },
    {
      source: "add_key_code",
      target: "update_help_dialog",
      relation: "leads_to",
      condition: null,
      guidance: "The help dialog spells shortcuts out itself",
      pitfalls: "It doesn't read the shortcut map",
      facts: { ...noFacts, paths: ["src/HelpDialog.tsx"] }
    },
    {
      source: "update_help_dialog",
      target: "run_checks",
      relation: "leads_to",
      condition: null,
      guidance: null,
      pitfalls: null,
      facts: { paths: [], commands: ["yarn vitest run tests/x.test.tsx"], dead_ends: ["searching for the bare letter finds unrelated matches"] }
    },
    { source: "run_checks", target: "end", relation: "leads_to", condition: null, guidance: null, pitfalls: null, facts: noFacts }
  ]
}

/** Refused by the store: an edge to a node that doesn't exist. */
const INVALID: LearnedEdits = {
  ...ANSWER,
  add_edges: [...ANSWER.add_edges, { ...ANSWER.add_edges[0], source: "end", target: "ghost" }]
}

const withAnswers = async <A>(answers: ReadonlyArray<unknown>, f: (file: string) => Promise<A>): Promise<A> => {
  const file = join(tempDir(), "answers.json")
  writeFileSync(file, JSON.stringify(answers))
  return withEnv({ FAKE_CLAUDE_ANSWERS: file }, () => f(file))
}

const learner = () => ({ claude: FAKE_CLAUDE, cwd: join(tempDir(), "learner"), model: "sonnet", effort: "high" })

const headOf = (root: string, graphId: string) =>
  run(Effect.gen(function*() {
    const store = yield* GraphStore
    return yield* store.head(graphId)
  }).pipe(Effect.provide(JsonGraphStore.layer(root))))

describe("graph memory", () => {
  it("learns from a run, then hands over the matching steps", async () => {
    const root = join(tempDir(), "mem")
    await withAnswers([ANSWER], async (file) => {
      await run(makeGraphMemory({ root, graphId: "unit", frozen: false, learner: learner() }).afterRun(outcome()))
      assert.strictEqual(await headOf(root, "unit"), 1)

      const call = JSON.parse(readFileSync(`${file}.call0.json`, "utf-8"))
      assert.include(call.prompt, ZEN)
      assert.include(call.prompt, '+M: "m"')
      assert.include(call.prompt, "(empty: this is the first run)")
      assert.include(call.system, "JavaScript regular expressions")
      assert.strictEqual(call.args[call.args.indexOf("--tools") + 1], "")
      assert.strictEqual(call.args[call.args.indexOf("--model") + 1], "sonnet")
      const [line] = readFileSync(join(root, LEARN_LOG), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
      assert.deepStrictEqual([line.task_id, line.version, line.attempts, line.cost_usd], ["zen", 1, 1, 0.01])
      assert.isTrue(existsSync(join(root, "learn-prompts", "001-zen.md")))
    })

    const frozen = makeGraphMemory({ root, graphId: "unit", frozen: true })
    const similar = await run(frozen.beforeRun(task("Add a keyboard shortcut for snapping, listed in the help dialog", "snap"), root))
    const text = similar.systemPrompt ?? ""
    assert.include(text, "1. **Add the key code for the keyboard shortcut**")
    assert.include(text, "   - When: when the task adds or changes a shortcut")
    assert.include(text, "   - Avoid: It doesn't read the shortcut map")
    assert.include(text, "`src/HelpDialog.tsx`")
    assert.include(text, "   - Dead end: searching for the bare letter finds unrelated matches")
    assert.notInclude(text, "Task begins")
    assert.notInclude(text, "**Done**") // an end step with nothing to say is left out
    assert.isBelow(text.indexOf("Add the key code"), text.indexOf("help dialog**"))
    assert.deepStrictEqual(similar.info.sources, ["zen"])
    assert.include(similar.info.nodes as Array<string>, "update_help_dialog")

    const unrelated = await run(frozen.beforeRun(task("Rename the database table", "db"), root))
    assert.isUndefined(unrelated.systemPrompt)
    assert.deepStrictEqual(unrelated.info.nodes, [])
  })

  it("lets a model pick the steps that apply, and charges the run for it", async () => {
    const root = join(tempDir(), "mem")
    const picked = {
      decisions: [
        { id: "add_key_code", why: "no new key", applies: false },
        { id: "update_help_dialog", why: "the task names it", applies: true },
        { id: "run_checks", why: "always", applies: true },
        { id: "nope", why: "made up", applies: true }
      ]
    }
    await withAnswers([ANSWER, picked, picked, { not: "a selection" }], async (file) => {
      await run(makeGraphMemory({ root, graphId: "unit", frozen: false, learner: learner() }).afterRun(outcome()))
      const selector = { claude: FAKE_CLAUDE, cwd: join(tempDir(), "selector"), model: "haiku" }
      const setup = makeGraphMemory({ root, graphId: "unit", frozen: true, selector })
      const prompt = task("List the keyboard shortcut in the help dialog", "x")

      const injection = await run(setup.beforeRun(prompt, root))
      const text = injection.systemPrompt ?? ""
      assert.include(text, "1. **List the keyboard shortcut in the help dialog**")
      assert.include(text, "2. **Run the scoped checks**")
      assert.notInclude(text, "Add the key code")
      assert.include(text, "Avoid: It doesn't read the shortcut map") // its only way in is from an unchosen step
      assert.deepStrictEqual(injection.info.nodes, ["update_help_dialog", "run_checks"]) // graph order, unknown ids dropped
      assert.strictEqual(injection.spent?.costUsd, 0.01)
      assert.deepStrictEqual((injection.info.selector as { reasons: Array<string> }).reasons, [
        "not add_key_code: no new key",
        "update_help_dialog: the task names it",
        "run_checks: always",
        "nope: made up"
      ])
      const call = JSON.parse(readFileSync(`${file}.call1.json`, "utf-8"))
      assert.strictEqual(call.args[call.args.indexOf("--model") + 1], "haiku")
      assert.include(call.args, JSON.stringify({ alwaysThinkingEnabled: false }))
      assert.include(call.prompt, "- update_help_dialog: List the keyboard shortcut in the help dialog")
      assert.include(call.prompt, "  applies: when the task adds or changes a shortcut")
      assert.notInclude(call.prompt, "- start:")

      // Unrelated tasks don't call the model at all.
      const unrelated = await run(setup.beforeRun(task("Rename the database table", "db"), root))
      assert.isUndefined(unrelated.spent)

      // The same task again uses the third answer; the fourth doesn't fit the schema,
      // so every candidate is handed over and the error is recorded.
      await run(setup.beforeRun(prompt, root))
      const failed = await run(setup.beforeRun(prompt, root))
      assert.include(failed.systemPrompt ?? "", "Add the key code")
      assert.include((failed.info.selector as { error: string }).error, "schema")
      assert.isUndefined(failed.spent)
    })
  })

  it("adds what memory spent to the run's cost and tokens", async () => {
    const root = tempDir()
    const repo = makeRepo(root)
    await withEnv({ CLAUDE_CONFIG_DIR: join(root, "claude-home") }, async () => {
      const suite = await run(loadSuite(writeSuite(root, repo)))
      const spending: MemorySetup = {
        name: "spending",
        beforeRun: () =>
          Effect.succeed({
            systemPrompt: "notes",
            info: {},
            spent: {
              costUsd: 0.5,
              usage: { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
            }
          }),
        afterRun: () => Effect.void
      }
      const [record] = (await run(
        runSuite(suite, spending, join(root, "out"), FAKE_CLAUDE, { workspaces: join(root, "ws"), taskIds: ["t1"] })
      )) as Array<Record<string, any>>
      assert.closeTo(record.cost_usd, 0.0123 + 0.5, 1e-9)
      assert.strictEqual(record.tokens.total, 350 + 1010 + 1010) // the agent, its side call, then memory
      assert.deepStrictEqual(record.memory_spent, {
        cost_usd: 0.5,
        tokens: { input: 1000, output: 10, cache_creation: 0, cache_read: 0, total: 1010 }
      })
    })
  })

  it("retries once when the store refuses the edits", async () => {
    const root = join(tempDir(), "mem")
    await withAnswers([INVALID, ANSWER], async (file) => {
      await run(makeGraphMemory({ root, graphId: "unit", frozen: false, learner: learner() }).afterRun(outcome()))
      assert.strictEqual(await headOf(root, "unit"), 1)
      const retry = JSON.parse(readFileSync(`${file}.call1.json`, "utf-8"))
      assert.include(retry.prompt, "Your previous answer was refused")
      assert.include(retry.prompt, "ghost")
      const [line] = readFileSync(join(root, LEARN_LOG), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
      assert.strictEqual(line.attempts, 2)
      assert.closeTo(line.cost_usd, 0.02, 1e-9)
    })
  })

  it("doesn't learn when frozen, and hands over nothing before it has learned", async () => {
    const root = join(tempDir(), "mem")
    const frozen = makeGraphMemory({ root, graphId: "unit", frozen: true })
    await run(frozen.afterRun(outcome()))
    assert.isFalse(existsSync(join(root, LEARN_LOG)))
    const injection = await run(frozen.beforeRun(task(ZEN), root))
    assert.isUndefined(injection.systemPrompt)
    assert.strictEqual(injection.info.version, 0)
  })

  it("can hand over an earlier version, with the sources it had then", async () => {
    const root = join(tempDir(), "mem")
    const STATE: LearnedEdits = {
      ...ANSWER,
      add_nodes: [node("add_state_field", "action", "Add an app state field for the setting")],
      add_edges: [
        { source: "start", target: "add_state_field", relation: "leads_to", condition: null, guidance: null, pitfalls: null, facts: noFacts }
      ]
    }
    await withAnswers([ANSWER, STATE], async () => {
      const learning = makeGraphMemory({ root, graphId: "unit", frozen: false, learner: learner() })
      await run(learning.afterRun(outcome()))
      await run(learning.afterRun(outcome(task("Add a minimap setting", "minimap"))))
    })
    const prompt = task("Add a keyboard shortcut and an app state field for the setting, listed in the help dialog", "x")
    const head = await run(makeGraphMemory({ root, graphId: "unit", frozen: true }).beforeRun(prompt, root))
    assert.deepStrictEqual([head.info.version, head.info.sources], [2, ["minimap", "zen"]])
    assert.include(head.systemPrompt ?? "", "app state field")
    const v1 = makeGraphMemory({ root, graphId: "unit", frozen: true, version: 1 })
    const old = await run(v1.beforeRun(prompt, root))
    assert.deepStrictEqual([old.info.version, old.info.sources], [1, ["zen"]])
    assert.notInclude(old.systemPrompt ?? "", "app state field")
    const tooNew = makeGraphMemory({ root, graphId: "unit", frozen: true, version: 3 })
    assert.include((await run(Effect.flip(tooNew.beforeRun(prompt, root)))).message, "no version 3")
  })

  it("is built by name", async () => {
    const setup = await run(makeSetup("graph", tempDir(), true, { graphId: "unit" }))
    assert.strictEqual(setup.name, "graph")
    assert.include((await run(Effect.flip(makeSetup("graph", tempDir())))).message, "graph id")
  })
})

describe("graph learner", () => {
  it("keeps other repositories' facts when it revises an edge", () => {
    const current = Graph.fromArrays(
      [new Node({ id: "a", type: "action", description: "a" }), new Node({ id: "b", type: "action", description: "b" })],
      [
        new Edge({
          source: "a",
          target: "b",
          facts: {
            other: new EdgeFacts({ paths: ["lib/b.py"] }),
            unit: new EdgeFacts({ paths: ["src/old.ts"] })
          }
        })
      ]
    )
    const edge = (paths: Array<string>) => ({
      source: "a",
      target: "b",
      relation: "leads_to" as const,
      condition: null,
      guidance: "new advice",
      pitfalls: null,
      facts: { ...noFacts, paths }
    })
    const learned: LearnedEdits = { ...ANSWER, add_nodes: [], add_edges: [edge(["src/first.ts"]), edge(["src/b.ts"])] }
    const edits = toEditSet(learned, "unit", current)
    assert.strictEqual(edits.add_edges.length, 1) // listed twice: the last one wins
    const revised = edits.add_edges[0]
    assert.strictEqual(revised.guidance, "new advice")
    assert.deepStrictEqual(revised.facts["unit"]?.paths, ["src/b.ts"])
    assert.deepStrictEqual(revised.facts["other"]?.paths, ["lib/b.py"])

    const cleared = toEditSet({ ...learned, add_edges: [edge([])] }, "unit", current).add_edges[0]
    assert.deepStrictEqual(Object.keys(cleared.facts), ["other"])
  })

  it("orders steps along the edges, breaking cycles", () => {
    const ids = ["start", "a", "b", "c", "end"]
    const g = (extra: Array<[string, string]>) =>
      Graph.fromArrays(
        ids.map((id) => new Node({ id, type: id === "start" ? "start" : id === "end" ? "end" : "action", description: id })),
        [["start", "a"], ["a", "b"], ["b", "c"], ["c", "end"], ...extra].map(([source, target]) => new Edge({ source, target }))
      )
    assert.deepStrictEqual(stepOrder(g([["start", "c"]])), ids) // c waits for b despite the shortcut
    assert.deepStrictEqual(stepOrder(g([["b", "a"]])), ids) // the a <-> b cycle breaks at a, nearer the start
    const sub = g([])
    assert.include(renderChecklist(sub, stepOrder(sub), "unit"), "1. **a**")
  })

  it("shows a step's conditions only when every way into it has one", () => {
    const g = Graph.fromArrays(
      ["start", "a", "b"].map((id) => new Node({ id, type: id === "start" ? "start" : "action", description: id })),
      [
        new Edge({ source: "start", target: "a", condition: "when a is missing" }),
        new Edge({ source: "start", target: "b", condition: "when a already exists" }),
        new Edge({ source: "a", target: "b" })
      ]
    )
    const text = renderChecklist(g, stepOrder(g), "unit")
    assert.include(text, "1. **a**\n   - When: when a is missing")
    assert.notInclude(text, "when a already exists")
  })
})

describe("reports and saved-scripts variants", () => {
  it("classifies graph runs by what the graph learned from", () => {
    const rec = (task: string, nodes: Array<string>) => ({ task_id: task, injection: { sources: ["zen"], nodes } })
    assert.strictEqual(runKind(rec("zen", ["a"])), "exact repeat")
    assert.strictEqual(runKind(rec("snap", ["a"])), "similar task")
    assert.strictEqual(runKind(rec("snap", [])), "no match")
    assert.strictEqual(runKind({ task_id: "zen", injection: { retrieved: { task_id: "zen" } } }), "exact repeat")
  })

  it("top2 hands over a second saved run only when it is similar enough", async () => {
    const root = tempDir()
    const mem = join(root, "mem")
    const learn = makeSavedScripts(mem)
    await run(learn.afterRun({ task: task(ZEN, "zen"), success: true, trace: undefined, diff: DIFF }))
    await run(
      learn.afterRun({
        task: task("Add a minimap toggle setting stored in appState, with an Alt+M shortcut listed in the help dialog", "minimap"),
        success: true,
        trace: undefined,
        diff: DIFF
      })
    )
    const top1 = makeSavedScripts(mem, true)
    const top2 = makeSavedScripts(mem, true, 2)
    assert.strictEqual(top2.name, "saved-scripts-top2")

    // Similarity 0.67 to the minimap prompt and 0.45 to zen mode's: both clear 0.35.
    const both = await run(top2.beforeRun(task("Add a snap setting with an Alt+S shortcut listed in the help dialog", "snap"), root))
    const text = both.systemPrompt ?? ""
    assert.include(text, "## Example 1")
    assert.isBelow(text.indexOf("minimap toggle"), text.indexOf("Alt+Z to Alt+M"))
    assert.deepStrictEqual((both.info.retrieved as { task_id: string }).task_id, "minimap")
    assert.deepStrictEqual((both.info.also_retrieved as Array<{ task_id: string }>).map((r) => r.task_id), ["zen"])

    // 0.53 to zen mode's prompt, 0.14 to minimap's: one example, exactly as top-1 gives it.
    const zenOnly = task("Change the zen mode shortcut", "other")
    const one = await run(top2.beforeRun(zenOnly, root))
    assert.strictEqual(one.systemPrompt, (await run(top1.beforeRun(zenOnly, root))).systemPrompt)
    assert.isUndefined(one.info.also_retrieved)
  })
})
