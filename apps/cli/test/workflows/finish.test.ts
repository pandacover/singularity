import { assert, describe, it } from "@effect/vitest"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunEvidence } from "../../src/workflows/Evidence.ts"
import { checkCommands, finishOf, hasFinish, isFinishing, namedPaths, type RepoFacts, repoFacts, withSnapshots } from "../../src/workflows/Finish.ts"
import { END, FORMAT, START, type Workflow, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { renderHandover, splitHandover } from "../../src/workflows/Render.ts"
import { handoverParts } from "../../src/workflows/HookStart.ts"
import { run as runEffect, tempDir } from "../eval/helpers.ts"

const workflow = (id: string, over: Partial<Workflow> = {}): Workflow => ({
  id,
  subject: "repo",
  name: `Do ${id}`,
  use_when: `a task needs ${id}`,
  only_if_asked: false,
  blanks: [],
  steps: [{ do: `Edit for ${id}.`, place: "p-1", when: null }],
  checks: [],
  pitfalls: [],
  evidence: ["r1", "r2"],
  tasks: ["t1"],
  ...over
})

const run = (record: string, snapshots: ReadonlyArray<string>): RunEvidence => ({
  record,
  subject: "repo",
  task: "t1",
  prompt: "",
  base: "abc",
  tokens: 1000,
  turns: 3,
  uses: [],
  snapshots,
  checks: [],
  detours: [],
  readFirst: [],
  values: [],
  calls: [],
  cwd: undefined,
  looking: null,
  reads: []
})

const field = workflow("add-field", {
  checks: ["yarn test:typecheck"],
  steps: [
    { do: "Add the field.", place: "p-1", when: null },
    { do: "Regenerate snapshots (see update-snapshots).", place: null, when: null }
  ]
})
const menu = workflow("add-menu-item", { checks: ["yarn  prettier --write src/menu.tsx", "yarn test:typecheck"], pitfalls: ["ambiguous-edit"] })
const snapshots = workflow("update-snapshots", {
  steps: [
    { do: "Run `yarn test:update`.", place: null, when: null },
    { do: "Review the changed snapshot files.", place: null, when: null }
  ],
  checks: ["yarn test:update", "yarn test:typecheck"],
  pitfalls: ["watch-flag"]
})

const memory = (workflows: ReadonlyArray<Workflow>): WorkflowMemory => ({
  format: FORMAT,
  tenant: "local",
  places: [],
  workflows,
  edges: [
    { from: START, to: "add-field", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null },
    { from: "add-field", to: "add-menu-item", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null },
    { from: "add-menu-item", to: "update-snapshots", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null },
    { from: "update-snapshots", to: END, relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null }
  ],
  pitfalls: [
    { id: "ambiguous-edit", subject: "repo", text: "Edits with short old text match twice.", trigger: null, evidence: ["r1"], cost_tokens: 0 },
    { id: "watch-flag", subject: "repo", text: "`yarn test:update` already passes --watch.", trigger: null, evidence: ["r1"], cost_tokens: 0 }
  ]
})

describe("the finish in one command", () => {
  it("learns the snapshot files every run a workflow was learned from regenerated, and needs two runs", () => {
    const runs = [run("r1", ["a.snap", "b.snap"]), run("r2", ["b.snap", "c.snap"]), run("r3", ["d.snap"])]
    const m = withSnapshots(memory([field, workflow("one-run", { evidence: ["r3"] }), workflow("unknown-runs", { evidence: ["x", "y"] })]), runs)
    assert.deepStrictEqual(m.workflows.map((w) => w.snapshots), [["b.snap"], [], []])
    assert.isTrue(hasFinish(m))
    assert.isFalse(hasFinish(memory([field])))
  })

  it("folds the checks into one line, formatters first and tests last, and lists what changed when snapshots are expected", () => {
    const m = memory([{ ...field, snapshots: ["b.snap"] }, menu, snapshots])
    const f = finishOf(m, m.workflows)!
    assert.strictEqual(f.command, "yarn prettier --write src/menu.tsx; yarn test:typecheck; yarn test:update; git status --short")
    assert.deepStrictEqual(f.snapshots, ["b.snap"])
    assert.deepStrictEqual(f.folded, ["update-snapshots"])
    // A workflow with a step at a place, or one that leads on, is no finish.
    assert.isFalse(isFinishing(m, field))
    assert.isTrue(isFinishing(m, snapshots))
    assert.strictEqual(finishOf(m, [menu])!.command, "yarn prettier --write src/menu.tsx; yarn test:typecheck")
    assert.isUndefined(finishOf(m, [workflow("no-checks")]))
  })

  it("hands over the finishing workflow as the one command at the end, with its pitfalls, and no checks under each workflow", () => {
    const m = memory([{ ...field, snapshots: ["b.snap"] }, { ...menu, snapshots: [] }, { ...snapshots, snapshots: [] }])
    const chosen = m.workflows.map((w) => ({ workflow: w, skip: [], why: "" }))
    const text = renderHandover(m, chosen, new Map()).text
    assert.include(text, "## 2. Do add-menu-item")
    assert.notInclude(text, "## 3.")
    assert.notInclude(text, "Run `yarn test:update`.")
    assert.notInclude(text, "Check with")
    assert.include(text, "Regenerate snapshots (see the last section).")
    assert.include(text, "## Last: check it all with one command")
    assert.include(text, "run once: `yarn prettier --write src/menu.tsx; yarn test:typecheck; yarn test:update; git status --short`")
    assert.include(text, "as expected for this kind of change: `b.snap`.")
    assert.include(text, "keep its last 60 lines")
    assert.include(text, "Watch out: `yarn test:update` already passes --watch.")
    assert.isBelow(text.indexOf("Edits with short old text"), text.indexOf("## Last"))
    // Memory that doesn't know what its checks rewrite is handed over as before.
    const before = renderHandover(memory([field, menu, snapshots]), [field, menu, snapshots].map((w) => ({ workflow: w, skip: [], why: "" })), new Map()).text
    assert.include(before, "## 3. Do update-snapshots")
    assert.include(before, "Check with `yarn test:update` or `yarn test:typecheck`.")
    assert.notInclude(before, "## Last")
  })
})

describe("the finish checked against the repo", () => {
  const facts = (scripts: Record<string, string> | undefined, more: Partial<RepoFacts> = {}): RepoFacts => ({ scripts, manager: "npm", paths: new Set(), ...more })

  it("leaves out scripts the repo doesn't have and checks another line already runs, in the order its scripts run them", () => {
    // validator: `npm test` runs lint and the build first.
    const validator = facts({ lint: "eslint src", build: "babel src -d .", pretest: "npm run lint && npm run build", test: "nyc mocha" })
    assert.deepStrictEqual(checkCommands(["npm run lint", "npm run build", "npm test", "npm run typecheck"], validator), ["npm test"])
    // markdownlint: its own script builds the config before the docs that read it.
    const markdownlint = facts({
      "build-config": "npm run build-config-schema && npm run build-config-example",
      "build-config-schema": "node schema/build-config-schema.mjs",
      "build-config-example": "node schema/build-config-example.mjs",
      "build-docs": "node doc-src/build-rules.mjs",
      "serial-config-docs": "npm run build-config && npm run build-docs",
      test: "node --test test/a.mjs",
      lint: "eslint --max-warnings 0"
    })
    assert.deepStrictEqual(
      checkCommands(["npm run lint", "npm run build-docs", "npm run build-config", "npm test", "npm run {docs_build}"], markdownlint),
      ["npm run lint", "npm run build-config", "npm run build-docs", "npm test"]
    )
    // A runner's own call where a script runs it on everything; the same script spelled twice.
    assert.deepStrictEqual(checkCommands(["npx vitest run test/a.test.ts", "npm test", "npm run test"], facts({ test: "vitest run" }, { paths: new Set(["test/a.test.ts"]) })), ["npm test"])
  })

  it("tells a test runner that waits for changes to run once, unless the script already does", () => {
    // excalidraw: `test:app` is `vitest`, which waits in a terminal; `test:update` passes it `--watch=false` itself.
    const excalidraw = facts({ "test:app": "vitest", "test:update": "yarn test:app --update --watch=false", "test:typecheck": "tsc" }, { manager: "yarn" })
    assert.deepStrictEqual(checkCommands(["yarn test:typecheck", "yarn test:app"], excalidraw), ["yarn test:typecheck", "yarn test:app --watch=false"])
    assert.deepStrictEqual(checkCommands(["yarn test:typecheck", "yarn test:update", "yarn test:app"], excalidraw), ["yarn test:typecheck", "yarn test:update"])
    assert.deepStrictEqual(checkCommands(["npm run test:app 2>&1 | tail -n 30"], facts({ "test:app": "vitest" })), ["npm run test:app 2>&1 -- --watch=false | tail -n 30"])
    assert.deepStrictEqual(checkCommands(["npx vitest src/a.test.ts", "npx vitest run"], facts({}, { paths: new Set(["src/a.test.ts"]) })), ["npx vitest src/a.test.ts --run", "npx vitest run"])
  })

  it("leaves out lines that need files, a package manager or a place the repo doesn't have", () => {
    const repo = facts({ test: "turbo run test", typecheck: "turbo run typecheck" }, { paths: new Set(["install.sh", "apps/cli", "apps/cli/tsconfig.json"]) })
    const lines = [
      "npm test",
      "sh -n install.sh",
      // Another repo's commands, learned from a session that ran them there.
      "yarn vitest run packages/excalidraw/tests/hidden-check.test.tsx",
      "yarn test:typecheck",
      // Only right in apps/cli: no tsconfig.json or test/setup at the top.
      "npx tsc --noEmit",
      "npx tsc --noEmit -p .",
      "npx vitest run test/setup",
      "npx tsc --noEmit -p apps/cli",
      "cd apps/cli && npm test",
      "npm test --workspace=@singularity/cli",
      "C:/tools/check.sh"
    ]
    assert.deepStrictEqual(checkCommands(lines, repo), ["npm test", "sh -n install.sh", "npx tsc --noEmit -p apps/cli"])
    assert.sameMembers(
      [...new Set(lines.flatMap(namedPaths))],
      ["install.sh", "packages/excalidraw/tests/hidden-check.test.tsx", "tsconfig.json", "test/setup", "apps/cli", "apps/cli/tsconfig.json", "C:/tools/check.sh"]
    )
    // npm runs scripts in a repo that uses yarn too.
    assert.deepStrictEqual(checkCommands(["npm test", "pnpm test"], facts({ test: "jest" }, { manager: "yarn" })), ["npm test"])
    // A repo without a package.json can't be checked yet: no command.
    assert.deepStrictEqual(checkCommands(["pytest", "npm test"], facts(undefined)), [])
  })

  it("hands over no command when none can run as learned, and still says what earlier runs saw", () => {
    const m = memory([{ ...field, snapshots: ["b.snap"] }, { ...menu, snapshots: [] }, { ...snapshots, snapshots: [] }])
    const chosen = m.workflows.map((w) => ({ workflow: w, skip: [], why: "" }))
    const text = renderHandover(m, chosen, new Map(), undefined, undefined, 1, undefined, facts(undefined)).text
    assert.notInclude(text, "run once")
    assert.include(text, "## Last: when your edits are in")
    assert.include(text, "In earlier runs of these workflows the checks rewrote these test snapshots, as expected for this kind of change: `b.snap`.")
    assert.include(text, "Watch out: `yarn test:update` already passes --watch.")
    const checked = renderHandover(m, chosen, new Map(), undefined, undefined, 1, undefined, facts({ "test:update": "vitest -u --watch=false", "test:typecheck": "tsc", prettier: "prettier" }, { manager: "yarn", paths: new Set(["src/menu.tsx"]) })).text
    assert.include(checked, "run once: `yarn prettier --write src/menu.tsx; yarn test:typecheck; yarn test:update; git status --short`")
    // Workflows whose only part was the command leave nothing to hand over.
    const onlyFinish = memory([{ ...snapshots, snapshots: [], pitfalls: [] }])
    const nothing = renderHandover(onlyFinish, [{ workflow: onlyFinish.workflows[0], skip: [], why: "" }], new Map(), undefined, undefined, 1, undefined, facts(undefined))
    assert.deepStrictEqual([nothing.text, nothing.parts], ["", []])
  })

  it("reads the repo's scripts, lockfile and paths", async () => {
    const root = tempDir()
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
    writeFileSync(join(root, "package-lock.json"), "{}")
    writeFileSync(join(root, "install.sh"), "")
    const read = await runEffect(repoFacts({ kind: "tree", root }, ["sh -n install.sh", "node scripts/gone.mjs", "npx tsc --noEmit"]))
    assert.deepStrictEqual([read.scripts, read.manager, [...read.paths]], [{ test: "vitest run" }, "npm", ["install.sh"]])
    const none = await runEffect(repoFacts({ kind: "tree", root: tempDir() }, ["npm test"]))
    assert.deepStrictEqual([none.scripts, none.manager], [undefined, undefined])
  })
})

describe("a hand-over in two parts", () => {
  it("cuts at workflows, keeps each part within the budget, and marks the second as continued", () => {
    const section = (n: number) => `## ${n}. Workflow ${n}\n${"x".repeat(300)}\n`
    const text = ["# Header\n", section(1), section(2), section(3)].join("\n")
    assert.deepStrictEqual(splitHandover(text, 2000), [text])
    const parts = splitHandover(text, 400)
    assert.strictEqual(parts.length, 3)
    assert.isTrue(parts.every((p) => p.length <= 400))
    assert.isTrue(parts[0].startsWith("# Header"))
    assert.isTrue(parts[1].startsWith("# Workflows from earlier work in this repository (continued)\n\n## 2."))
  })

  it("takes two parts only when asked, and only without a model call, so both hooks compute the same", () => {
    assert.strictEqual(handoverParts("2", "cues"), 2)
    assert.strictEqual(handoverParts("2", "words"), 2)
    assert.strictEqual(handoverParts("2", "model"), 1)
    assert.strictEqual(handoverParts(undefined, "cues"), 1)
    const m = memory([{ ...field, snapshots: [] }, { ...menu, snapshots: [] }, { ...snapshots, snapshots: [] }])
    const chosen = m.workflows.map((w) => ({ workflow: w, skip: [], why: "" }))
    // Room for about two thirds of it in one part: one part cuts it short, two carry all of it.
    const budget = Math.ceil(renderHandover(m, chosen, new Map(), 100_000).text.length * 0.65)
    const one = renderHandover(m, chosen, new Map(), budget)
    const two = renderHandover(m, chosen, new Map(), budget, undefined, 2)
    assert.strictEqual(one.parts.length, 1)
    assert.isAtMost(one.text.length, budget)
    assert.notInclude(one.text, "## Last: check it all with one command")
    assert.strictEqual(two.parts.length, 2)
    assert.isTrue(two.parts.every((p) => p.length <= budget))
    assert.include(two.parts[1], "## Last: check it all with one command")
  })
})
