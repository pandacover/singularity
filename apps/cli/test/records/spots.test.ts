import { assert, describe, it } from "@effect/vitest"
import { buildRecord } from "../../src/records/Build.ts"
import { spotsOfDiff, tellingLine } from "../../src/records/Spots.ts"
import { bash, session } from "./fixtures.ts"

/** One file's part of a diff. */
const part = (path: string, hunks: string, header = "index 1..2 100644\n") =>
  `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n${hunks}`

const IMPORT = `@@ -10,6 +10,7 @@ import {
   actionToggleGridMode,
   actionToggleObjectsSnapMode,
+  actionToggleMinimap,
   actionToggleArrowBinding,
   actionToggleStats,
 } from "../actions";
`

const HELP = `@@ -40,6 +41,10 @@ export const HelpDialog = () => {
               label={t("buttons.objectsSnapMode")}
               shortcuts={[getShortcutKey("Alt+S")]}
             />
+            <Shortcut
+              label={t("labels.minimap")}
+              shortcuts={[getShortcutKey("Alt+M")]}
+            />
             <Shortcut
               label={t("labels.toggleGrid")}
`

const SNAP_AND_ARROW = { file: "src/App.tsx", above: "actionToggleObjectsSnapMode,", below: "actionToggleArrowBinding," }

describe("spotsOfDiff", () => {
  it("takes the lines above and below each added block, never the added lines", () => {
    assert.deepStrictEqual(spotsOfDiff(part("src/App.tsx", IMPORT)), [SNAP_AND_ARROW])
  })

  it("looks past brackets for a line that says something", () => {
    assert.isFalse(tellingLine("            />"))
    assert.isFalse(tellingLine("  });"))
    assert.isFalse(tellingLine("  y: 0,"))
    assert.isTrue(tellingLine("  objectsSnapModeEnabled: false,"))
    assert.deepStrictEqual(spotsOfDiff(part("src/HelpDialog.tsx", HELP)), [
      { file: "src/HelpDialog.tsx", above: `shortcuts={[getShortcutKey("Alt+S")]}`, below: "<Shortcut" }
    ])
  })

  it("takes nothing where lines were changed or removed: that was the task's own target", () => {
    const changed = `@@ -5,4 +5,4 @@ export const actionToggleZenMode = register({
   name: "zenMode",
-  keyTest: (event) => event.altKey && event.code === CODES.Z,
+  keyTest: (event) => event.altKey && event.code === CODES.M,
   viewMode: true,
`
    assert.deepStrictEqual(spotsOfDiff(part("src/actions/actionToggleZenMode.tsx", changed)), [])
    const removedBelow = `@@ -5,3 +5,3 @@
   someSetting: true,
+  otherSetting: true,
-  staleSetting: false,
`
    assert.deepStrictEqual(spotsOfDiff(part("src/a.ts", removedBelow)), [])
  })

  it("takes nothing from new files, deleted files and snapshots", () => {
    const added = part("src/new.ts", "@@ -0,0 +1,2 @@\n+export const first = 1\n+export const second = 2\n", "new file mode 100644\n")
    const deleted = part("src/old.ts", "@@ -1 +0,0 @@\n-export const gone = 1\n", "deleted file mode 100644\n")
    const snapshot = part("tests/__snapshots__/a.test.tsx.snap", `@@ -1,2 +1,3 @@\n   "gridModeEnabled": false,\n+  "minimapEnabled": false,\n   "zenModeEnabled": false,\n`)
    assert.deepStrictEqual(spotsOfDiff(added + deleted + snapshot), [])
  })

  it("doesn't reach further than three lines, or past another change", () => {
    const far = `@@ -1,9 +1,10 @@
 const somethingTelling = 1
 {
 }
 [
 ]
+const added = 1
 {
 }
 [
 ]
`
    assert.deepStrictEqual(spotsOfDiff(part("src/a.ts", far)), [])
    const pastAChange = `@@ -1,5 +1,6 @@
 const before = 1
-const removed = 1
 }
+const added = 1
 }
 const after = 1
`
    // Above: the bracket, then a removed line, so nothing; below: the line after the bracket.
    assert.deepStrictEqual(spotsOfDiff(part("src/a.ts", pastAChange)), [{ file: "src/a.ts", above: null, below: "const after = 1" }])
  })

  it("reads a diff with Windows line endings, and lists a spot once", () => {
    const twice = part("src/App.tsx", IMPORT + IMPORT.replace("-10,6 +10,7", "-90,6 +91,7"))
    assert.deepStrictEqual(spotsOfDiff(twice.replace(/\n/g, "\r\n")), [SNAP_AND_ARROW])
  })
})

describe("a record's spots", () => {
  const run = { source: "eval" as const, log: "s.jsonl", run_dir: null, run_id: null, setup: null, task_id: null, repo: null, base_commit: null, head_commit: null, started_at: null, cost_usd: null, tokens: null }
  const record = (outcome: "success" | "failure") =>
    buildRecord({
      tenant: "local",
      subject: "repo",
      trace: session("Add a minimap toggle", [[bash("yarn test", "Tests 3 passed")]]),
      diff: part("src/App.tsx", IMPORT),
      outcome,
      checks: [],
      memory: null,
      run,
      createdAt: "2026-10-03T10:00:00Z"
    })

  it("are kept for a run that succeeded, and not for one that failed", () => {
    assert.deepStrictEqual(record("success").spots, [SNAP_AND_ARROW])
    assert.deepStrictEqual(record("failure").spots, [])
  })
})
