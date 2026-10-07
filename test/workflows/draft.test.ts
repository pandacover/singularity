import { assert, describe, it } from "@effect/vitest"
import { checkDraft, type DraftAnswer, draftPrompt, hunk, renderDraft } from "../../src/workflows/Draft.ts"
import type { Located } from "../../src/workflows/Locate.ts"
import { emptyMemory, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { placeOfAddition, type Region } from "../../src/workflows/Places.ts"
import type { Selected } from "../../src/workflows/Select.ts"

const KEYS = [
  "export const CODES = {",
  '  A: "KeyA",',
  '  B: "KeyB",',
  '  C: "KeyC",',
  "} as const;",
  "",
  "export const KEYS = {",
  '  B: "KeyB",',
  "} as const;"
]
const CODES_REGION: Region = { from: 0, to: 4, openLine: 0, closeLine: 4, members: [] }

const answer = (over: Partial<DraftAnswer>): DraftAnswer => ({ edits: [], files: [], after: [], unsure: [], ...over })
const code = { files: new Map([["keys.ts", KEYS]]), regions: new Map([["keys.ts", [CODES_REGION]]]), exists: (p: string) => p === "src" || p === "src/old.ts" }

const memory: WorkflowMemory = {
  ...emptyMemory("local"),
  places: [
    { id: "p-codes", subject: "repo", ...placeOfAddition("keys.ts", KEYS, 3, 2), new_file: null, evidence: [], tasks: [], edits: { add: 2, change: 0, create: 0 } },
    {
      id: "p-new",
      subject: "repo",
      file: "actions",
      chain: [],
      group: null,
      new_file: { dir: "actions", prefix: "actionToggle", ext: ".tsx" },
      evidence: [],
      tasks: [],
      edits: { add: 0, change: 0, create: 2 }
    }
  ],
  workflows: [{
    id: "add-key",
    subject: "repo",
    name: "Add a key",
    use_when: "a task adds a key",
    only_if_asked: false,
    blanks: [{ name: "letter", meaning: "the key's letter" }],
    steps: [
      { do: "Create the action, modelled on the grid-mode toggle.", place: "p-new", when: null },
      { do: "Add `{letter}: \"Key{letter}\"` to CODES.", place: "p-codes", when: null },
      { do: "Add a test.", place: null, when: "only if asked" }
    ],
    checks: ["yarn test"],
    pitfalls: ["flag"],
    evidence: [],
    tasks: []
  }],
  pitfalls: [{ id: "flag", subject: "repo", text: "Don't double the flag.", trigger: null, evidence: [], cost_tokens: 0 }]
}
const chosen: Array<Selected> = [{ workflow: memory.workflows[0], skip: [3], why: "" }]

describe("drafting the change at task start", () => {
  it("keeps edits whose old lines are in the file once, widens one that is once in a place shown, and leaves out the rest", () => {
    const d = checkDraft(answer({
      edits: [
        { file: "keys.ts", old: '  C: "KeyC",', new: '  C: "KeyC",\n  M: "KeyM",' },
        // Twice in the file, once in the place shown: widened upward until unique.
        { file: "keys.ts", old: '  B: "KeyB",\n', new: '  B: "KeyB",\n  N: "KeyN",\n' },
        // Copied with its line numbers.
        { file: "keys.ts", old: "7| export const KEYS = {", new: "7| export const KEYS = {\n8|   Q: \"KeyQ\"," },
        { file: "keys.ts", old: '  Z: "KeyZ",', new: '  Z: "KeyZ",\n  Y: "KeyY",' },
        { file: "keys.ts", old: '  C: "KeyC",\n} as const;', new: '  C: "KeyC",\n  D: "KeyD",\n} as const;' },
        { file: "keys.ts", old: '  A: "KeyA",', new: '  A: "KeyA",' },
        { file: "other.ts", old: "x", new: "y" }
      ]
    }), code)
    assert.deepStrictEqual(d.edits.map((e) => [e.line, e.old, e.new]), [
      [2, ['  A: "KeyA",', '  B: "KeyB",'], ['  A: "KeyA",', '  B: "KeyB",', '  N: "KeyN",']],
      [4, ['  C: "KeyC",'], ['  C: "KeyC",', '  M: "KeyM",']],
      [7, ["export const KEYS = {"], ["export const KEYS = {", '  Q: "KeyQ",']]
    ])
    assert.strictEqual(d.dropped.length, 4)
    assert.match(d.dropped.join("\n"), /aren't in the file/)
    assert.match(d.dropped.join("\n"), /overlaps another/)
    assert.match(d.dropped.join("\n"), /changes nothing/)
    assert.match(d.dropped.join("\n"), /other\.ts, which wasn't shown/)
  })

  it("takes the file's own lines when only trailing spaces differ, and keeps new files only where they are new", () => {
    const d = checkDraft(answer({
      edits: [{ file: "keys.ts", old: '  A: "KeyA",   ', new: '  A: "KeyA",\n  M: "KeyM",' }],
      files: [
        { path: "./src/new.ts", content: "export {}\r\n\n\n" },
        { path: "src/old.ts", content: "x" },
        { path: "nowhere/new.ts", content: "x" },
        { path: "../escape.ts", content: "x" }
      ],
      after: ["Run `yarn test`.", " "],
      unsure: []
    }), code)
    assert.deepStrictEqual(d.edits.map((e) => e.old), [['  A: "KeyA",']])
    assert.deepStrictEqual(d.files, [{ path: "src/new.ts", content: "export {}\n" }])
    assert.strictEqual(d.dropped.length, 3)
    assert.deepStrictEqual(d.after, ["Run `yarn test`."])
  })

  it("shows an edit as a diff hunk, and hands over the change with what follows it, within the budget", () => {
    assert.deepStrictEqual(hunk({ file: "f", line: 1, old: ["a"], new: ["a", "b"] }), [" a", "+b"])
    assert.deepStrictEqual(hunk({ file: "f", line: 1, old: ["a", "x", "c"], new: ["a", "y", "c"] }), [" a", "-x", "+y", " c"])
    const d = checkDraft(answer({
      edits: [{ file: "keys.ts", old: '  C: "KeyC",', new: '  C: "KeyC",\n  M: "KeyM",' }],
      files: [{ path: "src/new.ts", content: "export const x = 1\n" }],
      after: ["Run `yarn test:update`."],
      unsure: ["The label's text."]
    }), code)
    const text = renderDraft(memory, chosen, d, 9800)!
    assert.include(text, "from the workflows memory picked for it (Add a key)")
    assert.include(text, '`keys.ts`, line 4:\n```diff\n   C: "KeyC",\n+  M: "KeyM",\n```')
    assert.include(text, "New file `src/new.ts`:\n```ts\nexport const x = 1\n```")
    assert.include(text, "1. Run `yarn test:update`.")
    assert.include(text, "Check with `yarn test`.")
    assert.include(text, "Watch out: Don't double the flag.")
    assert.include(text, "Not settled by the draft: The label's text.")
    assert.isUndefined(renderDraft(memory, chosen, d, 200))
  })

  it("asks with the task, the steps that apply with their places, and the code there with line numbers", () => {
    const located = new Map<string, Located>([
      ["p-codes", { kind: "block", file: "keys.ts", lines: KEYS, region: CODES_REGION, moved: false }],
      ["p-new", {
        kind: "new-file",
        dir: "actions",
        prefix: "actionToggle",
        siblings: [
          { name: "actionToggleAbc.tsx", lines: ["// abc", ""] },
          { name: "actionToggleGridMode.tsx", lines: ["// grid mode, the longest", "//", "//"] },
          { name: "actionToggleShort.tsx", lines: ["// short"] },
          { name: "actionToggleZed.tsx", lines: ["// zed", "//"] }
        ]
      }]
    ])
    const prompt = draftPrompt("Add the M key.", memory, chosen, located)
    assert.include(prompt, "## Task\n\nAdd the M key.")
    assert.include(prompt, "1. Create the action, modelled on the grid-mode toggle. [place 1]")
    assert.include(prompt, '2. Add `{letter}: "Key{letter}"` to CODES. [place 2]')
    assert.notInclude(prompt, "Add a test.")
    assert.include(prompt, "Pitfall: Don't double the flag.")
    assert.include(prompt, "### Place 2: `keys.ts`, lines 1-5, in export const CODES = {\n```\n1| export const CODES = {\n2|   A: \"KeyA\",")
    // The sibling the steps name comes first, then the shortest.
    const shown = [...prompt.matchAll(/^`actions\/(\w+)\.tsx`:$/gm)].map((m) => m[1])
    assert.deepStrictEqual(shown, ["actionToggleGridMode", "actionToggleShort", "actionToggleAbc"])
  })
})
