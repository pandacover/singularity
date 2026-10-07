import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Response, ToolCall, Trace } from "../../src/traces/index.ts"
import { replay, shownInText, withShow } from "../../src/workflows/Evolve.ts"
import type { RunEvidence } from "../../src/workflows/Evidence.ts"
import { checkAnswer, type InductionAnswer } from "../../src/workflows/Induce.ts"
import type { Located } from "../../src/workflows/Locate.ts"
import { describeLookup, lookingOf } from "../../src/workflows/Lookups.ts"
import { FORMAT, type Place, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { placeOfAddition, resolvePlace } from "../../src/workflows/Places.ts"
import { renderHandover } from "../../src/workflows/Render.ts"

const usage = (n: number) => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: n })

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({
  id,
  name,
  input,
  agentId: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  result: "",
  isError: false
})

const response = (id: string, tokens: number, calls: ReadonlyArray<string>): Response => ({
  id,
  model: "claude-sonnet-5-5",
  agentId: undefined,
  timestamp: undefined,
  usage: usage(tokens),
  text: "",
  toolCallIds: [...calls],
  stopReason: undefined
})

const trace = (responses: ReadonlyArray<Response>, toolCalls: ReadonlyArray<ToolCall>): Trace => ({
  sessionId: "s",
  path: "s.jsonl",
  cwd: "/repo",
  gitBranch: undefined,
  version: undefined,
  prompts: [],
  responses,
  toolCalls,
  apiErrors: 0,
  costState: undefined,
  startedAt: undefined,
  endedAt: undefined,
  skippedLines: 0
})

const relative = (p: string) => p.replace(/^\/repo\//, "")

const ISLAND = [
  "const Help = () => (",
  "  <Island>",
  "    <Shortcut",
  '      label="one"',
  "    />",
  "    <Shortcut",
  '      label="two"',
  '      keys={["A"]}',
  "    />",
  "  </Island>",
  ");"
]

const islandPlace = (over: Partial<Place> = {}): Place => ({
  id: "p-island",
  subject: "repo",
  ...placeOfAddition("help.tsx", ISLAND, 9, 4),
  new_file: null,
  evidence: ["r1", "r2"],
  tasks: ["t1", "t2"],
  edits: { add: 2, change: 0, create: 0 },
  ...over
})

const memoryWith = (places: ReadonlyArray<Place>): WorkflowMemory => ({
  format: FORMAT,
  tenant: "local",
  places,
  workflows: [{
    id: "list-shortcut",
    subject: "repo",
    name: "List the shortcut",
    use_when: "a task adds a shortcut",
    only_if_asked: false,
    blanks: [],
    steps: [{ do: "Add a Shortcut row.", place: "p-island", when: null }],
    checks: [],
    pitfalls: [],
    evidence: ["r1", "r2"],
    tasks: ["t1"],
    cues: { any: ["shortcut"], none: [], steps: [], fills: [] }
  }],
  edges: [],
  pitfalls: []
})

describe("what runs looked up before their first edit", () => {
  it("takes the reads and searches of the turns before the first edit, with their tokens", () => {
    const t = trace(
      [response("a", 100, ["1", "2"]), response("b", 200, ["3", "4"]), response("c", 300, ["5"]), response("d", 400, ["6"])],
      [
        call("1", "Read", { file_path: "/repo/src/help.tsx", offset: 10, limit: 5 }),
        call("2", "Grep", { pattern: "Shortcut", path: "/repo/src" }),
        call("3", "Bash", { command: "grep -rn keyTest src | head" }),
        call("4", "Bash", { command: "yarn install" }),
        call("5", "Edit", { file_path: "/repo/src/help.tsx", old_string: "a", new_string: "b" }),
        call("6", "Read", { file_path: "/repo/src/other.ts" })
      ]
    )
    const l = lookingOf(t, relative)
    assert.strictEqual(l.turns, 2)
    assert.strictEqual(l.tokens, 300)
    assert.deepStrictEqual(l.lookups.map((x) => [x.turn, x.tool, x.file, x.from, x.to, x.pattern, x.within]), [
      [0, "Read", "src/help.tsx", 10, 14, null, null],
      [0, "Grep", null, null, null, "Shortcut", "src"],
      [1, "Bash", null, null, null, "grep -rn keyTest src | head", null]
    ])
  })

  it("tells a lookup against memory's places: around which place, and how much of it the hand-over showed", () => {
    const p = islandPlace()
    const region = resolvePlace(ISLAND, p)!
    const located = new Map<string, Located>([
      ["p-island", { kind: "block", file: "help.tsx", lines: ISLAND, region, moved: false }],
      ["p-new", { kind: "new-file", dir: "actions", prefix: "actionToggle", siblings: [{ name: "actionToggleA.tsx", lines: ["x"] }] }]
    ])
    const fresh: Place = { ...islandPlace({ id: "p-new" }), file: "actions", chain: [], group: null, new_file: { dir: "actions", prefix: "actionToggle", ext: ".tsx" } }
    const read = { turn: 0, tool: "Read", file: "help.tsx", from: 1, to: null, pattern: null, within: null }
    assert.strictEqual(
      describeLookup(read, [p, fresh], located, new Map([["p-island", [2, 9, 10]]])),
      "read `help.tsx`, the whole file, around place p-island (lines 2-10): the hand-over showed 3 of its 9 lines"
    )
    assert.include(describeLookup({ ...read, file: "actions/actionToggleZen.tsx" }, [p, fresh], located, new Map()), "an existing file of the kind place p-new creates")
    assert.strictEqual(describeLookup({ ...read, file: "other.ts" }, [p, fresh], located, new Map()), "read `other.ts`, the whole file: no place memory has")
    assert.strictEqual(
      describeLookup({ ...read, file: null, tool: "Grep", pattern: "keyTest", within: "src" }, [p], located, new Map()),
      "searched for `keyTest` in `src`"
    )
  })

  it("shows a place as its last whole entry when memory says so, and reads back what a hand-over showed", () => {
    const region = resolvePlace(ISLAND, islandPlace())!
    const located = new Map<string, Located>([["p-island", { kind: "block", file: "help.tsx", lines: ISLAND, region, moved: false }]])
    const chosen = (m: WorkflowMemory) => [{ workflow: m.workflows[0], skip: [], why: "" }]
    const plain = memoryWith([islandPlace()])
    const end = renderHandover(plain, chosen(plain), located, 9800).text
    const whole = memoryWith([islandPlace({ show: "entry" })])
    const entry = renderHandover(whole, chosen(whole), located, 9800)
    // The end of the block cuts the last row's attributes; the entry shows the whole row.
    assert.include(entry.text, '7|       label="two"')
    assert.include(entry.text, '8|       keys={["A"]}')
    assert.notInclude(entry.text, 'label="one"')
    assert.deepStrictEqual(entry.shown[0].lines, [2, 6, 7, 8, 9, 10])
    assert.deepStrictEqual([...shownInText(entry.text).get("help.tsx")!], [2, 6, 7, 8, 9, 10])
    assert.notStrictEqual(end, entry.text)
  })

  it("keeps the entries an answer names for places its steps use, and drops the rest", () => {
    const p = islandPlace()
    const evidence = { places: [p], readPlaces: [], runs: [], skipped: [], families: new Map<string, string>() }
    const answer: InductionAnswer = {
      workflows: [{
        id: "list-shortcut",
        name: "List the shortcut",
        use_when: "a task adds a shortcut",
        blanks: [],
        steps: [{ do: "Add a Shortcut row.", place: "p-island", when: null }],
        checks: [],
        pitfalls: [],
        from_runs: [],
        only_if_asked: false
      }],
      edges: [],
      pitfalls: [],
      entries: ["p-island", "p-nowhere"],
      rationale: ""
    }
    const checked = checkAnswer(answer, evidence, "local")
    assert.deepStrictEqual(checked.entries, ["p-island"])
    assert.strictEqual(checked.memory.places[0].show, "entry")
    assert.isTrue(checked.problems.some((x) => x.includes("p-nowhere")))
    assert.isUndefined(withShow(checked.memory.places[0], false).show)
  })

  it("keeps a pitfall memory has when a revision names it without new detours", () => {
    const watch = { id: "watch-flag", subject: "repo", text: "Don't pass --watch twice.", trigger: { on: "command" as const, all: ["test:update", "--watch=false"], none: [], file: null }, evidence: ["old-run"], cost_tokens: 900 }
    const current: WorkflowMemory = { ...memoryWith([islandPlace()]), pitfalls: [watch] }
    const evidence = { places: [islandPlace()], readPlaces: [], runs: [], skipped: [], families: new Map<string, string>() }
    const answer: InductionAnswer = {
      workflows: [],
      edges: [],
      pitfalls: [
        { id: "watch-flag", text: "The script already passes --watch.", detours: [], trigger: null },
        { id: "made-up", text: "Something nobody hit.", detours: ["nowhere#0"], trigger: null }
      ],
      entries: [],
      rationale: ""
    }
    const checked = checkAnswer(answer, evidence, "local", current)
    assert.deepStrictEqual(checked.memory.pitfalls, [{ ...watch, text: "The script already passes --watch." }])
    assert.deepStrictEqual(checkAnswer(answer, evidence, "local").memory.pitfalls, [])
  })

  it.effect("replays memory picked by cues without a model call", () =>
    Effect.gen(function*() {
      const m = memoryWith([islandPlace()])
      const run = (prompt: string): RunEvidence => ({
        record: prompt,
        subject: "repo",
        task: prompt,
        prompt,
        base: "abc",
        tokens: 1,
        turns: 1,
        uses: [{ place: "p-island", kind: "add", file: "help.tsx", added: "", removed: "" }],
        snapshots: [],
        checks: [],
        detours: [],
        readFirst: [],
        values: [],
        calls: [],
        cwd: undefined,
        looking: null,
        reads: []
      })
      const r = yield* replay(m, [run("Add a keyboard shortcut"), run("Rename a file")], "cues")
      assert.deepStrictEqual([r.edited, r.shown_and_edited, r.shown_unused, r.workflows, r.costUsd], [2, 1, 0, 1, 0])
    }).pipe(Effect.provide(NodeServices.layer)))
})
