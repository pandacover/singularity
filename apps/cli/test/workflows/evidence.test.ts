import { assert, describe, it } from "@effect/vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isSnapshot } from "../../src/records/Extract.ts"
import type { WorkflowRecord } from "../../src/records/Models.ts"
import { type Evidence, newNames, taskLabel, withPlacesOf } from "../../src/workflows/Evidence.ts"
import { placeProblem } from "../../src/workflows/Induce.ts"
import type { Place } from "../../src/workflows/Models.ts"
import { isKindStart, sharedNameStart } from "../../src/workflows/Places.ts"
import { handedTexts } from "../../src/workflows/Evolve.ts"
import { run, tempDir } from "../eval/helpers.ts"

const withPrompt = (prompt: string, taskId: string | null = null) =>
  ({ task: { prompt, followups: [] }, run: { task_id: taskId } }) as unknown as WorkflowRecord

describe("telling tasks apart", () => {
  it("labels a task by its whole prompt, so prompts that start alike are different tasks", () => {
    const start = "This is our fork of markdownlint. Add a new built-in rule:\n\n"
    const one = `${start}- MD061, alias \`heading-max-level\`, tag \`headings\`.`
    const a = taskLabel(withPrompt(one))
    assert.notStrictEqual(a, taskLabel(withPrompt(`${start}- MD062, alias \`code-block-max-lines\`, tag \`code\`.`)))
    assert.isTrue(a.startsWith("This is our fork of markdownlint. Add a new built-in rule: -"))
    // The same prompt is the same task, however its lines break.
    assert.strictEqual(taskLabel(withPrompt(one.replace(/\n/g, "\r\n"))), a)
    assert.strictEqual(taskLabel(withPrompt("Add teal to the colors")), "Add teal to the colors")
    assert.strictEqual(taskLabel(withPrompt("anything", "zen-shortcut")), "zen-shortcut")
  })
})

describe("a change's own names", () => {
  it("takes the names its code brought in, and from prose only what it puts in backticks", () => {
    const names = newNames(
      [
        { file: "src/colors.ts", added: [`export const colors = ["red", "teal"]`], before: [`export const colors = ["red"]`] },
        { file: "README.md", added: ["- `MD061` heading-max-level - Heading level should not exceed the maximum"], before: ["# Rules"] }
      ],
      [{ file: "doc/md061.md", content: "# MD061\n\nThis rule is triggered when a heading is deeper than the maximum." }]
    )
    assert.sameMembers(names, ["teal", "MD061", "md061"])
  })

  it("tells a kind of file by the start its names share, a numbered series included", () => {
    assert.strictEqual(sharedNameStart("actionToggleZenMode", "actionToggleRulers"), "actionToggle")
    assert.strictEqual(sharedNameStart("md066", "md065"), "md")
    assert.strictEqual(sharedNameStart("md066", "markdownlint"), "")
    assert.isTrue(isKindStart("actionToggleZenMode", "actionToggle"))
    assert.isTrue(isKindStart("md066", "md"))
    assert.isFalse(isKindStart("exports-async", "ex"))
    assert.isFalse(isKindStart("v2", "v"))
  })

  it("knows the snapshots node's test runner writes", () => {
    assert.isTrue(isSnapshot("test/markdownlint-test-scenarios.mjs.snapshot"))
    assert.isTrue(isSnapshot("src/__snapshots__/App.test.tsx.snap"))
    assert.isFalse(isSnapshot("test/snapshot.mjs"))
  })
})

describe("a learning round's places", () => {
  const place = (id: string, evidence: Array<string>, tasks: Array<string>): Place => ({
    id,
    subject: "repo",
    file: "lib/rules.mjs",
    chain: [],
    group: null,
    new_file: null,
    evidence,
    tasks,
    edits: { add: evidence.length, change: 0, create: 0 }
  })
  const evidenceOf = (places: Array<Place>): Evidence => ({ places, readPlaces: [], runs: [], skipped: [], families: new Map() })

  it("count the runs memory learned from as well as the new ones", () => {
    const learned = evidenceOf([place("p-rules", ["r1", "r2"], ["MD061", "MD062"]), place("p-old", ["r1"], ["MD061"])])
    const fresh = evidenceOf([place("p-rules", ["r3"], ["MD063"]), place("p-new", ["r3"], ["MD063"])])
    // Read alone, the new run's place is one run's, and can't carry a step.
    assert.isDefined(placeProblem(fresh.places[0], fresh.families))
    const pooled = withPlacesOf(fresh, learned, { places: [] })
    const rules = pooled.places.find((p) => p.id === "p-rules")!
    assert.deepStrictEqual([rules.evidence, rules.tasks, rules.edits.add], [["r1", "r2", "r3"], ["MD061", "MD062", "MD063"], 3])
    assert.isUndefined(placeProblem(rules, pooled.families))
    assert.deepStrictEqual(pooled.places.map((p) => p.id), ["p-rules", "p-new"])
  })

  it("list the places the new runs edited and memory's own, not every place earlier runs edited", () => {
    const learned = evidenceOf([place("p-step", ["r1", "r2"], ["MD061", "MD062"]), place("p-old", ["r1"], ["MD061"])])
    const fresh = evidenceOf([place("p-new", ["r3"], ["MD063"])])
    const pooled = withPlacesOf(fresh, learned, { places: [place("p-step", ["r1"], ["MD061"])] })
    assert.deepStrictEqual(pooled.places.map((p) => [p.id, p.evidence.length]), [["p-step", 2], ["p-new", 1]])
  })
})

describe("what runs were handed", () => {
  it("reads what a session in daily use was handed at its start from the hand-over log", async () => {
    const tenantDir = tempDir()
    mkdirSync(join(tenantDir, "workflows"))
    writeFileSync(
      join(tenantDir, "workflows", "handovers.jsonl"),
      [
        JSON.stringify({ at: "2026-10-11T01:37:25Z", session_id: "s1", moment: "start", version: 1, text: "Memory for this task" }),
        JSON.stringify({ at: "2026-10-11T01:39:00Z", session_id: "s2", moment: "start", version: 1, text: null }),
        "not json"
      ].join("\n") + "\n"
    )
    const record = (id: string, session: string) => ({ id, run: { run_dir: null, run_id: null, session_id: session } }) as unknown as WorkflowRecord
    const texts = await run(handedTexts([record("r1", "s1"), record("r2", "s2"), record("r3", "s3")], tenantDir))
    assert.deepStrictEqual([...texts.entries()], [["r1", "Memory for this task"]])
    // Without the tenant's directory, only eval runs' hand-overs are known.
    assert.strictEqual((await run(handedTexts([record("r1", "s1")]))).size, 0)
  })
})
