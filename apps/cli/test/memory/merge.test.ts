import { assert, describe, it } from "@effect/vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withSpots } from "../../src/memory/Merge.ts"
import { run, tempDir } from "../eval/helpers.ts"
import { readRecord, step } from "./fixtures.ts"

const DIFF = `diff --git a/src/App.tsx b/src/App.tsx
index 1..2 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -10,5 +10,6 @@ import {
   actionToggleGridMode,
   actionToggleSnapMode,
+  actionToggleMinimap,
   actionToggleStats,
 } from "../actions";
`

describe("withSpots", () => {
  it("reads the spots of a record built before they were kept from its run's diff, where that still is", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "runs", "t1-r0"), { recursive: true })
    // The Python harness wrote diffs with Windows line endings.
    writeFileSync(join(dir, "runs", "t1-r0", "diff.patch"), DIFF.replace(/\n/g, "\r\n"))
    const base = readRecord("Add a Minimap toggle", "add a toggle setting", [step("add the action to the menu")])
    const old = { ...base, spots: undefined, run: { ...base.run, run_dir: dir, run_id: "t1-r0" } }
    const kept = { ...base, spots: [{ file: "src/a.ts", above: "keptAsItIs,", below: null }] }
    const gone = { ...old, run: { ...old.run, run_id: "no-such-run" } }
    const failed = { ...old, run: { ...old.run, outcome: "failure" as const } }
    const out = await run(withSpots([old, kept, gone, failed]))
    assert.deepStrictEqual(out[0].spots, [{ file: "src/App.tsx", above: "actionToggleSnapMode,", below: "actionToggleStats," }])
    assert.deepStrictEqual(out[1].spots, kept.spots)
    assert.isUndefined(out[2].spots)
    assert.isUndefined(out[3].spots)
  })
})
