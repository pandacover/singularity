import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import type { ToolEvent } from "../../src/records/Triggers.ts"
import { withPitfallsOf } from "../../src/workflows/Evolve.ts"
import { emptyMemory, type Pitfall, type WorkflowMemory } from "../../src/workflows/Models.ts"
import {
  DORMANT_AFTER,
  describeTally,
  foreignTo,
  instructionsSection,
  isDormant,
  readTriggerLog,
  repoHas,
  tallyPitfalls,
  tidyPitfalls
} from "../../src/workflows/Pitfalls.ts"
import { git } from "../eval/helpers.ts"

const pitfall = (id: string, over: Partial<Pitfall> = {}): Pitfall => ({
  id,
  subject: "app",
  text: `Mind ${id}.`,
  trigger: { on: "error", all: [`${id} failed`], none: [], file: null },
  evidence: [],
  cost_tokens: 0,
  ...over
})

const failure = (output: string): ToolEvent => ({ tool: "Bash", command: "npm run build", file: undefined, text: undefined, output, failed: true })
/** One stored change an hour, from 2026-10-01. */
const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toISOString()

describe("the tally of a pitfall", () => {
  it("counts where its mistake happened, its warnings, and the times it was made anyway", () => {
    const n = DORMANT_AFTER + 5
    const changes = Array.from({ length: n }, (_, i) => ({ record: `r${i}`, at: at(i), events: i === 3 ? [failure("p-old failed")] : [] }))
    // Warned during the session of the fifth change from the end, and made again after the warning.
    const log = [
      { at: at(n - 5).replace(":00.000Z", ":30.000Z"), session_id: "s1", moment: "trigger", pitfalls: ["p-warned"] },
      { at: at(n - 5).replace(":00.000Z", ":45.000Z"), session_id: "s1", moment: "again", pitfalls: ["p-warned"] }
    ]
    const tally = tallyPitfalls([pitfall("p-old"), pitfall("p-warned"), pitfall("p-learned", { evidence: [`r${n - 1}`] }), pitfall("p-unseen")], changes, log)
    assert.deepStrictEqual(tally.map((t) => [t.pitfall, t.happened, t.changes_since, t.warned, t.anyway]), [
      ["p-old", 1, n - 4, 0, 0],
      ["p-warned", 0, 4, 1, 1],
      ["p-learned", 1, 0, 0, 0],
      ["p-unseen", 0, null, 0, 0]
    ])
    assert.deepStrictEqual(tally.map(isDormant), [true, false, false, false])
    assert.strictEqual(
      describeTally(tally[1]),
      `- p-warned: happened in 0 stored changes, last ${at(n - 5).slice(0, 10)} (4 changes ago); warned 1 time, made anyway 1 time after the warning`
    )
    // About a month of changes in this repo: a pitfall that is quiet costs next to nothing, so it isn't let go soon.
    assert.strictEqual(DORMANT_AFTER, 100)
  })
})

describe("letting pitfalls go", () => {
  const repoWith = (files: Record<string, string>) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pitfalls-" })
      for (const [file, text] of Object.entries(files)) {
        yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
        yield* fs.writeFileString(path.join(root, file), text)
      }
      return root
    })

  it.effect("drops another repo's lessons, and those whose mistake hasn't happened in a long time", () =>
    Effect.gen(function*() {
      // A monorepo: the root's scripts, a workspace's, and its files named the way its own CLAUDE.md names them.
      const root = yield* repoWith({
        "package.json": JSON.stringify({ scripts: { test: "turbo run test", typecheck: "turbo run typecheck" } }),
        "package-lock.json": "{}",
        "apps/cli/package.json": JSON.stringify({ scripts: { "cli:eval": "node src/cli.ts --home runs/eval-home" } }),
        "apps/cli/src/workflows/Learn.ts": "",
        "src/a.ts": ""
      })
      git(root, "init", "-q")
      git(root, "add", "-A")
      const has = yield* repoHas(root)
      const foreign = (text: string) => foreignTo(pitfall("p", { text }), has)
      // Another repo's script, and another repo's file.
      assert.include(yield* foreign("`yarn test:update` already passes --watch=false; don't add it again."), "`test:update`")
      assert.include(yield* foreign("Edit `packages/excalidraw/App.tsx` through the editor."), "packages/excalidraw/App.tsx")
      // Here: scripts of any package.json, files by the end of a tracked path, and whatever runs a file or a tool.
      for (const text of [
        "Run `yarn test` here, not `npm test`: npm's runs nothing.",
        "Use `npm run cli:eval -- learn` for eval memory.",
        "Before editing `src/workflows/Learn.ts`, read its tests.",
        "Edit `apps/cli/src/workflows/Learn.ts` with the editor tool.",
        "Write the script to a file with the Write tool, then run `python fix.py`.",
        "Run `node scratch/peek.mjs` and `npx vitest run` from the repo root.",
        "Run `npm run typecheck` before the tests, in `src/a.ts`'s folder."
      ]) {
        assert.isUndefined(yield* foreign(text), text)
      }

      const excalidraw = pitfall("p-watch", { text: "`yarn test:update` already passes --watch=false; don't add it again." })
      const here = pitfall("p-here", { text: "Run `npm run typecheck` before the tests, in `src/a.ts`'s folder." })
      const memory: WorkflowMemory = {
        ...emptyMemory("local"),
        workflows: [{ id: "w", subject: "app", name: "W", use_when: "", only_if_asked: false, blanks: [], steps: [], checks: [], pitfalls: ["p-watch", "p-here", "p-stale"], evidence: [], tasks: [] }],
        pitfalls: [excalidraw, here, pitfall("p-stale")]
      }
      const tally = [{ pitfall: "p-stale", happened: 1, last_happened: at(1), warned: 0, last_warned: null, anyway: 0, changes_since: DORMANT_AFTER }]
      const tidied = yield* tidyPitfalls(memory, tally, has)
      assert.deepStrictEqual(tidied.memory.pitfalls.map((p) => p.id), ["p-here"])
      assert.deepStrictEqual(tidied.memory.workflows[0].pitfalls, ["p-here"])
      assert.deepStrictEqual(tidied.dropped.length, 2)
      assert.isTrue(tidied.dropped.some((d) => d.includes("p-stale") && d.includes(`last ${DORMANT_AFTER} stored changes`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("gives the model the repo's own instructions, and reads the hook's log of warnings", () =>
    Effect.gen(function*() {
      const root = yield* repoWith({
        "CLAUDE.md": "# app\r\n\r\nNormalize CRLF when reading text.\r\n",
        "workflows/handovers.jsonl": [
          JSON.stringify({ at: at(2), session_id: "s", moment: "start", workflows: [] }),
          JSON.stringify({ at: at(3), session_id: "s", moment: "trigger", pitfalls: ["p-a"], tool: "Bash" }),
          "not json",
          JSON.stringify({ at: at(4), session_id: "s", moment: "again", pitfalls: ["p-a"], tool: "Bash" })
        ].join("\n")
      })
      const section = yield* instructionsSection(root)
      assert.include(section, "## What the agent's own instructions in this repository say")
      assert.include(section, "### CLAUDE.md\n\n# app\n\nNormalize CRLF when reading text.")
      assert.strictEqual(yield* instructionsSection(undefined), "")
      assert.deepStrictEqual((yield* readTriggerLog(root)).map((l) => l.moment), ["trigger", "again"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("a rejected revision's pitfalls", () => {
  it("stay: merged, given triggers or taken out, in the workflows that listed them", () => {
    const current: WorkflowMemory = {
      ...emptyMemory("local"),
      workflows: [{ id: "w", subject: "app", name: "W", use_when: "", only_if_asked: false, blanks: [], steps: [], checks: [], pitfalls: ["quotes", "anchor", "stale"], evidence: [], tasks: [] }],
      pitfalls: [pitfall("quotes", { trigger: null }), pitfall("anchor", { trigger: null }), pitfall("stale")]
    }
    const merged = pitfall("scripted-edit", { also: [{ on: "error", all: ["missing:"], none: [], file: null }] })
    const revision: WorkflowMemory = { ...current, workflows: [{ ...current.workflows[0], pitfalls: ["scripted-edit"] }], pitfalls: [merged] }
    const kept = withPitfallsOf(current, revision)!
    assert.deepStrictEqual(kept.pitfalls.map((p) => p.id), ["scripted-edit"])
    assert.deepStrictEqual(kept.workflows[0].pitfalls, ["scripted-edit"])
    assert.isUndefined(withPitfallsOf(current, current))
  })
})
