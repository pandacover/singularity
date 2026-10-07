import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { checkCues, type CuesAnswer } from "../../src/workflows/CueWriter.ts"
import {
  applyFills,
  choiceByCues,
  cueChoice,
  fillsFor,
  fillValue,
  hasCues,
  partsChoice,
  positiveText,
  statedValues,
  taskParts
} from "../../src/workflows/Cues.ts"
import type { RunEvidence } from "../../src/workflows/Evidence.ts"
import { pickMode } from "../../src/workflows/HookStart.ts"
import { FORMAT, type Workflow, WorkflowMemory } from "../../src/workflows/Models.ts"
import { renderHandover } from "../../src/workflows/Render.ts"

const workflow = (id: string, over: Partial<Workflow> = {}): Workflow => ({
  id,
  subject: "repo",
  name: id,
  use_when: `a task needs ${id}`,
  only_if_asked: false,
  blanks: [],
  steps: [{ do: `Do ${id}.`, place: null, when: null }],
  checks: [],
  pitfalls: [],
  evidence: ["r1", "r2"],
  tasks: ["t1"],
  ...over
})

const field = workflow("add-field", {
  blanks: [{ name: "field", meaning: "the new field" }, { name: "default", meaning: "its default" }],
  steps: [
    { do: "Add `{field}: {type};` to the state type.", place: null, when: null },
    { do: "Add `{field}: {default},` to the defaults.", place: null, when: null }
  ],
  cues: { any: ["new appState field"], none: [], steps: [], fills: [
    { placeholder: "{field}", from: "code", n: 1, phrase: null },
    { placeholder: "{default}", from: "after", n: 1, phrase: "default" }
  ] }
})

const shortcut = workflow("add-shortcut", {
  blanks: [{ name: "shortcut", meaning: "the shortcut" }, { name: "code", meaning: "its key" }],
  steps: [
    { do: "Add `{code}` to the key table.", place: null, when: null },
    { do: "List {shortcut} in the help dialog.", place: null, when: null },
    { do: "Add it to the view-mode menu.", place: null, when: "only if the task wants it in view mode too" }
  ],
  cues: { any: ["toggle it with Alt+", "keyboard shortcut for"], none: ["from Alt+"], steps: [{ step: 3, any: ["view mode"], none: [] }], fills: [
    { placeholder: "{shortcut}", from: "key", n: 1, phrase: null },
    { placeholder: "{code}", from: "key-letter", n: 1, phrase: null }
  ] }
})

const test = workflow("keyboard-test", { only_if_asked: true, cues: { any: ["add a test"], none: [], steps: [], fills: [] } })
const noCues = workflow("no-cues")

const memory: WorkflowMemory = {
  format: FORMAT,
  tenant: "local",
  places: [],
  workflows: [field, shortcut, test, noCues],
  edges: [],
  pitfalls: []
}

const ids = (task: string) => cueChoice(memory, task).map((c) => c.workflow.id)

describe("cues", () => {
  it("takes negated clauses out of a task before matching", () => {
    const text = positiveText("Toggle it from Preferences. Don't add a keyboard shortcut or a right-click menu entry for it. Make sure the tests pass.")
    assert.isFalse(text.includes("keyboard shortcut"))
    assert.isFalse(text.includes("right-click"))
    assert.isTrue(text.includes("Preferences"))
    assert.isTrue(text.includes("tests pass"))
    const presenter = positiveText("from the canvas right-click menu (but not in view mode, where it shouldn't be offered), and from Preferences")
    assert.isFalse(presenter.includes("view mode"))
    assert.isTrue(presenter.includes("right-click menu"))
    assert.isTrue(presenter.includes("Preferences"))
    // "Nothing" isn't "not".
    assert.isTrue(positiveText("Nothing draws it yet.").includes("Nothing draws it yet"))
  })

  it("picks workflows by their phrases, in any case, and leaves out conditional steps the task doesn't ask for", () => {
    assert.deepStrictEqual(ids("Store it in a new appState field `rulersEnabled`. Toggle it with Alt+U, from the menu (also in view mode)."), ["add-field", "add-shortcut"])
    const chosen = cueChoice(memory, "Store it in a NEW APPSTATE FIELD `x`. Toggle it with Alt+U, from the menu.")
    assert.deepStrictEqual(chosen.find((c) => c.workflow.id === "add-shortcut")?.skip, [3])
    assert.deepStrictEqual(cueChoice(memory, "toggle it with Alt+U, not in view mode").find((c) => c.workflow.id === "add-shortcut")?.skip, [3])
  })

  it("matches a phrase where the task's text breaks a line in it", () => {
    assert.deepStrictEqual(ids("Please add a\nnew   appState field and add a\ntest"), ["add-field", "keyboard-test"])
  })

  it("doesn't pick a workflow for what a task rules out, for its `none` phrases, or without cues", () => {
    assert.deepStrictEqual(ids("Add a new appState field `x`. Don't add a keyboard shortcut for it."), ["add-field"])
    assert.deepStrictEqual(ids("Change the keyboard shortcut for stats from Alt+/ to Alt+K."), [])
    assert.deepStrictEqual(ids("Change the shortcut from Alt+/ to Alt+K, and add a test that checks it."), ["keyboard-test"])
    assert.isFalse(ids("Do no-cues and add-field.").includes("no-cues"))
    assert.isTrue(hasCues(memory))
    assert.isFalse(hasCues({ ...memory, workflows: [noCues] }))
  })

  it("finds what a task states: names in backticks, quoted names, keys in order, the word after a phrase", () => {
    const task = 'Change the "snap to objects" shortcut from Alt+S to Alt+U, in a new field `snapEnabled` (default\nfalse). Alt+U again.'
    assert.deepStrictEqual(statedValues(task), { code: ["snapEnabled"], quoted: ["snap to objects"], key: ["Alt+S", "Alt+U"] })
    assert.strictEqual(fillValue(task, { placeholder: "{old}", from: "key", n: 1, phrase: null }), "Alt+S")
    assert.strictEqual(fillValue(task, { placeholder: "{new}", from: "key", n: 2, phrase: null }), "Alt+U")
    assert.strictEqual(fillValue(task, { placeholder: "{code}", from: "key-letter", n: 2, phrase: null }), "U")
    assert.strictEqual(fillValue(task, { placeholder: "{default}", from: "after", n: 1, phrase: "default" }), "false")
    assert.strictEqual(fillValue("Its default is 0.5. Store it, default false.", { placeholder: "{d}", from: "after", n: 1, phrase: "default is" }), "0.5")
    assert.strictEqual(fillValue("Store it, default false.", { placeholder: "{d}", from: "after", n: 1, phrase: "default" }), "false")
    assert.strictEqual(fillValue(task, { placeholder: "{label}", from: "quoted", n: 1, phrase: null }), "snap to objects")
    assert.strictEqual(fillValue(task, { placeholder: "{x}", from: "key", n: 3, phrase: null }), undefined)
    // A key that isn't a letter or digit has no letter to fill.
    assert.strictEqual(fillValue("from Alt+/ to Alt+K", { placeholder: "{code}", from: "key-letter", n: 1, phrase: null }), undefined)
  })

  it("fills a workflow's blanks the task states and leaves the rest", () => {
    const values = fillsFor("A new appState field `rulersEnabled` (default false).", field)
    assert.deepStrictEqual([...values], [["{field}", "rulersEnabled"], ["{default}", "false"]])
    assert.strictEqual(applyFills("Add `{field}: {type};`", values), "Add `rulersEnabled: {type};`")
    assert.strictEqual(fillsFor("A new setting.", field).size, 0)
  })

  it("writes filled values into the hand-over and lists only the blanks left; without fills the hand-over is unchanged", () => {
    const task = "A new appState field `rulersEnabled` (default false). Toggle it with Alt+U."
    const chosen = cueChoice(memory, task)
    const plain = renderHandover(memory, chosen, new Map())
    assert.strictEqual(renderHandover(memory, chosen, new Map(), undefined, undefined).text, plain.text)
    assert.isTrue(plain.text.includes("Blanks: {field} the new field; {default} its default"))
    assert.isTrue(plain.text.includes("Add `{field}: {default},`"))
    const fills = new Map(chosen.map((c) => [c.workflow.id, fillsFor(task, c.workflow)]))
    const filled = renderHandover(memory, chosen, new Map(), undefined, fills).text
    assert.isTrue(filled.includes("Values your task states are filled in"))
    assert.isTrue(filled.includes("Filled from your task: {field} = `rulersEnabled`, {default} = `false`"))
    assert.isTrue(filled.includes("Add `rulersEnabled: false,` to the defaults."))
    assert.isTrue(filled.includes("Add `rulersEnabled: {type};`"))
    assert.isFalse(filled.includes("Blanks: {field}"))
    assert.isTrue(filled.includes("Add `U` to the key table."))
    assert.isTrue(filled.includes("List Alt+U in the help dialog."))
  })

  it("reads a task that lists several changes as its items, with what it says of all of them", () => {
    const task = [
      "Three changes:",
      "",
      "1. Add a new appState field `rulersEnabled` (default false).",
      "Toggle it with Alt+U.",
      "",
      "2. Change the shortcut from Alt+/ to Alt+K.",
      "",
      "3. Add a new appState field `presenterEnabled`",
      "  (default true).",
      "",
      "Make sure the tests pass."
    ].join("\n")
    const split = taskParts(task)
    assert.deepStrictEqual(split?.parts, [
      { label: "1", text: "Add a new appState field `rulersEnabled` (default false).\nToggle it with Alt+U." },
      { label: "2", text: "Change the shortcut from Alt+/ to Alt+K." },
      { label: "3", text: "Add a new appState field `presenterEnabled`\n(default true)." }
    ])
    assert.strictEqual(split?.shared, "Three changes:\nMake sure the tests pass.")
    assert.deepStrictEqual(taskParts("- one thing\n\n  more of it\n- another")?.parts, [{ label: "1", text: "one thing\nmore of it" }, { label: "2", text: "another" }])
    assert.isUndefined(taskParts("Add a new appState field `x`. Toggle it with Alt+U, in version 2.1.286."))
    assert.isUndefined(taskParts("Do this:\n1. one thing"))
  })

  it("picks and fills a task in parts change by change", () => {
    const task = [
      "1. Add a new appState field `rulersEnabled` (default false). Toggle it with Alt+U, from the menu (also in view mode).",
      "2. Change the shortcut from Alt+/ to Alt+K.",
      "3. Add a new appState field `presenterEnabled` (default true). Toggle it with Alt+J, but not in view mode.",
      "",
      "Add a test for each."
    ].join("\n")
    const choice = partsChoice(memory, task)
    assert.strictEqual(choice?.count, 3)
    // The whole task's "from Alt+" would rule the shortcut workflow out; only change 2 says it.
    assert.deepStrictEqual(ids(task), ["add-field", "keyboard-test"])
    assert.deepStrictEqual(choice?.chosen.map((c) => c.workflow.id), ["add-field", "add-shortcut", "keyboard-test"])
    assert.deepStrictEqual(choiceByCues(memory, task).map((c) => c.workflow.id), ["add-field", "add-shortcut", "keyboard-test"])
    const field = choice?.uses.get("add-field") ?? []
    assert.deepStrictEqual(field.map((u) => [u.label, Object.fromEntries(u.values)]), [
      ["1", { "{field}": "rulersEnabled", "{default}": "false" }],
      ["3", { "{field}": "presenterEnabled", "{default}": "true" }]
    ])
    const shortcut = choice?.uses.get("add-shortcut") ?? []
    assert.deepStrictEqual(shortcut.map((u) => [u.label, u.values.get("{code}"), u.skip]), [["1", "U", []], ["3", "J", [3]]])
    // A step one change needs stays.
    assert.deepStrictEqual(choice?.chosen.find((c) => c.workflow.id === "add-shortcut")?.skip, [])
    // What the task says of all of them goes with each.
    assert.deepStrictEqual(choice?.uses.get("keyboard-test")?.map((u) => u.label), ["1", "2", "3"])
    assert.isUndefined(partsChoice(memory, "Add a new appState field `x`. Toggle it with Alt+U."))
  })

  it("hands over a workflow several changes need once, with each change's values, and says which changes need what", () => {
    const task = [
      "1. Add a new appState field `rulersEnabled` (default false). Toggle it with Alt+U, from the menu (also in view mode).",
      "2. Add a new appState field `presenterEnabled` (default false). Toggle it with Alt+J, but not in view mode.",
      "3. Add a test."
    ].join("\n")
    const choice = partsChoice(memory, task)
    assert.isDefined(choice)
    if (choice === undefined) return
    const text = renderHandover(memory, choice.chosen, new Map(), undefined, undefined, 1, choice).text
    assert.isTrue(text.includes("Your task lists several changes"))
    assert.isTrue(text.includes("## 1. add-field (for 1 and 2 in your list)"))
    assert.isTrue(text.includes("Filled from your task, change by change: 1: {field} = `rulersEnabled`, {default} = `false`; 2: {field} = `presenterEnabled`, {default} = `false`"))
    // Values that differ stay blanks in the steps.
    assert.isTrue(text.includes("Add `{field}: {default},` to the defaults."))
    assert.isFalse(text.includes("Blanks: {field}"))
    assert.isTrue(text.includes("Add it to the view-mode menu. (only if the task wants it in view mode too) (for 1 only)"))
    assert.isTrue(text.includes("## 3. keyboard-test (for 3 in your list)"))
    // Values the changes agree on are written into the steps.
    const same = "1. Add a new appState field `rulersEnabled` (default false).\n2. Toggle it with Alt+U."
    const agreed = partsChoice(memory, same)
    assert.isDefined(agreed)
    if (agreed === undefined) return
    const filled = renderHandover(memory, agreed.chosen, new Map(), undefined, undefined, 1, agreed).text
    assert.isTrue(filled.includes("Add `rulersEnabled: false,` to the defaults."))
    assert.isTrue(filled.includes("List Alt+U in the help dialog."))
  })

  it("is local first: the task-start hook picks by cues unless a model or words are asked for", () => {
    assert.strictEqual(pickMode(undefined), "cues")
    assert.strictEqual(pickMode(""), "cues")
    assert.strictEqual(pickMode("cues"), "cues")
    assert.strictEqual(pickMode("off"), "words")
    // The measured `workflows` setup sets "on".
    assert.strictEqual(pickMode("on"), "model")
    assert.strictEqual(pickMode("model"), "model")
  })

  it("keeps memory written before cues the same on disk", () => {
    const encode = Schema.encodeSync(WorkflowMemory)
    const old = { ...memory, workflows: [noCues] }
    assert.isFalse("cues" in (encode(old).workflows[0] as object))
    assert.deepStrictEqual(Schema.decodeUnknownSync(WorkflowMemory)(encode(old)), old)
  })
})

const seed = (task: string, prompt: string, values: ReadonlyArray<string>): RunEvidence => ({
  record: `${task}-1`,
  subject: "repo",
  task,
  prompt,
  base: "abc",
  tokens: 1000,
  turns: 3,
  uses: [],
  snapshots: [],
  checks: [],
  detours: [],
  readFirst: [],
  values: [...values],
  calls: [],
  cwd: undefined,
  looking: null,
  reads: []
})

const plainMemory: WorkflowMemory = {
  ...memory,
  workflows: memory.workflows.map((w) => Object.fromEntries(Object.entries(w).filter(([k]) => k !== "cues")) as Workflow)
}

const seeds = [
  seed("toggle-minimap", "Add a \"Minimap\" setting in a new appState field `minimapEnabled` (default false). Toggle it with Alt+M.", ["Minimap", "minimapEnabled", "Alt+M"]),
  seed("altkey-zen-m", "Change the zen mode keyboard shortcut from Alt+Z to Alt+M.", ["Alt+Z", "Alt+M"])
]

const answer = (over: Partial<CuesAnswer> = {}): CuesAnswer => ({
  workflows: [
    { id: "add-field", any: ["new appState field"], none: [], steps: [], fills: [{ placeholder: "{field}", from: "code", n: 1, phrase: null }] },
    { id: "add-shortcut", any: ["toggle it with Alt+"], none: [], steps: [{ step: 3, any: ["view mode"], none: [] }], fills: [] },
    { id: "keyboard-test", any: ["add a test"], none: [], steps: [], fills: [] },
    { id: "no-cues", any: ["shortcut from Alt+"], none: [], steps: [], fills: [] }
  ],
  tasks: [{ task: "toggle-minimap", needs: ["add-field", "add-shortcut"] }, { task: "altkey-zen-m", needs: ["no-cues"] }],
  rationale: "",
  ...over
})

describe("checking written cues", () => {
  it("keeps cues that pick each learned task's workflows and fill its own values", () => {
    const checked = checkCues(answer(), plainMemory, seeds)
    assert.deepStrictEqual(checked.problems, [])
    assert.deepStrictEqual(checked.memory.workflows.find((w) => w.id === "add-field")?.cues?.fills.map((f) => f.placeholder), ["{field}"])
    assert.deepStrictEqual(cueChoice(checked.memory, seeds[1].prompt).map((c) => c.workflow.id), ["no-cues"])
  })

  it("drops phrases that name a task's own value, fills of placeholders the steps don't have, and cues for steps without a condition", () => {
    const a = answer()
    const checked = checkCues({
      ...a,
      workflows: [
        { ...a.workflows[0], any: ["new appState field", "Minimap"], fills: [{ placeholder: "{nothing}", from: "quoted", n: 1, phrase: null }] },
        { ...a.workflows[1], steps: [{ step: 1, any: ["x"], none: [] }] },
        a.workflows[2],
        a.workflows[3]
      ]
    }, plainMemory, seeds)
    assert.deepStrictEqual(checked.memory.workflows.find((w) => w.id === "add-field")?.cues?.any, ["new appState field"])
    assert.strictEqual(checked.memory.workflows.find((w) => w.id === "add-field")?.cues?.fills.length, 0)
    assert.strictEqual(checked.memory.workflows.find((w) => w.id === "add-shortcut")?.cues?.steps.length, 0)
    assert.isTrue(checked.problems.some((p) => p.includes("\"Minimap\" names a task's own value")))
    assert.isTrue(checked.problems.some((p) => p.includes("{nothing}")))
    assert.isTrue(checked.problems.some((p) => p.includes("step 1")))
  })

  it("reports cues that don't pick what a learned task needs, and fills that find nothing or no value of the task", () => {
    const a = answer()
    const checked = checkCues({
      ...a,
      workflows: [
        { ...a.workflows[0], fills: [{ placeholder: "{field}", from: "quoted", n: 2, phrase: null }] },
        { ...a.workflows[1], any: ["keyboard shortcut"] },
        a.workflows[2],
        a.workflows[3]
      ]
    }, plainMemory, seeds)
    assert.isTrue(checked.problems.some((p) => p.includes("the fill of {field} in add-field finds nothing")))
    assert.isTrue(checked.problems.some((p) => p.includes("pick add-shortcut for task \"altkey-zen-m\"")))
    const quoted = checkCues({ ...a, workflows: [{ ...a.workflows[0], fills: [{ placeholder: "{field}", from: "code", n: 1, phrase: null }] }, ...a.workflows.slice(1)] }, plainMemory, [
      seed("toggle-minimap", "Add a new appState field `notAValue`. Toggle it with Alt+M.", ["Alt+M"]),
      seeds[1]
    ])
    assert.isTrue(quoted.problems.some((p) => p.includes("isn't one of its own values")))
  })
})
