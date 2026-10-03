/**
 * Records with a model's reading, for building graphs in tests.
 */
import { buildRecord } from "../../src/records/Build.ts"
import type { Detour, Lesson, ModelPart, RecordStep, WorkflowRecord } from "../../src/records/Models.ts"
import { bash, DIFF, session } from "../records/fixtures.ts"

export const step = (name: string, origin: RecordStep["origin"] = "asked", files: Array<string> = [], extra: Partial<RecordStep> = {}): RecordStep => ({
  name,
  purpose: `${name}.`,
  origin,
  files,
  check: null,
  landmarks: [],
  ...extra
})

const FLAG_ERROR = `Error: Expected a single value for option "-w, --watch", received [false, false]\nerror Command failed with exit code 1.`

let n = 0

/** A read record: a run of `prompt` of kind `kind` that took `steps`; with `flag`, it also made the doubled-flag mistake. */
export const readRecord = (
  prompt: string,
  kind: string,
  steps: ReadonlyArray<RecordStep>,
  options: {
    readonly subject?: string
    readonly flag?: boolean
    readonly lessons?: ReadonlyArray<Lesson>
    readonly values?: ModelPart["values"]
    readonly falseLeads?: ModelPart["false_leads"]
  } = {}
): WorkflowRecord => {
  n++
  const turns = options.flag === true
    ? [[bash("yarn test:update --watch=false 2>&1 | tail -30", FLAG_ERROR)], [bash("yarn test:update 2>&1 | tail -30", "Test Files  9 passed (9)")]]
    : [[bash("yarn test:update", "Test Files  9 passed (9)")]]
  const trace = { ...session(prompt, turns), sessionId: `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000` }
  const r = buildRecord({
    tenant: "local",
    subject: options.subject ?? "repo",
    trace,
    diff: DIFF,
    outcome: "success",
    checks: [],
    memory: null,
    run: {
      source: "eval",
      log: "session.jsonl",
      run_dir: null,
      run_id: null,
      setup: "no-memory",
      task_id: null,
      repo: null,
      base_commit: "abc",
      head_commit: null,
      started_at: `2026-10-01T10:${String(n % 60).padStart(2, "0")}:00Z`,
      cost_usd: null,
      tokens: null
    },
    createdAt: "2026-10-01T12:00:00Z"
  })
  return {
    ...r,
    model: {
      model: "test",
      created_at: "2026-10-01T12:00:00Z",
      cost_usd: null,
      kind: { name: kind, description: `${kind}.` },
      asked: [],
      ruled_out: [],
      values: options.values ?? [],
      steps: [...steps],
      lessons: [...(options.lessons ?? [])],
      false_leads: [...(options.falseLeads ?? [])],
      tests: [],
      dropped: []
    }
  }
}

export const flagLesson = (stepName: string): Lesson => ({
  detour: 0,
  lesson: "test:update already passes --watch=false; run it without the flag.",
  step: stepName,
  trigger: { on: "command", all: ["test:update", "--watch=false"], none: [], file: null }
})

export const detourOf = (r: WorkflowRecord): Detour => r.detours[0]
