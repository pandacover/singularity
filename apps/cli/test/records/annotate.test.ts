import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { annotateRecord, type Reading, triggerValue, unread, verifyReading, vocabularyOf } from "../../src/records/Annotate.ts"
import { buildRecord } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { FAKE_CLAUDE, run, tempDir, withEnv } from "../eval/helpers.ts"
import { bash, CWD, DIFF, session, sessionJsonl } from "./fixtures.ts"

const FLAG_ERROR = `Error: Expected a single value for option "-w, --watch", received [false, false]\nerror Command failed with exit code 1.`
const TURNS = [
  [bash("yarn test:update --watch=false 2>&1 | tail -30", FLAG_ERROR)],
  [bash("yarn test:update 2>&1 | tail -25", "Test Files  139 passed (139)")]
]
const PROMPT = "Change the zen mode shortcut from Alt+Z to Alt+M"

const record = (log = "session.jsonl") =>
  buildRecord({
    tenant: "local",
    subject: "repo",
    trace: session(PROMPT, TURNS),
    diff: DIFF,
    outcome: "success",
    checks: [],
    memory: null,
    run: {
      source: "eval",
      log,
      run_dir: null,
      run_id: null,
      setup: "no-memory",
      task_id: "zen",
      repo: null,
      base_commit: "abc",
      head_commit: null,
      started_at: null,
      cost_usd: null,
      tokens: null
    },
    createdAt: "2026-10-01T10:00:00Z"
  })

const step = (name: string, extra: Partial<Reading["steps"][number]> = {}): Reading["steps"][number] => ({
  name,
  purpose: "",
  origin: "asked",
  files: [],
  check: null,
  landmarks: [],
  ...extra
})

const READING: Reading = {
  kind: { name: "change an action's keyboard shortcut", description: "Rebind a shortcut everywhere it shows." },
  asked: ["change the shortcut"],
  ruled_out: [],
  values: [{ name: "new key", value: "Alt+M" }],
  steps: [
    step("add the key code to the key table", {
      files: ["src/keys.ts", "src/nope.ts"],
      check: "yarn test:update 2>&1 | tail -25",
      landmarks: [
        { fact: "key codes live in one table", file: "src/keys.ts", anchors: ["KEYS"] },
        { fact: "made up", file: "src/keys.ts", anchors: ["NOPE_NOT_THERE"] },
        { fact: "the new module", file: "src/new.ts", anchors: ["export const x"] },
        { fact: "missing file", file: "missing.ts", anchors: ["x"] }
      ]
    }),
    step("bind Alt+M", { check: "yarn lint" })
  ],
  lessons: [
    { detour: 0, lesson: "test:update already passes --watch=false", step: "add the key code to the key table", trigger: { on: "command", all: ["test:update", "--watch=false"], none: [], file: null } },
    { detour: 0, lesson: "too broad", step: "no such step", trigger: { on: "command", all: ["test:update"], none: [], file: null } },
    { detour: 5, lesson: "no such detour", step: null, trigger: null }
  ],
  false_leads: [
    { what: "Z in the key table is another key", file: "src/keys.ts", anchors: ["Z: \"z\""] },
    { what: "made up", file: "src/keys.ts", anchors: ["Q"] }
  ],
  tests: [{ file: "tests/a.test.tsx", covers: "nothing" }]
}

const BASE: Record<string, string> = { "src/keys.ts": "export const KEYS = {\n  A: \"a\",\n  Z: \"z\",\n}\n" }

describe("verifyReading", () => {
  it("keeps what holds against the code and the run, and drops the rest", () => {
    const r = record()
    const { dropped, part } = verifyReading(READING, { record: r, trace: session(PROMPT, TURNS), diff: DIFF, fileAtBase: (p) => BASE[p] })
    const [first, second] = part.steps
    assert.deepStrictEqual(first.files, ["src/keys.ts"])
    assert.strictEqual(first.check, "yarn test:update 2>&1 | tail -25")
    assert.deepStrictEqual(first.landmarks.map((l) => l.fact), ["key codes live in one table", "the new module"])
    assert.strictEqual(second.check, null)
    assert.deepStrictEqual(part.lessons.map((l) => [l.lesson, l.step, l.trigger === null]), [
      ["test:update already passes --watch=false", "add the key code to the key table", false],
      ["too broad", null, true]
    ])
    assert.deepStrictEqual(part.false_leads.map((f) => f.what), ["Z in the key table is another key"])
    assert.deepStrictEqual(part.tests, [])
    assert.deepStrictEqual(dropped, [
      "step \"add the key code to the key table\": file src/nope.ts wasn't changed by the run",
      "landmark \"made up\": \"NOPE_NOT_THERE\" isn't in src/keys.ts",
      "landmark \"missing file\": missing.ts doesn't exist at the base commit",
      "step \"bind Alt+M\": check `yarn lint` isn't a command that worked in the run",
      "step \"bind Alt+M\" names this task's own value \"Alt+M\" (kept; rename it in the graph)",
      "trigger (a command with `test:update`) for \"too broad\": it also matches the call that fixed it",
      "lesson \"no such detour\": there is no detour 5",
      "false lead \"made up\": anchor \"Q\" is too short to prove anything",
      "test file tests/a.test.tsx doesn't exist"
    ])
    assert.deepStrictEqual(part.dropped, dropped)
  })

  it("drops a trigger with the task's own values, which couldn't fire on another task", () => {
    const values = [{ name: "action", value: "zen mode (actionToggleZenMode)" }, { name: "default", value: "false" }]
    const edit = (all: Array<string>) => ({ on: "edit" as const, all, none: ["handleKeyboardGlobally"], file: "tests/excalidraw.test.tsx" })
    assert.strictEqual(triggerValue(edit(["zen mode with Alt+M", "render(<Excalidraw />)"]), values), "zen mode")
    assert.isUndefined(triggerValue(edit(["fireEvent.keyDown(document", "altKey"]), values))
    // A literal like `false` is no one task's value; the doubled flag stays a trigger.
    assert.isUndefined(triggerValue({ on: "command", all: ["test:update", "--watch=false"], none: [], file: null }, values))
    const reading = { ...READING, values: [...READING.values, { name: "flag", value: "--watch=false" }], lessons: [READING.lessons[0]] }
    const { dropped, part } = verifyReading(reading, { record: record(), trace: session(PROMPT, TURNS), diff: DIFF, fileAtBase: (p) => BASE[p] })
    assert.isNull(part.lessons[0].trigger)
    assert.isTrue(dropped.some((d) => d.includes("names this task's own value \"--watch=false\", so it couldn't fire on another task")))
  })
})

describe("vocabularyOf and unread", () => {
  it("names kinds and steps by use, and picks records without a reading", () => {
    const a = { ...record(), id: "a", model: { ...verifyReading(READING, { record: record(), trace: session(PROMPT, TURNS), diff: DIFF, fileAtBase: (p) => BASE[p] }).part, model: "m", created_at: "", cost_usd: null } }
    const b = { ...record(), id: "b" }
    const c = { ...record(), id: "c", run: { ...record().run, setup: "graph" } }
    const d = { ...record(), id: "d", run: { ...record().run, task_id: "other", setup: "graph" } }
    const v = vocabularyOf([a, b])
    assert.deepStrictEqual(v.kinds.map((k) => k.name), ["change an action's keyboard shortcut"])
    assert.deepStrictEqual(v.steps.map((s) => s.name), ["add the key code to the key table", "bind Alt+M"])
    // One reading per task: "zen" has one already.
    assert.deepStrictEqual(unread([c, a, b, d], 1).map((r) => r.id), ["d"])
    assert.deepStrictEqual(unread([c, a, b, d], 2).map((r) => r.id), ["b", "d"])
  })
})

describe("annotateRecord", () => {
  it("asks the model, checks the answer and stores the reading", async () => {
    const root = tempDir()
    const log = join(root, "session.jsonl")
    writeFileSync(log, sessionJsonl(PROMPT, TURNS, CWD))
    const answers = join(root, "answers.json")
    writeFileSync(answers, JSON.stringify([READING]))
    const cwd = join(root, "llm")
    mkdirSync(cwd)
    const layer = JsonRecordStore.layer(join(root, "tenant"), "local")
    const stored = await withEnv({ FAKE_CLAUDE_ANSWERS: answers }, () =>
      run(Effect.gen(function*() {
        const store = yield* RecordStore
        const r = record(log)
        yield* store.put(r)
        return yield* annotateRecord({ claude: FAKE_CLAUDE, cwd, model: "sonnet", effort: "medium" }, r.id)
      }).pipe(Effect.provide(layer))))
    assert.strictEqual(stored.model?.kind.name, "change an action's keyboard shortcut")
    assert.strictEqual(stored.model?.cost_usd, 0.01)
    // No repo has the base commit and the run left no diff, so no landmark could be checked.
    assert.deepStrictEqual(stored.model?.steps[0].landmarks, [])
    assert.include(stored.model?.dropped.at(-1) ?? "", "no repo with the base commit")
    const call = JSON.parse(readFileSync(`${answers}.call0.json`, "utf-8"))
    assert.include(call.prompt, "Detour 0: command_error")
    assert.include(call.prompt, "the command lost `--watch=false`")
    assert.include(call.system, "Strings are plain text, not regular expressions")
  })
})
