/**
 * Contract tests for RecordStore. Every backend in `backends` runs them
 * against a fresh, empty store; a database backend gets added there.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import type { RepoIdentity } from "../../src/local/Git.ts"
import { buildRecord } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import type { ModelPart, WorkflowRecord } from "../../src/records/Models.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { bash, DIFF, session } from "./fixtures.ts"

interface Backend {
  readonly name: string
  readonly layer: Layer.Layer<RecordStore, unknown>
}

const jsonInTempDir = Layer.unwrap(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "record-store-" })
    return JsonRecordStore.layer(path.join(dir, "tenants", "t1"), "t1")
  })
).pipe(Layer.provide(NodeServices.layer))

const backends: ReadonlyArray<Backend> = [{ name: "json", layer: jsonInTempDir }]

const repo: RepoIdentity = { root: "C:/work/excalidraw", rootCommits: ["aaa"], remotes: [], head: "bbb" }

export const sampleRecord = (subject = "excalidraw", tenant = "t1", sessionId?: string): WorkflowRecord => {
  const trace = session("Change the zen mode shortcut", [
    [bash("yarn test:update --watch=false", "Error: Expected a single value for option\nerror Command failed with exit code 1.")],
    [bash("yarn test:update", "Test Files  139 passed (139)")]
  ])
  return buildRecord({
    tenant,
    subject,
    trace: sessionId === undefined ? trace : { ...trace, sessionId },
    diff: DIFF,
    outcome: "success",
    checks: [{ command: "yarn tsc", ok: true, exit_code: 0 }],
    memory: null,
    run: {
      source: "eval",
      log: "session.jsonl",
      run_dir: null,
      run_id: null,
      setup: null,
      task_id: null,
      repo: null,
      base_commit: "abc",
      head_commit: null,
      started_at: "2026-10-01T10:00:00Z",
      cost_usd: 0.1,
      tokens: 1000
    },
    createdAt: "2026-10-01T10:05:00Z"
  })
}

const modelPart = (kind: string): ModelPart => ({
  model: "fake",
  created_at: "2026-10-01T11:00:00Z",
  cost_usd: 0.01,
  kind: { name: kind, description: "" },
  asked: [],
  ruled_out: [],
  values: [],
  steps: [{ name: "Update the help dialog", purpose: "", origin: "asked", files: [], check: null, landmarks: [] }],
  lessons: [],
  false_leads: [],
  tests: [],
  dropped: []
})

for (const backend of backends) {
  describe(`RecordStore (${backend.name})`, () => {
    it.effect("stores and finds records", () =>
      Effect.gen(function*() {
        const store = yield* RecordStore
        const r = sampleRecord()
        yield* store.put(r)
        assert.isTrue(yield* store.has(r.id))
        assert.deepStrictEqual(yield* store.get(r.id), r)
        const other = sampleRecord("other", "t1", "99999999-0000-0000-0000-000000000000")
        yield* store.put(other)
        assert.deepStrictEqual((yield* store.find()).map((x) => x.id), [r.id, other.id])
        assert.deepStrictEqual((yield* store.find({ subject: "other" })).map((x) => x.id), [other.id])
        assert.deepStrictEqual((yield* store.find({ key: "test:update" })).length, 2)
        assert.deepStrictEqual((yield* store.find({ key: "no such command" })).length, 0)
        assert.deepStrictEqual((yield* store.find({ outcome: "failure" })).length, 0)
      }).pipe(Effect.provide(backend.layer)))

    it.effect("refuses a record twice, or for another tenant", () =>
      Effect.gen(function*() {
        const store = yield* RecordStore
        yield* store.put(sampleRecord())
        const twice = yield* Effect.flip(store.put(sampleRecord()))
        assert.strictEqual(twice._tag, "RecordExists")
        const foreign = yield* Effect.flip(store.put(sampleRecord("excalidraw", "t2", "88888888-0000-0000-0000-000000000000")))
        assert.strictEqual(foreign._tag, "StoreError")
        const missing = yield* Effect.flip(store.get("nope"))
        assert.strictEqual(missing._tag, "RecordNotFound")
      }).pipe(Effect.provide(backend.layer)))

    it.effect("adds the model's reading once, and feedback any time", () =>
      Effect.gen(function*() {
        const store = yield* RecordStore
        const r = sampleRecord()
        yield* store.put(r)
        yield* store.annotate(r.id, modelPart("change a shortcut"))
        assert.strictEqual((yield* Effect.flip(store.annotate(r.id, modelPart("x"))))._tag, "Conflict")
        yield* store.annotate(r.id, modelPart("Change a Shortcut"), { replace: true })
        assert.strictEqual((yield* store.find({ kind: "change a shortcut" })).length, 1)
        assert.strictEqual((yield* store.find({ step: "update the help dialog" })).length, 1)
        assert.strictEqual((yield* store.find({ annotated: false })).length, 0)
        const item = { id: "w1", kind: "warning", moment: "trigger" as const, outcome: "followed" as const, note: null }
        yield* store.addFeedback(r.id, { setup: "hooks", version: 3, items: [item] })
        const updated = yield* store.addFeedback(r.id, { setup: "hooks", version: 3, items: [{ ...item, id: "w2" }] })
        assert.deepStrictEqual(updated.memory?.items.map((i) => i.id), ["w1", "w2"])
      }).pipe(Effect.provide(backend.layer)))

    it.effect("knows repos by root commit, remote or path", () =>
      Effect.gen(function*() {
        const store = yield* RecordStore
        assert.isUndefined(yield* store.subjectFor(repo))
        const s = yield* store.subjectFor(repo, { create: true })
        assert.strictEqual(s?.id, "excalidraw")
        // A clone elsewhere, with a remote: same subject, now with the remote and path.
        const clone = { ...repo, root: "D:/elsewhere/excalidraw", remotes: ["github.com/excalidraw/excalidraw"] }
        const same = yield* store.subjectFor(clone)
        assert.strictEqual(same?.id, "excalidraw")
        assert.deepStrictEqual(same?.remotes, ["github.com/excalidraw/excalidraw"])
        assert.strictEqual(same?.paths.length, 2)
        // Another repo with the same name gets its own id.
        const other = yield* store.subjectFor({ root: "C:/x/excalidraw", rootCommits: ["ccc"], remotes: [], head: undefined }, { create: true })
        assert.strictEqual(other?.id, "excalidraw-2")
        assert.strictEqual((yield* store.subjects()).length, 2)
      }).pipe(Effect.provide(backend.layer)))
  })
}
