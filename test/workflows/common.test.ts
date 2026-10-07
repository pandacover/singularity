import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { checkCommon, commonPrompt, withKind } from "../../src/workflows/Common.ts"
import type { Evidence, RunEvidence } from "../../src/workflows/Evidence.ts"
import { fit, replay } from "../../src/workflows/Evolve.ts"
import { feedbackOf } from "../../src/workflows/Feedback.ts"
import { finishOf } from "../../src/workflows/Finish.ts"
import type { InductionAnswer } from "../../src/workflows/Induce.ts"
import type { Located } from "../../src/workflows/Locate.ts"
import { FORMAT, type Place, type Workflow, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { placesOfRead, resolvePlace } from "../../src/workflows/Places.ts"
import { renderHandover } from "../../src/workflows/Render.ts"

const HELPERS = [
  "export class Keyboard {",
  "  static withModifierKeys = (modifiers: KeyboardModifiers, cb: () => void) => {",
  "    cb();",
  "  };",
  "",
  "  static keyPress = (key: string, target?: HTMLElement | Document | Window) => {",
  "    fireEvent.keyDown(target, { key });",
  "  };",
  "}"
]

const readPlace = (id: string, tasks: ReadonlyArray<string>, evidence: ReadonlyArray<string>): Place => ({
  id,
  subject: "repo",
  ...placesOfRead("tests/helpers/ui.ts", HELPERS, [5])[0],
  new_file: null,
  evidence: [...evidence],
  tasks: [...tasks],
  edits: { add: 0, change: 0, create: 0 },
  reads: evidence.length,
  show: "outline"
})

const run = (record: string, task: string, over: Partial<RunEvidence> = {}): RunEvidence => ({
  record,
  subject: "repo",
  task,
  prompt: `Bug: ${task} is broken. Fix it, add a regression test.`,
  base: "abc",
  tokens: 1000,
  turns: 10,
  uses: [],
  snapshots: [],
  checks: [],
  detours: [],
  readFirst: [],
  values: [],
  calls: [],
  cwd: undefined,
  looking: null,
  reads: [],
  ...over
})

const evidence: Evidence = {
  places: [],
  readPlaces: [readPlace("p-keyboard", ["eraser", "save-as"], ["r1", "r3"]), readPlace("p-own", ["eraser"], ["r1", "r2"])],
  runs: [run("r1", "eraser"), run("r2", "eraser"), run("r3", "save-as")],
  skipped: [],
  families: new Map()
}

const step = (place: string | null) => ({ do: "Press keys with the Keyboard helper.", place, when: null })

const proposed = (id: string, fromRuns: ReadonlyArray<string>, place: string | null) => ({
  id,
  name: id,
  use_when: "a bug report that asks for a regression test",
  blanks: [{ name: "{test file}", meaning: "the test file that covers the fixed code" }],
  steps: [step(place)],
  checks: ["yarn vitest run {test file}", "git stash push {fixed files}; yarn vitest run {test file}; git stash pop"],
  pitfalls: [],
  from_runs: [...fromRuns],
  only_if_asked: false
})

const answer = (workflows: InductionAnswer["workflows"]): InductionAnswer => ({ workflows, edges: [], pitfalls: [], entries: [], rationale: "" })

const memoryWith = (workflows: ReadonlyArray<Workflow>, places: ReadonlyArray<Place> = []): WorkflowMemory => ({
  format: FORMAT,
  tenant: "local",
  places: [...places],
  workflows: [...workflows],
  edges: workflows.flatMap((w) => [
    { from: "start", to: w.id, relation: "LEADS_TO" as const, condition: null, guidance: null, pitfalls: null },
    { from: w.id, to: "end", relation: "LEADS_TO" as const, condition: null, guidance: null, pitfalls: null }
  ]),
  pitfalls: []
})

describe("learning what runs of different tasks did alike", () => {
  it("keeps a workflow runs of two tasks did, and names the kind", () => {
    const checked = checkCommon(answer([proposed("reproduce-bug-in-test", ["r1", "r3"], "p-keyboard")]), evidence, "local", "fixing a bug")
    assert.deepStrictEqual(checked.problems, [])
    const [w] = checked.memory.workflows
    assert.strictEqual(w.kind, "fixing a bug")
    assert.deepStrictEqual(w.tasks, ["eraser", "save-as"])
    assert.deepStrictEqual(checked.memory.places.map((p) => [p.id, p.show]), [["p-keyboard", "outline"]])
  })

  it("drops a workflow only one task's runs did, and a place only one task read", () => {
    const checked = checkCommon(
      answer([proposed("one-bug-only", ["r1", "r2"], null), proposed("reproduce", ["r1", "r3"], "p-own")]),
      evidence,
      "local",
      "fixing a bug"
    )
    assert.deepStrictEqual(checked.memory.workflows.map((w) => [w.id, w.steps[0].place]), [["reproduce", null]])
    assert.isTrue(checked.problems.some((p) => p.includes("one-bug-only") && p.includes("only eraser")))
    assert.isTrue(checked.problems.some((p) => p.includes("p-own") && p.includes("only 1 task")))
  })

  it("won't take the id of a workflow memory learned from single tasks", () => {
    const current = memoryWith([{ ...checkCommon(answer([proposed("update-test-snapshots", ["r1", "r3"], null)]), evidence, "local", "x").memory.workflows[0], kind: undefined } as Workflow])
    const checked = checkCommon(answer([proposed("update-test-snapshots", ["r1", "r3"], null)]), evidence, "local", "fixing a bug", current)
    assert.deepStrictEqual(checked.memory.workflows, [])
    assert.isTrue(checked.problems.some((p) => p.includes("has the id of one memory already has")))
  })

  it("lists only places runs of several tasks read, and what each run read of them", () => {
    const withRead: Evidence = { ...evidence, runs: [run("r1", "eraser", { reads: [{ place: "p-keyboard", file: "tests/helpers/ui.ts", turn: 7 }, { place: "p-own", file: "x.ts", turn: 2 }] })] }
    const text = commonPrompt(withRead, "fixing a bug", undefined)
    assert.include(text, "## The kind of task: fixing a bug")
    assert.include(text, "- p-keyboard `tests/helpers/ui.ts`")
    assert.include(text, "- turn 7: p-keyboard")
    assert.notInclude(text, "p-own")
  })

  it("puts a kind's workflows in place of the ones memory had for it, and keeps the rest", () => {
    const learned = (id: string) => checkCommon(answer([proposed(id, ["r1", "r3"], "p-keyboard")]), evidence, "local", "fixing a bug").memory
    const toggles = memoryWith([{ ...learned("x").workflows[0], id: "add-toggle", kind: undefined, steps: [step(null)] }])
    const first = withKind(toggles, learned("reproduce-v1"), "fixing a bug")
    const second = withKind(first, learned("reproduce-v2"), "fixing a bug")
    assert.deepStrictEqual(second.workflows.map((w) => w.id), ["add-toggle", "reproduce-v2"])
    assert.isFalse(second.edges.some((e) => e.from === "reproduce-v1" || e.to === "reproduce-v1"))
    assert.deepStrictEqual(second.places.map((p) => p.id), ["p-keyboard"])
  })
})

describe("places runs read, in the hand-over and in learning from results", () => {
  const m = checkCommon(answer([proposed("reproduce-bug-in-test", ["r1", "r3"], "p-keyboard")]), evidence, "local", "fixing a bug").memory
  const region = resolvePlace(HELPERS, m.places[0])!
  const located = new Map<string, Located>([["p-keyboard", { kind: "block", file: "tests/helpers/ui.ts", lines: HELPERS, region, moved: false }]])
  const chosen = [{ workflow: m.workflows[0], skip: [], why: "" }]

  it("shows one as an outline: its first line and its members' first lines", () => {
    const h = renderHandover(m, chosen, located)
    assert.include(h.text, "`tests/helpers/ui.ts:1-9`, its members:")
    assert.include(h.text, "    1| export class Keyboard {")
    assert.include(h.text, "    2|   static withModifierKeys")
    assert.include(h.text, "    6|   static keyPress")
    assert.notInclude(h.text, "cb();")
    assert.deepStrictEqual(h.shown[0].lines, [1, 2, 6, 9])
  })

  it("hands a kind's steps over and its checks in the one command", () => {
    const withFinish: WorkflowMemory = { ...m, workflows: m.workflows.map((w) => ({ ...w, snapshots: [] })) }
    const finish = finishOf(withFinish, withFinish.workflows)!
    assert.deepStrictEqual(finish.folded, [])
    assert.strictEqual(finish.command, "yarn vitest run {test file}; git stash push {fixed files}; yarn vitest run {test file}; git stash pop")
    const text = renderHandover(withFinish, [{ workflow: withFinish.workflows[0], skip: [], why: "" }], located).text
    assert.include(text, "1. Press keys with the Keyboard helper.")
    assert.include(text, "run once: `yarn vitest run {test file}; git stash push")
  })

  it("never counts one as shown and left alone", () => {
    const ran = run("r9", "dropdown", { uses: [{ place: "p-fix", kind: "change", file: "hook.ts", added: "", removed: "" }] })
    const f = fit(ran, { workflows: ["reproduce-bug-in-test"], places: ["p-keyboard"], handed: true }, new Set(["p-keyboard"]))
    assert.deepStrictEqual(f.unused, [])
    const fb = feedbackOf(
      { version: 1, workflows: [{ id: "reproduce-bug-in-test", places: ["p-keyboard"] }], shown: ["p-keyboard"], read: ["p-keyboard"], pitfalls: [], fired: [], triggers: [] },
      { edited: new Map([["p-fix", "hook.ts"]]), events: [] }
    )
    assert.deepStrictEqual(fb.items.map((i) => [i.id, i.kind, i.outcome]), [
      ["reproduce-bug-in-test", "workflow", "unknown"],
      ["p-keyboard", "read-place", "unknown"],
      ["p-fix", "place-not-shown", "unknown"]
    ])
  })

  it.effect("replays memory with one without counting it left alone", () =>
    Effect.gen(function*() {
      const cued: WorkflowMemory = { ...m, workflows: m.workflows.map((w) => ({ ...w, cues: { any: ["regression test"], none: [], steps: [], fills: [] } })) }
      const r = yield* replay(cued, [run("r9", "dropdown")], "cues")
      assert.deepStrictEqual([r.workflows, r.shown_unused], [1, 0])
    }).pipe(Effect.provide(NodeServices.layer)))
})
