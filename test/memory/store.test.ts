/**
 * Contract tests for MemoryStore. A database backend gets added to `backends`.
 */
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { buildGraph } from "../../src/memory/Build.ts"
import * as JsonMemoryStore from "../../src/memory/JsonMemoryStore.ts"
import { diffGraphs, emptyGraph } from "../../src/memory/Models.ts"
import { MemoryStore } from "../../src/memory/MemoryStore.ts"
import { flagLesson, readRecord, step } from "./fixtures.ts"

const jsonInTempDir = Layer.unwrap(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "memory-store-" })
    return JsonMemoryStore.layer(path.join(dir, "memory"), "local")
  })
).pipe(Layer.provide(NodeServices.layer))

const backends = [{ name: "json", layer: jsonInTempDir }]

const graph = (subject = "repo") =>
  buildGraph([
    readRecord("Change the zen mode shortcut", "change a shortcut", [step("update the help dialog", "asked", ["Help.tsx"]), step("run the tests", "needed")], {
      subject,
      flag: true,
      lessons: [flagLesson("run the tests")]
    })
  ], { tenant: "local" })

for (const backend of backends) {
  describe(`MemoryStore (${backend.name})`, () => {
    it.effect("starts empty, and commits a candidate as the next version", () =>
      Effect.gen(function*() {
        const store = yield* MemoryStore
        assert.strictEqual(yield* store.head(), 0)
        assert.deepStrictEqual(yield* store.graph(), emptyGraph)
        const g = graph()
        const c = yield* store.propose(diffGraphs(emptyGraph, g), { rationale: "first", records: ["r1"] })
        assert.strictEqual(c.status, "pending")
        // A candidate can be read before it is committed.
        assert.deepStrictEqual(yield* store.graph(c.id), g)
        assert.strictEqual(yield* store.head(), 0)
        assert.strictEqual(yield* store.commit(c.id), 1)
        assert.deepStrictEqual(yield* store.graph(), g)
        assert.deepStrictEqual(yield* store.graph(0), emptyGraph)
        assert.strictEqual((yield* store.candidates("committed")).length, 1)
        const again = yield* Effect.flip(store.commit(c.id))
        assert.strictEqual(again._tag, "Conflict")
      }).pipe(Effect.provide(backend.layer)))

    it.effect("rejects with a reason, and refuses a candidate whose base moved", () =>
      Effect.gen(function*() {
        const store = yield* MemoryStore
        const a = yield* store.propose(diffGraphs(emptyGraph, graph()), { rationale: "a", records: [] })
        const b = yield* store.propose(diffGraphs(emptyGraph, graph("other")), { rationale: "b", records: [] })
        yield* store.commit(a.id)
        assert.strictEqual((yield* Effect.flip(store.commit(b.id)))._tag, "Conflict")
        yield* store.reject(b.id, "the head moved")
        const [rejected] = yield* store.candidates("rejected")
        assert.deepStrictEqual([rejected.id, rejected.reason], [b.id, "the head moved"])
        assert.strictEqual((yield* Effect.flip(store.graph("c999999")))._tag, "CandidateNotFound")
      }).pipe(Effect.provide(backend.layer)))

    it.effect("answers for a subject only with what reaches it", () =>
      Effect.gen(function*() {
        const store = yield* MemoryStore
        const c = yield* store.propose(diffGraphs(emptyGraph, graph()), { rationale: "a", records: [] })
        yield* store.commit(c.id)
        assert.strictEqual((yield* store.kinds("repo")).length, 1)
        assert.strictEqual((yield* store.kinds("elsewhere")).length, 0)
        assert.strictEqual((yield* store.warnings("repo")).length, 1)
        assert.strictEqual((yield* store.warnings("elsewhere")).length, 0)
        const [kind] = yield* store.kinds("repo")
        const steps = yield* store.steps(kind.route.map((e) => e.step))
        assert.deepStrictEqual(steps.map((s) => s.name).sort(), ["run the tests", "update the help dialog"])
        assert.strictEqual((yield* store.item(kind.id))?.type, "kind")
      }).pipe(Effect.provide(backend.layer)))
  })
}
