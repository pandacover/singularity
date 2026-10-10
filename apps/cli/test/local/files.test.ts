import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { writeFileWhole } from "../../src/local/Files.ts"
import type { RepoIdentity } from "../../src/local/Git.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"

describe("writing files whole", () => {
  it.live("lets writers of the same file run at once: each write succeeds, the file is one of them whole, no temporary file stays", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "files-" })
      const file = path.join(dir, "subjects.json")
      const texts = Array.from({ length: 12 }, (_, i) => `${"x".repeat(1000)} ${i}\n`)
      yield* Effect.all(texts.map((t) => writeFileWhole(fs, file, t)), { concurrency: "unbounded" })
      assert.isTrue(texts.includes(yield* fs.readFileString(file)))
      assert.deepStrictEqual(yield* fs.readDirectory(dir), ["subjects.json"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("lets stores in separate processes note a repo's new path at the same moment (the two task-start hooks)", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "subjects-" }), "tenants", "t1")
      const repo: RepoIdentity = { root: "C:/work/excalidraw", rootCommits: ["aaa"], remotes: [], head: "bbb" }
      yield* (yield* JsonRecordStore.make(dir, "t1")).subjectFor(repo, { create: true })
      // Each store stands for a process of its own: no lock is shared between them.
      const stores = yield* Effect.all(Array.from({ length: 8 }, () => JsonRecordStore.make(dir, "t1")))
      const lane2 = { ...repo, root: "C:/work/lane2/excalidraw" }
      const found = yield* Effect.all(stores.map((s) => s.subjectFor(lane2)), { concurrency: "unbounded" })
      assert.isTrue(found.every((s) => s?.id === "excalidraw"))
      const subject = (yield* (yield* JsonRecordStore.make(dir, "t1")).subjects())[0]
      assert.deepStrictEqual(subject.paths, ["C:/work/excalidraw", "C:/work/lane2/excalidraw"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
