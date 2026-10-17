import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord, commitRecordId } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import {
  addedLinesOf,
  isMeaningful,
  jaccard,
  judgeFile,
  keepCommands,
  linesOf,
  movedTarget,
  revertsOf,
  sameChange,
  scriptsOf,
  survivalOf
} from "../../src/scripts/Fresh.ts"
import { fileKind, renderScript } from "../../src/scripts/Render.ts"
import { countRetired, readRetired } from "../../src/scripts/Retired.ts"
import { startScripts } from "../../src/scripts/Start.ts"
import { git, run, tempDir } from "../eval/helpers.ts"
import { bash, session } from "../records/fixtures.ts"

const RULE = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const OTHER_RULE = "Add a new built-in rule MD062, alias `code-block-max-lines`, with parameters `maximum` and `ignore_languages`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const RULE_AGAIN = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`, the way the existing rules are done: documentation, README, config schema, tests and snapshots."

describe("what counts as still there", () => {
  it("judges by meaningful added lines, whitespace aside", () => {
    expect(isMeaningful("});")).toBe(false)
    expect(isMeaningful("  return x")).toBe(false)
    expect(isMeaningful(`import fs from "node:fs"`)).toBe(false)
    expect(isMeaningful(`import { join } from "node:path";`)).toBe(false)
    expect(isMeaningful(`const x = require("y")`)).toBe(false)
    expect(isMeaningful("from os import path")).toBe(false)
    expect(isMeaningful("-----------------")).toBe(false)
    expect(isMeaningful(`import { a, b } from "c"`)).toBe(true)
    expect(isMeaningful("const limit = options.maximum ?? 6")).toBe(true)
    const added = addedLinesOf("diff --git a/x b/x\n+++ b/x\n+const   limit = options.maximum ?? 6\n+}\n+const limit = options.maximum ?? 6\n-const old = 1234567\n+if (level > limit) report(level)\n")
    expect(added.map((l) => l.norm)).toEqual(["const limit = options.maximum ?? 6", "if (level > limit) report(level)"])
    expect(survivalOf(added, linesOf("  const limit = options.maximum ?? 6\n"))).toBe(0.5)
    expect(survivalOf([], linesOf("x"))).toBeUndefined()
  })

  it("finds where code went: one other file holding most of the lines", () => {
    const samples = ["a1234567", "b1234567", "c1234567"]
    expect(movedTarget(samples, [{ path: "new.ts", match: "a1234567" }, { path: "new.ts", match: "b1234567" }, { path: "x.ts", match: "c1234567" }], "old.ts")).toBe("new.ts")
    // Its own file doesn't count, nor too small a share, nor a tie.
    expect(movedTarget(samples, [{ path: "old.ts", match: "a1234567" }, { path: "old.ts", match: "b1234567" }], "old.ts")).toBeUndefined()
    expect(movedTarget(samples, [{ path: "new.ts", match: "a1234567" }], "old.ts")).toBeUndefined()
    expect(movedTarget(["a1234567", "b1234567"], [{ path: "p.ts", match: "a1234567" }, { path: "q.ts", match: "a1234567" }, { path: "p.ts", match: "b1234567" }, { path: "q.ts", match: "b1234567" }], null)).toBeUndefined()
    // One line found says little; a line found in many files says nothing.
    expect(movedTarget(["a1234567"], [{ path: "p.ts", match: "a1234567" }], null)).toBeUndefined()
    const common = ["p.ts", "q.ts", "r.ts", "s.ts"].map((path) => ({ path, match: "a1234567" }))
    expect(movedTarget(["a1234567", "b1234567"], [...common, { path: "p.ts", match: "b1234567" }], null)).toBeUndefined()
  })

  it("reads reverts, alike changes and dropped package scripts", () => {
    expect(revertsOf(`Revert "Add MD061"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.\n`)).toEqual(["0123456789abcdef0123456789abcdef01234567"])
    expect(revertsOf("This reverts commit abc12ef, and more")).toEqual(["abc12ef"])
    expect(revertsOf("Reverts a thing")).toEqual([])
    expect(jaccard(["a", "b", "c", "d", "e"], ["a", "b", "c", "d"])).toBe(0.8)
    expect(sameChange({ files: ["lib/md061.mjs", "README.md"], prompt: RULE_AGAIN }, { files: ["lib/md061.mjs", "README.md"], prompt: RULE })).toBe(true)
    expect(sameChange({ files: ["lib/md062.mjs", "README.md"], prompt: OTHER_RULE }, { files: ["lib/md061.mjs", "README.md"], prompt: RULE })).toBe(false)
    // Two changes of the same files, filed under the same "commit and then start", are two changes: their messages say what each did.
    const notes = (message: string) => ({ files: ["HANDOFF.md"], prompt: "commit and then start", message })
    expect(sameChange(notes("Add handoff notes for the next session"), notes("Update handoff status now that everything is committed"))).toBe(false)
    expect(sameChange(notes("Record the redesign and its build order in the handoff notes"), notes("Record the redesign and its build order in the handoff notes"))).toBe(true)
    expect(scriptsOf(`{"scripts":{"test":"vitest","build-docs":"x"}}`)).toEqual(["test", "build-docs"])
    expect(scriptsOf("not json")).toEqual([])
    const before = new Set(["test", "build-docs"])
    const after = new Set(["test", "docs"])
    expect(keepCommands(["npm test", "npm build-docs", "yarn build-docs", "npm ci", "yarn tsc", "npx vitest"], before, after))
      .toEqual(["npm test", "npm ci", "yarn tsc", "npx vitest"])
  })

  it("sorts files into source, tests and the rest", () => {
    expect(["lib/md061.mjs", "src/a.ts", "packages/x/src/b.tsx"].map(fileKind)).toEqual(["source", "source", "source"])
    expect(["test/md061.test.mjs", "src/a.test.ts", "src/__tests__/a.ts", "tests/test_a.py", "pkg/a_test.go", "spec/a.rb"].map(fileKind))
      .toEqual(["test", "test", "test", "test", "test", "test"])
    expect(["doc/md061.md", "README.md", "examples/a.js", "test/fixtures/a.js", "schema/config.json", ".github/workflows/ci.yml", "test/__snapshots__/a.snap"].map(fileKind))
      .toEqual(["rest", "rest", "rest", "rest", "rest", "rest", "rest"])
  })
})

describe("cutting the change to fit", () => {
  const chunk = (path: string, n: number) => ({ path, text: `diff --git a/${path} b/${path}\n${`+line ${path}\n`.repeat(n)}` })
  const file = (path: string, fate?: Parameters<typeof renderScript>[0]["files"][number]["fate"]) =>
    ({ path, status: "modified" as const, added: 1, removed: 0, snapshot: false, now: path, fate })

  it("shows source first and whole, then tests, and names what got no room", () => {
    const text = renderScript({
      prompt: RULE,
      commit: "0123456789abcdef",
      score: 0.6,
      files: [file("doc/md061.md"), file("test/md061.test.mjs"), file("lib/md061.mjs"), file("lib/rules.mjs")],
      commands: [],
      mistakes: [],
      nearby: [],
      diff: [chunk("doc/md061.md", 300), chunk("test/md061.test.mjs", 300), chunk("lib/md061.mjs", 40), chunk("lib/rules.mjs", 30)]
    }, 3000)
    expect(text.length).toBeLessThanOrEqual(3000)
    const at = (p: string) => text.indexOf(`diff --git a/${p}`)
    expect(at("lib/md061.mjs")).toBeGreaterThan(0)
    expect(at("lib/rules.mjs")).toBeGreaterThan(at("lib/md061.mjs"))
    // Source whole, the test cut to what's left, the docs only named.
    expect(text).toContain(`+line lib/md061.mjs\n`.repeat(40))
    expect(at("test/md061.test.mjs")).toBeGreaterThan(at("lib/rules.mjs"))
    expect(text).toMatch(/… \(\d+ more lines\)/)
    expect(at("doc/md061.md")).toBe(-1)
    expect(text).toContain("Not shown for room: doc/md061.md (`git show 0123456789 -- <file>`)")
  })

  it("leaves out a file rewritten since and says so, and names where moved code is", () => {
    const text = renderScript({
      prompt: RULE,
      commit: "0123456789abcdef",
      score: 0.6,
      files: [
        file("lib/md061.mjs", { kind: "stale", last: { hash: "abc1234", title: "Rewrite the rule engine" } }),
        file("lib/old.mjs", { kind: "moved", to: "lib/new.mjs" }),
        { ...file("lib/gone.mjs"), now: null }
      ],
      commands: [],
      mistakes: [],
      nearby: [],
      diff: [chunk("lib/md061.mjs", 5), chunk("lib/old.mjs", 5), chunk("lib/gone.mjs", 5)]
    })
    expect(text).toContain("- lib/gone.mjs (+1 -0; no longer exists)")
    expect(text).not.toContain("diff --git a/lib/gone.mjs")
    expect(text).toContain(`- lib/md061.mjs (+1 -0; it has changed since, last in abc1234 "Rewrite the rule engine": its change isn't shown, read the file as it is now)`)
    expect(text).toContain("- lib/old.mjs (+1 -0; its code is in lib/new.mjs now)")
    expect(text).not.toContain("diff --git a/lib/md061.mjs")
    expect(text).toContain("diff --git a/lib/old.mjs")
    expect(text).not.toMatch(/may be outdated/i)
  })
})

// --- task start, in temp repos ---

const write = (repo: string, file: string, text: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), text)
}
const commit = (repo: string, message: string) => {
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", message)
  return git(repo, "rev-parse", "HEAD")
}

const RULE_CODE = [
  "export const md061 = (params, onError) => {",
  "  const maximum = params.config.maximum ?? 6",
  "  for (const heading of params.parsers.micromark.headings) {",
  "    if (heading.level > maximum) onError({ lineNumber: heading.line })",
  "  }",
  "}",
  ""
].join("\n")

const newRepo = () => {
  const root = tempDir()
  const repo = join(root, "repo")
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q")
  write(repo, "package.json", JSON.stringify({ scripts: { test: "vitest", "build-docs": "node doc.mjs" } }) + "\n")
  write(repo, "lib/rules.mjs", "export const rules = []\n")
  commit(repo, "start")
  return { root, repo, tenantDir: join(root, "home", "tenants", "local") }
}

/** Store the change base..head as a record with `prompt`, made with `commands`. */
const storeChange = (repo: string, prompt: string, base: string, head: string, options: { commands?: ReadonlyArray<string>; createdAt?: string } = {}) =>
  Effect.gen(function*() {
    const store = yield* RecordStore
    const subject = yield* store.subjectFor((yield* identifyRepo(repo))!, { create: true })
    const record = buildRecord({
      id: commitRecordId(subject!.id, head),
      tenant: "local",
      subject: subject!.id,
      trace: session(prompt, [(options.commands ?? ["npm test"]).map((c) => bash(c, "ok"))], repo),
      diff: git(repo, "diff", base, head),
      outcome: "success",
      checks: [],
      memory: null,
      run: {
        source: "session", log: "s.jsonl", run_dir: null, run_id: null, setup: null, task_id: null,
        repo, base_commit: base, head_commit: head, started_at: null, cost_usd: null, tokens: null
      },
      createdAt: options.createdAt ?? "2026-10-14T12:00:00Z"
    })
    yield* store.put(record)
    return record.id
  })

describe("task start, with what changed since", () => {
  it("leaves out a file rewritten since, naming the commit, and shows the rest; drops a script that's gone", async () => {
    const { repo, tenantDir } = newRepo()
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", RULE_CODE)
    write(repo, "lib/rules.mjs", "import { md061 } from \"./md061.mjs\"\nexport const rules = [md061, { name: \"heading-max-level\" }]\n")
    const head = commit(repo, "MD061")
    write(repo, "lib/md061.mjs", "export const md061 = (context) => context.report(\"entirely new engine here\")\n")
    write(repo, "package.json", JSON.stringify({ scripts: { test: "vitest", docs: "node doc.mjs" } }) + "\n")
    const later = commit(repo, "Rewrite the rule engine")
    await run(Effect.gen(function*() {
      yield* storeChange(repo, RULE, base, head, { commands: ["npm test", "npm run build-docs", "npm ci"] })
      const got = yield* startScripts({ sessionId: "s", prompt: OTHER_RULE, cwd: repo }, { tenantDir })
      expect(got.picked?.commit).toBe(head)
      expect(got.text).toContain(`- lib/md061.mjs (+6 -0; it has changed since, last in ${later.slice(0, 7)} "Rewrite the rule engine": its change isn't shown, read the file as it is now)`)
      expect(got.text).not.toContain("diff --git a/lib/md061.mjs")
      expect(got.text).toContain("diff --git a/lib/rules.mjs")
      expect(got.text).toContain("`npm test`, `npm ci`")
      expect(got.text).not.toContain("build-docs")
    }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
  }, 30_000)

  it("names the file moved code is in now", async () => {
    const { repo, tenantDir } = newRepo()
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", RULE_CODE)
    const head = commit(repo, "MD061")
    // Split up: the rule's code goes into another file, its own file keeps a line.
    write(repo, "lib/headings.mjs", "// headings\n" + RULE_CODE)
    write(repo, "lib/md061.mjs", "export { md061 } from \"./headings.mjs\"\n")
    commit(repo, "Move headings rules together")
    await run(Effect.gen(function*() {
      yield* storeChange(repo, RULE, base, head)
      const got = yield* startScripts({ sessionId: "s", prompt: OTHER_RULE, cwd: repo }, { tenantDir })
      expect(got.text).toContain("- lib/md061.mjs (+6 -0; its code is in lib/headings.mjs now)")
      expect(got.text).toContain("diff --git a/lib/md061.mjs")
      // The working tree is today: code moved back without a commit is fresh again.
      write(repo, "lib/md061.mjs", RULE_CODE)
      const again = yield* startScripts({ sessionId: "s2", prompt: OTHER_RULE, cwd: repo }, { tenantDir })
      expect(again.text).toContain("- lib/md061.mjs (+6 -0)\n")
      const v = yield* judgeFile({ root: repo, rev: "HEAD" }, head, { now: "lib/md061.mjs", chunk: git(repo, "diff", base, head) })
      expect(v.kind).toBe("moved")
    }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
  }, 30_000)

  it("passes over a change whose every file is gone, for the next one, and retires it only when it may write", async () => {
    const { repo, tenantDir } = newRepo()
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", RULE_CODE)
    const head = commit(repo, "MD061")
    write(repo, "lib/md062.mjs", RULE_CODE.replace(/md061/g, "md062").replace("heading.level", "block.lines"))
    const second = commit(repo, "MD062")
    rmSync(join(repo, "lib/md061.mjs"))
    commit(repo, "Drop MD061")
    await run(Effect.gen(function*() {
      const gone = yield* storeChange(repo, RULE, base, head)
      yield* storeChange(repo, OTHER_RULE, head, second)
      const prompt = "Add a new built-in rule MD063, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
      const recall = yield* startScripts({ sessionId: "s", prompt, cwd: repo }, { tenantDir, persist: false })
      expect(recall.picked?.commit).toBe(second)
      expect(recall.passed).toEqual([{ id: gone, reason: "gone" }])
      expect((yield* readRetired(tenantDir)).size).toBe(0)
      const got = yield* startScripts({ sessionId: "s2", prompt, cwd: repo }, { tenantDir })
      expect(got.picked?.commit).toBe(second)
      expect([...(yield* readRetired(tenantDir)).values()].map((r) => [r.id, r.reason])).toEqual([[gone, "gone"]])
      expect(Object.fromEntries(yield* countRetired(tenantDir))).toEqual({ gone: 1 })
      // Retired, it isn't examined again.
      expect((yield* startScripts({ sessionId: "s3", prompt, cwd: repo }, { tenantDir })).passed).toEqual([])
    }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
  }, 30_000)

  it("retires a reverted change and an older one a newer change of the same files supersedes; a missing commit only waits", async () => {
    const { repo, tenantDir } = newRepo()
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", RULE_CODE)
    const reverted = commit(repo, "MD061")
    git(repo, "revert", "--no-edit", reverted)
    const base2 = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", RULE_CODE.replace("?? 6", "?? 5"))
    const older = commit(repo, "MD061 again")
    write(repo, "lib/md061.mjs", RULE_CODE.replace("?? 6", "?? 4"))
    const newer = commit(repo, "MD061 once more")
    await run(Effect.gen(function*() {
      const a = yield* storeChange(repo, RULE, base, reverted, { createdAt: "2026-10-14T12:00:00Z" })
      const b = yield* storeChange(repo, RULE, base2, older, { createdAt: "2026-10-14T13:00:00Z" })
      const c = yield* storeChange(repo, RULE_AGAIN, older, newer, { createdAt: "2026-10-14T14:00:00Z" })
      // A change from another clone: its commit isn't here.
      const store = yield* RecordStore
      const elsewhere = { ...(yield* store.get(c)), id: "elsewhere", run: { ...(yield* store.get(c)).run, head_commit: "f".repeat(40) } }
      yield* store.put(elsewhere)
      const got = yield* startScripts({ sessionId: "s", prompt: RULE, cwd: repo }, { tenantDir })
      expect(got.picked?.commit).toBe(newer)
      const retired = yield* readRetired(tenantDir)
      expect(retired.get(a)?.reason).toMatch(/^reverted by [0-9a-f]{12}$/)
      expect(retired.get(b)?.reason).toBe(`superseded by ${c}`)
      expect(retired.has("elsewhere")).toBe(false)
      expect(got.passed.map((p) => p.reason)).toContain("its commit isn't in this repo")
    }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
  }, 30_000)

  it("hands a second clone of the repo the same script", async () => {
    const { root, repo, tenantDir } = newRepo()
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", RULE_CODE)
    const head = commit(repo, "MD061")
    const clone = join(root, "clone")
    git(root, "clone", "-q", repo, clone)
    await run(Effect.gen(function*() {
      yield* storeChange(repo, RULE, base, head)
      const here = yield* startScripts({ sessionId: "s", prompt: OTHER_RULE, cwd: repo }, { tenantDir, persist: false })
      const there = yield* startScripts({ sessionId: "s", prompt: OTHER_RULE, cwd: clone }, { tenantDir, persist: false })
      expect(there.picked).toEqual(here.picked)
      expect(there.text).toBe(here.text)
    }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
    // A clone moved elsewhere, the original gone: still the same subject.
    renameSync(repo, join(root, "moved-away"))
    expect(existsSync(clone)).toBe(true)
    await run(Effect.gen(function*() {
      const there = yield* startScripts({ sessionId: "s", prompt: OTHER_RULE, cwd: clone }, { tenantDir, persist: false })
      expect(there.picked?.commit).toBe(head)
    }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
    expect(readFileSync(join(clone, "lib/md061.mjs"), "utf-8")).toBe(RULE_CODE)
  }, 30_000)
})
