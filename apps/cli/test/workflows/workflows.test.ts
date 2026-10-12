import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowRecord } from "../../src/records/Models.ts"
import type { Evidence, RunEvidence } from "../../src/workflows/Evidence.ts"
import { fit, passes, resultsText, shownInRecord, withNewPitfalls } from "../../src/workflows/Evolve.ts"
import { feedbackOf } from "../../src/workflows/Feedback.ts"
import { applyFix, applyRevision, checkAnswer, fixPrompt, type InductionAnswer, memoryText, namedValue, placeProblem } from "../../src/workflows/Induce.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { locatePlaces } from "../../src/workflows/Locate.ts"
import { emptyMemory, FORMAT, graphOrder, type Place, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { placeOfAddition } from "../../src/workflows/Places.ts"
import { excerpt, renderHandover } from "../../src/workflows/Render.ts"
import { chosenWorkflows, wordChoice } from "../../src/workflows/Select.ts"
import { WorkflowStore } from "../../src/workflows/WorkflowStore.ts"
import { git, run, tempDir } from "../eval/helpers.ts"

const TABLE = ["export const CODES = {", '  A: "KeyA",', '  B: "KeyB",', '  C: "KeyC",', "} as const;"]

const place = (id: string, over: Partial<Place> = {}): Place => ({
  id,
  subject: "repo",
  ...placeOfAddition("keys.ts", TABLE, 3, 2),
  new_file: null,
  evidence: ["r1", "r2"],
  tasks: ["t1", "t2"],
  edits: { add: 2, change: 0, create: 0 },
  ...over
})

const runEvidence = (record: string, over: Partial<RunEvidence> = {}): RunEvidence => ({
  record,
  subject: "repo",
  task: "t1",
  prompt: "Add a key",
  base: "abc",
  tokens: 1000,
  turns: 3,
  uses: [],
  snapshots: [],
  checks: [],
  detours: [],
  readFirst: [],
  values: ["Alt+M", "minimapEnabled"],
  calls: [],
  cwd: undefined,
  looking: null,
  reads: [],
  ...over
})

const answer = (over: Partial<InductionAnswer> = {}): InductionAnswer => ({
  workflows: [{
    id: "Add Key Code",
    name: "Add a key code",
    use_when: "a task needs a new key",
    blanks: [{ name: "{letter}", meaning: "the key's letter" }],
    steps: [{ do: "Add {letter} to the table.", place: "p-1", when: null }],
    checks: ["yarn test"],
    pitfalls: [],
    from_runs: ["r1"],
    only_if_asked: false
  }],
  edges: [],
  pitfalls: [],
  entries: [],
  rationale: "",
  ...over
})

describe("checking an induced answer", () => {
  const evidence: Evidence = {
    places: [place("p-1"), place("p-own", { file: "actions/actionToggleZen.tsx", tasks: ["t1"] }), place("p-thin", { evidence: ["r1"] })],
    runs: [runEvidence("r1"), runEvidence("r2", { task: "t2" })],
    readPlaces: [],
    skipped: [],
    families: new Map([["actions/actionToggleZen.tsx", "actionToggle"]])
  }

  it("keeps a sound workflow, with its evidence, and connects it from start to end", () => {
    const { memory, problems } = checkAnswer(answer(), evidence, "local")
    // Only that a place two tasks edited is in no workflow.
    assert.deepStrictEqual(problems.map((p) => p.includes("is in no workflow")), [true])
    const w = memory.workflows[0]
    assert.strictEqual(w.id, "add-key-code")
    assert.deepStrictEqual(w.blanks, [{ name: "letter", meaning: "the key's letter" }])
    assert.deepStrictEqual(w.evidence, ["r1", "r2"])
    assert.deepStrictEqual(memory.edges.map((e) => [e.from, e.to]), [["start", "add-key-code"], ["add-key-code", "end"]])
    assert.deepStrictEqual(memory.places.map((p) => p.id), ["p-1"])
  })

  it("drops what names a task's own values, and places that can't carry a step", () => {
    const a = answer({
      workflows: [
        { ...answer().workflows[0], id: "w1", steps: [{ do: "Add minimapEnabled.", place: "p-1", when: null }] },
        { ...answer().workflows[0], id: "w2", steps: [{ do: "Change the keyTest.", place: "p-own", when: null }, { do: "Edit it.", place: "p-thin", when: null }] },
        { ...answer().workflows[0], id: "w3", steps: [{ do: "Bind it.", place: "p-nowhere", when: null }] }
      ]
    })
    const { memory, problems } = checkAnswer(a, evidence, "local")
    assert.deepStrictEqual(memory.workflows.map((w) => w.id), ["w2", "w3"])
    assert.deepStrictEqual(memory.workflows.flatMap((w) => w.steps.map((s) => s.place)), [null, null, null])
    assert.isTrue(problems.some((p) => p.includes('"minimapEnabled"')))
    assert.isTrue(problems.some((p) => p.includes("that task's own file")))
    assert.isTrue(problems.some((p) => p.includes("only one run edited")))
    assert.isTrue(problems.some((p) => p.includes("isn't a listed place")))
  })

  it("drops a check that names a task's own value, and keeps its workflow", () => {
    const a = answer({ workflows: [{ ...answer().workflows[0], checks: ["yarn test", "yarn vitest run minimapEnabled.test.tsx"] }] })
    const { memory, problems } = checkAnswer(a, evidence, "local")
    assert.deepStrictEqual(memory.workflows.map((w) => [w.id, w.checks]), [["add-key-code", ["yarn test"]]])
    assert.isTrue(problems.some((p) => p.includes(`check "yarn vitest run minimapEnabled.test.tsx" of add-key-code names a task's own value "minimapEnabled"`)))
  })

  it("keeps pitfalls only from real detours", () => {
    const a = answer({ pitfalls: [{ id: "flag", text: "Don't double the flag.", detours: ["r1#0"], trigger: null }] })
    const { memory, problems } = checkAnswer(a, evidence, "local")
    assert.deepStrictEqual(memory.pitfalls, [])
    assert.isTrue(problems.some((p) => p.includes("no detour")))
  })

  it("tells task values by whole words, and key combinations exactly", () => {
    assert.strictEqual(namedValue("add the MinimapEnabled flag", ["minimapEnabled"]), "minimapEnabled")
    assert.isUndefined(namedValue("add the minimapEnabledX flag", ["minimapEnabled"]))
    assert.strictEqual(namedValue("press Alt+M to toggle", ["Alt+M"]), "Alt+M")
    assert.isUndefined(namedValue("see packages/x/y.ts", ["packages/x/y.ts"]))
    assert.isUndefined(placeProblem(place("p"), new Map()))
  })
})

describe("learning for less", () => {
  const detour = {
    kind: "command_error" as const,
    failed: { call: 0, turn: 0, tool: "Bash", command: "yarn test:update --watch", file: null },
    symptom: "unknown option --watch",
    keys: ["yarn test:update"],
    fixed: { call: 1, turn: 1, tool: "Bash", command: "yarn test:update", file: null },
    removed: ["--watch"],
    added: [],
    files_edited: [],
    failures: 1,
    cost: { tokens: 4000, calls: 1, turns: 1 }
  }
  const evidence: Evidence = {
    places: [place("p-1"), place("p-thin", { evidence: ["r1"] })],
    runs: [runEvidence("r1", { detours: [detour] }), runEvidence("r2", { task: "t2" })],
    readPlaces: [],
    skipped: [],
    families: new Map()
  }
  const workflow = answer().workflows[0]
  const leaky = answer({
    workflows: [
      { ...workflow, id: "w1", steps: [{ do: "Add minimapEnabled to the table.", place: "p-1", when: null }] },
      { ...workflow, id: "w2", steps: [{ do: "Add {letter} to the table.", place: "p-thin", when: null }] }
    ],
    edges: [{ from: "w2", to: "end", relation: "LEADS_TO", condition: "when Alt+M is free", guidance: null, pitfalls: null }],
    pitfalls: [
      { id: "Watch Flag", text: "`yarn test:update` already watches.", detours: ["r9#0"], trigger: null },
      { id: "minimap", text: "Toggling minimapEnabled twice undoes it.", detours: ["r1#0"], trigger: null }
    ]
  })

  it("flags what only the model can fix, and fixes the rest itself", () => {
    const { memory, flagged } = checkAnswer(leaky, evidence, "local")
    // A task's own value in a step, an edge's condition and a pitfall; a pitfall from no detour of these runs.
    assert.deepStrictEqual(flagged, { workflows: ["w1"], pitfalls: ["watch-flag", "minimap"], edges: [["w2", "end"]] })
    // A place one run edited goes from its step without a call.
    assert.deepStrictEqual(memory.workflows.map((w) => [w.id, w.steps.map((s) => s.place)]), [["w2", [null]]])
  })

  it("sends back only the flagged parts, and takes only those from the answer", () => {
    const checked = checkAnswer(leaky, evidence, "local")
    const prompt = fixPrompt(leaky, checked, evidence)
    assert.include(prompt, "Add minimapEnabled to the table.")
    assert.notInclude(prompt, "Add {letter} to the table.")
    assert.include(prompt, "`Alt+M`, `minimapEnabled`")
    assert.include(prompt, "pitfall watch-flag comes from no detour of these runs")
    // The detours, for the pitfall that named none of them.
    assert.include(prompt, "### Run r1")
    const fixed = applyFix(leaky, {
      workflows: [
        { ...workflow, id: "w1", steps: [{ do: "Add {flag} to the table.", place: "p-1", when: null }] },
        { ...workflow, id: "w2", name: "Not flagged, not taken" }
      ],
      pitfalls: [{ id: "watch-flag", text: "`yarn test:update` already watches.", detours: ["r1#0"], trigger: null }],
      edges: [{ from: "w2", to: "end", relation: "LEADS_TO", condition: "when the key is free", guidance: null, pitfalls: null }]
    }, checked.flagged)
    const again = checkAnswer(fixed, evidence, "local")
    assert.deepStrictEqual(again.memory.workflows.map((w) => [w.id, w.name]), [["w1", "Add a key code"], ["w2", "Add a key code"]])
    assert.deepStrictEqual(again.memory.pitfalls.map((p) => p.id), ["watch-flag"])
    assert.deepStrictEqual(again.flagged, { workflows: [], pitfalls: ["minimap"], edges: [] })
  })

  it("reads memory compactly, and applies a revision that holds only what changes", () => {
    const wf = (id: string) => ({
      id,
      subject: "repo",
      name: `Do ${id}`,
      use_when: `a task needs ${id}`,
      only_if_asked: false,
      blanks: [],
      steps: [{ do: `Edit for ${id}.`, place: "p-1", when: null }],
      checks: ["yarn test"],
      pitfalls: id === "a" ? ["p1"] : [],
      evidence: ["r1", "r2"],
      tasks: ["t1"],
      cues: { any: [`${id} phrase`], none: [], steps: [], fills: [] }
    })
    const edge = (from: string, to: string) => ({ from, to, relation: "LEADS_TO" as const, condition: null, guidance: null, pitfalls: null })
    const current: WorkflowMemory = {
      ...emptyMemory("local"),
      places: [place("p-1")],
      workflows: [wf("a"), wf("b"), wf("c")],
      edges: [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end")],
      pitfalls: [
        { id: "p1", subject: "repo", text: "Mind the flag.", trigger: { on: "command", all: ["--watch"], none: [], file: null }, evidence: ["r1"], cost_tokens: 1 },
        { id: "p2", subject: "repo", text: "Mind the order.", trigger: null, evidence: ["r1"], cost_tokens: 1 }
      ]
    }
    const text = memoryText(current)
    assert.include(text, "### b\nName: Do b\nUse when: a task needs b\n1. Edit for b. [place: p-1]\nChecks: `yarn test`")
    assert.include(text, "- p1: Mind the flag. Trigger: {\"on\":\"command\",\"all\":[\"--watch\"],\"none\":[],\"file\":null}")
    assert.notInclude(text, "a phrase")
    assert.isBelow(text.length, JSON.stringify({ workflows: current.workflows, edges: current.edges, pitfalls: current.pitfalls }, null, 1).length / 2)

    const merged = applyRevision(current, {
      workflows: [{ ...answer().workflows[0], id: "b", name: "Do b better" }, { ...answer().workflows[0], id: "d", name: "Do d" }],
      removed_workflows: ["c"],
      edges: [edge("a", "b"), edge("b", "d"), edge("d", "end")],
      pitfalls: [{ id: "p2", text: "Mind the build order.", detours: [], trigger: null }],
      removed_pitfalls: ["p1"],
      entries: [],
      rationale: "b does more; c went"
    })
    assert.deepStrictEqual(merged.workflows.map((w) => [w.id, w.name]), [["a", "Do a"], ["b", "Do b better"], ["d", "Do d"]])
    assert.deepStrictEqual(merged.edges.map((e) => `${e.from}>${e.to}`), ["start>a", "a>b", "b>d", "d>end"])
    assert.deepStrictEqual(merged.pitfalls.map((p) => [p.id, p.text]), [["p2", "Mind the build order."]])
    // What it keeps of memory reads as memory's own: no runs, its own trigger.
    const checked = checkAnswer(merged, evidence, "local", current)
    assert.deepStrictEqual(checked.memory.pitfalls.map((p) => p.id), ["p2"])
    assert.deepStrictEqual(checked.memory.workflows.find((w) => w.id === "a")?.pitfalls, [])
  })
})

const memoryWith = (over: Partial<WorkflowMemory> = {}): WorkflowMemory => ({
  ...emptyMemory("local"),
  places: [place("p-1")],
  workflows: [
    {
      id: "a",
      subject: "repo",
      name: "Add a key code",
      use_when: "a task adds a keyboard key",
      only_if_asked: false,
      blanks: [],
      steps: [{ do: "Add the key.", place: "p-1", when: null }, { do: "Add a test.", place: null, when: "only if asked" }],
      checks: ["yarn test"],
      pitfalls: ["flag"],
      evidence: [],
      tasks: []
    },
    {
      id: "b",
      subject: "repo",
      name: "Write a keyboard test",
      use_when: "a task adds a keyboard key test",
      only_if_asked: true,
      blanks: [],
      steps: [{ do: "Write it.", place: null, when: null }],
      checks: [],
      pitfalls: ["flag"],
      evidence: [],
      tasks: []
    }
  ],
  edges: [
    { from: "start", to: "b", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null },
    { from: "b", to: "a", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null }
  ],
  pitfalls: [{ id: "flag", subject: "repo", text: "Don't double the flag.", trigger: null, evidence: [], cost_tokens: 0 }],
  ...over
})

describe("picking and handing over", () => {
  it("orders workflows along the graph's edges", () => {
    assert.deepStrictEqual(graphOrder(memoryWith()).map((w) => w.id), ["b", "a"])
  })

  it("takes the model's choice and its skipped steps; words alone never take what waits to be asked for", () => {
    const m = memoryWith()
    const chosen = chosenWorkflows(m, {
      workflows: [{ id: "a", applies: true, why: "", skip_steps: [2, 9] }, { id: "b", applies: false, why: "", skip_steps: [] }]
    })
    assert.deepStrictEqual(chosen.map((c) => [c.workflow.id, c.skip]), [["a", [2]]])
    assert.deepStrictEqual(wordChoice(m, "add a keyboard key test for the toolbar", 2).map((c) => c.workflow.id), ["a"])
  })

  it("shows each place as it is now, with each pitfall once, and fits the budget", () => {
    const m = memoryWith()
    const located = new Map([["p-1", { kind: "block" as const, file: "keys.ts", lines: TABLE, region: { from: 0, to: 4, openLine: 0, closeLine: 4, members: [] }, moved: false }]])
    const chosen = chosenWorkflows(m, { workflows: [{ id: "a", applies: true, why: "", skip_steps: [2] }, { id: "b", applies: true, why: "", skip_steps: [] }] })
    const h = renderHandover(m, chosen, located)
    assert.include(h.text, "## 1. Write a keyboard test")
    assert.include(h.text, "## 2. Add a key code")
    assert.include(h.text, "`keys.ts:1-5` in export const CODES = {")
    assert.notInclude(h.text, "Add a test.")
    assert.strictEqual(h.text.split("Watch out:").length - 1, 1)
    assert.deepStrictEqual(h.shown, [{ place: "p-1", file: "keys.ts", from: 1, to: 5, lines: [1, 2, 3, 4, 5] }])
    // A place the code no longer has is left out quietly, and its step stays.
    const gone = renderHandover(m, chosen, new Map())
    assert.include(gone.text, "Add the key.")
    assert.deepStrictEqual(gone.missing, ["p-1"])
    assert.isAtMost(renderHandover(m, chosen, located, 600).text.length, 600)
  })

  it("cuts a long block to its first line, its last entries and its closing line", () => {
    const lines = ["const T = {", ...Array.from({ length: 20 }, (_, i) => `  k${i}: ${i},`), "};"]
    const out = excerpt(lines, { from: 0, to: 21, openLine: 0, closeLine: 21, members: [] }, 5)
    assert.deepStrictEqual(out.map((l) => l.trim()), ["1| const T = {", "⋮", "19|   k17: 17,", "20|   k18: 18,", "21|   k19: 19,", "22| };"])
  })
})

describe("feedback", () => {
  it("says which places and workflows a run used, which it didn't, and where it went instead", () => {
    const f = feedbackOf(
      {
        version: 3,
        workflows: [{ id: "a", places: ["p-1", "p-2"] }, { id: "b", places: ["p-3"] }],
        shown: ["p-1", "p-3"],
        pitfalls: ["flag"],
        fired: [],
        triggers: [{ id: "flag", subject: "repo", text: "", trigger: { on: "command", all: ["test:update", "--watch=false"], none: [], file: null }, evidence: [], cost_tokens: 0 }]
      },
      {
        edited: new Map([["p-1", "keys.ts"], ["p-9", "other.ts"]]),
        events: [{ event: { tool: "Bash", command: "yarn test:update", file: undefined, text: undefined, output: "", failed: false }, at: 1 }]
      }
    )
    const by = (kind: string) => f.items.filter((i) => i.kind === kind).map((i) => [i.id, i.outcome])
    assert.deepStrictEqual(by("workflow"), [["a", "followed"], ["b", "ignored"]])
    assert.deepStrictEqual(by("place"), [["p-1", "followed"], ["p-3", "ignored"]])
    assert.deepStrictEqual(by("place-not-shown"), [["p-9", "unknown"]])
    assert.deepStrictEqual(by("pitfall"), [["flag", "followed"]])
    assert.strictEqual(f.version, 3)
  })
})

describe("learning from results", () => {
  const ran = runEvidence("r9", {
    uses: [
      { place: "p-1", kind: "add", file: "keys.ts", added: "", removed: "" },
      { place: "p-5", kind: "add", file: "menu.ts", added: "", removed: "" }
    ]
  })

  it("tells what a run did with what it was shown", () => {
    const f = fit(ran, { workflows: ["a"], places: ["p-1", "p-2"], handed: false })
    assert.deepStrictEqual([f.edited, f.hit, f.missed, f.unused], [2, ["p-1"], ["p-5"], ["p-2"]])
    const text = resultsText([{ run: ran, shown: { workflows: ["a"], places: ["p-1", "p-2"], handed: false } }], new Map([["p-1", place("p-1")]]), memoryWith())
    assert.include(text, "would have been handed: a")
    assert.include(text, "Shown, left alone: p-2")
    assert.include(text, "p-5, which memory lacks")
  })

  it("keeps a revision only if it fits the runs at least as well", () => {
    const r = (hit: number, unused: number) => ({ runs: 4, edited: 20, shown_and_edited: hit, shown_unused: unused, workflows: 8 })
    assert.isTrue(passes(r(15, 2), r(15, 4)).commit)
    assert.isTrue(passes(r(16, 4), r(15, 4)).commit)
    assert.isFalse(passes(r(14, 4), r(15, 4)).commit)
    assert.include(passes(r(14, 4), r(15, 4)).reason, "fits the runs worse")
    // A place it misses counts twice one it shows for nothing: 3 more edited places shown outweigh 5 more left alone, not 7.
    assert.isTrue(passes(r(18, 9), r(15, 4)).commit)
    assert.isFalse(passes(r(18, 11), r(15, 4)).commit)
    assert.isFalse(passes(r(15, 7), r(15, 4)).commit)
  })

  it("keeps a rejected revision's new pitfalls, in the workflows that do what its own did", () => {
    const current = memoryWith()
    const pitfall = (id: string) => ({ id, subject: "repo", text: `Don't ${id}.`, trigger: null, evidence: ["r3"], cost_tokens: 1000 })
    const revision = memoryWith({
      workflows: [
        // Renamed, at the same place as current's "a"; and a workflow current memory doesn't have.
        { ...current.workflows[0], id: "a-renamed", pitfalls: ["flag", "stale-count"] },
        { ...current.workflows[1], id: "c", steps: [{ do: "Elsewhere.", place: "p-9", when: null }], pitfalls: ["lint-style"] }
      ],
      pitfalls: [...current.pitfalls, pitfall("stale-count"), pitfall("lint-style")]
    })
    const kept = withNewPitfalls(current, revision)!
    assert.deepStrictEqual(kept.pitfalls.map((p) => p.id), ["flag", "stale-count", "lint-style"])
    assert.deepStrictEqual(kept.workflows.map((w) => [w.id, w.pitfalls]), [["a", ["flag", "stale-count"]], ["b", ["flag"]]])
    // Its workflows, places and graph are the current memory's.
    assert.deepStrictEqual([kept.places, kept.edges], [current.places, current.edges])
    assert.isUndefined(withNewPitfalls(current, memoryWith({ workflows: [] })))
  })

  it("reads what v1 showed a run from its record", () => {
    const record = {
      memory: {
        setup: "workflows",
        version: 2,
        items: [
          { id: "a", kind: "workflow", moment: "start" as const, outcome: "followed" as const, note: null },
          { id: "p-1", kind: "place", moment: "start" as const, outcome: "followed" as const, note: null },
          { id: "p-9", kind: "place-not-shown", moment: "start" as const, outcome: "unknown" as const, note: null }
        ]
      }
    } as unknown as WorkflowRecord
    assert.deepStrictEqual(shownInRecord(record), { workflows: ["a"], places: ["p-1"], handed: true })
    assert.isUndefined(shownInRecord({ memory: null } as unknown as WorkflowRecord))
  })
})

describe("the workflow store", () => {
  it.effect("proposes, commits and rejects whole memories, and keeps what was rejected", () =>
    Effect.gen(function*() {
      const store = yield* WorkflowStore
      assert.strictEqual(yield* store.head(), 0)
      const a = yield* store.propose(memoryWith(), { rationale: "first", records: ["r1"], report: { problems: [], replay: null } })
      assert.strictEqual(yield* store.commit(a.id), 1)
      assert.deepStrictEqual((yield* store.memory()).workflows.map((w) => w.id), ["a", "b"])
      const b = yield* store.propose(emptyMemory("local"), { rationale: "worse", records: [] })
      yield* store.reject(b.id, "fewer places shown")
      assert.strictEqual(yield* store.head(), 1)
      assert.deepStrictEqual((yield* store.candidates("rejected")).map((c) => c.reason), ["fewer places shown"])
      assert.strictEqual((yield* store.memory(b.id)).workflows.length, 0)
      assert.strictEqual((yield* store.memory(0)).format, FORMAT)
    }).pipe(Effect.provide(JsonWorkflowStore.layer(join(tempDir(), "workflows"), "local")), Effect.provide(NodeServices.layer))
  )
})

describe("finding places in code that has moved", () => {
  it("looks in the file a block moved to, by its first line", async () => {
    const repo = join(tempDir(), "repo")
    mkdirSync(join(repo, "src"), { recursive: true })
    git(repo, "init", "-q")
    writeFileSync(join(repo, "src", "keys.ts"), TABLE.join("\n") + "\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "one")
    git(repo, "mv", "src/keys.ts", "src/codes.ts")
    git(repo, "commit", "-qm", "moved")
    const p = place("p-1", { file: "src/keys.ts" })
    const before = await run(locatePlaces({ kind: "commit", repo, commit: "HEAD~1" }, [p]))
    const after = await run(locatePlaces({ kind: "commit", repo, commit: "HEAD" }, [p]))
    const tree = await run(locatePlaces({ kind: "tree", root: repo }, [p]))
    const b = before.get("p-1")
    assert.deepStrictEqual([b?.kind, b?.kind === "block" ? b.moved : undefined], ["block", false])
    for (const found of [after.get("p-1"), tree.get("p-1")]) {
      assert.strictEqual(found?.kind, "block")
      if (found?.kind === "block") assert.deepStrictEqual([found.file, found.moved, found.region.from, found.region.to], ["src/codes.ts", true, 0, 4])
    }
  })
})
