import { describe, expect, it } from "@effect/vitest"
import type { Detour } from "../../src/records/Models.ts"
import { mistakesNearby, mistakesToShow, renderSavedRun, tellingFiles } from "../../src/eval/SavedRunText.ts"

const RULE = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."

describe("a saved run as the scripts setup hands it over", () => {
  it("names a failed command with what worked instead", () => {
    const call = (command: string) => ({ call: 0, turn: 0, tool: "Bash", command, file: null })
    const d: Detour = {
      kind: "command_error",
      failed: call("yarn test:update --watch=false"),
      symptom: "Expected a single value for option --watch",
      keys: [],
      fixed: call("yarn test:update"),
      removed: [],
      added: [],
      files_edited: [],
      failures: 1,
      cost: { tokens: 0, calls: 1, turns: 1 }
    }
    expect(mistakesToShow([d])).toEqual(["- `yarn test:update --watch=false` failed: Expected a single value for option --watch. What worked instead: `yarn test:update`"])
  })

  it("says other runs' mistakes only through a file few saved runs touch", () => {
    const stored = [
      { files: ["README.md", "test/rules.test.mjs", "lib/md061.mjs"], mistakes: ["- mine"] },
      { files: ["README.md", "test/rules.test.mjs", "lib/md062.mjs"], mistakes: ["- `npm run build-declaration` failed"] },
      { files: ["test/rules.test.mjs", "lib/md061.mjs"], mistakes: ["- `npm test` failed: MD061 expected 2 errors"] }
    ]
    const links = tellingFiles(stored, 2)
    expect(["README.md", "test/rules.test.mjs", "lib/md061.mjs", "lib/md062.mjs"].map(links)).toEqual([false, false, true, true])
    const [first, ...others] = stored
    expect(mistakesNearby(first.files.filter(links), others, first.mistakes)).toEqual(["- `npm test` failed: MD061 expected 2 errors"])
    // A file only one run touched tells something, but can't link two.
    expect(tellingFiles(stored)("lib/md061.mjs")).toBe(false)
    expect(tellingFiles(stored)("lib/md062.mjs")).toBe(true)
  })

  it("shows source first and whole, then tests, and leaves out what got no room", () => {
    const chunk = (path: string, n: number) => ({ path, text: `diff --git a/${path} b/${path}\n${`+line ${path}\n`.repeat(n)}` })
    const file = (path: string) => ({ path, added: 1, removed: 0, snapshot: false })
    const text = renderSavedRun({
      prompt: RULE,
      files: [file("doc/md061.md"), file("test/md061.test.mjs"), file("lib/md061.mjs"), file("lib/rules.mjs")],
      commands: ["npm test"],
      mistakes: [],
      nearby: [],
      diff: [chunk("doc/md061.md", 300), chunk("test/md061.test.mjs", 300), chunk("lib/md061.mjs", 40), chunk("lib/rules.mjs", 30)]
    }, 3000)
    expect(text.length).toBeLessThanOrEqual(3000)
    expect(text).toContain(`## Its task\n\n${RULE}`)
    expect(text).toContain("## Project commands it ran, in order\n\n`npm test`")
    const at = (p: string) => text.indexOf(`diff --git a/${p}`)
    expect(at("lib/md061.mjs")).toBeGreaterThan(0)
    expect(at("lib/rules.mjs")).toBeGreaterThan(at("lib/md061.mjs"))
    // Source whole, the test cut to what's left, the docs only named.
    expect(text).toContain(`+line lib/md061.mjs\n`.repeat(40))
    expect(at("test/md061.test.mjs")).toBeGreaterThan(at("lib/rules.mjs"))
    expect(text).toMatch(/… \(\d+ more lines\)/)
    expect(at("doc/md061.md")).toBe(-1)
    expect(text).toContain("- doc/md061.md (+1 -0)")
  })
})
