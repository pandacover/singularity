import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import type { CommandRun, Detour } from "../../src/records/Models.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { commandsToShow, mistakesToShow, renderScript } from "../../src/scripts/Render.ts"
import { MIN_SCORE, pick, rank, score } from "../../src/scripts/Search.ts"
import { startScripts } from "../../src/scripts/Start.ts"
import { bash, session } from "../records/fixtures.ts"
import { git, run, tempDir } from "../eval/helpers.ts"

const RULE = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const OTHER_RULE = "Add a new built-in rule MD062, alias `code-block-max-lines`, with parameters `maximum` and `ignore_languages`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const RENAME = "Rename the `doc-build` folder to `doc-src` and update everything that refers to it. `npm test` must pass."

describe("search", () => {
  it("picks a task of the same kind, and nothing for a task of another", () => {
    const docs = [{ id: "rule", prompt: RULE }]
    expect(pick(OTHER_RULE, docs)?.doc.id).toBe("rule")
    expect(pick(RENAME, docs)).toBeUndefined()
    expect(score(RULE, RULE)).toBeCloseTo(1)
    expect(score(OTHER_RULE, RULE)).toBeGreaterThanOrEqual(MIN_SCORE)
  })

  it("ranks best first and hands nothing over from an empty store", () => {
    expect(pick(RULE, [])).toBeUndefined()
    const ranked = rank(OTHER_RULE, [{ id: "rename", prompt: RENAME }, { id: "rule", prompt: RULE }])
    expect(ranked.map((r) => r.doc.id)).toEqual(["rule", "rename"])
  })
})

const cmd = (command: string, ok = true): CommandRun => ({ command, keys: [command.replace(/ run /, " ")], ok, error: null, turn: 0 })

describe("render", () => {
  it("keeps the project commands that worked, in the order first run", () => {
    expect(commandsToShow([cmd("cat a.ts"), cmd("npm test"), cmd("npm run lint", false), cmd("git commit -m x"), cmd("npm run build"), cmd("npm test")]))
      .toEqual(["npm test", "npm build"])
    expect(commandsToShow([
      { command: "cat x | grep y; npm run build-docs", ok: true, keys: ["cat", "grep", "npm build-docs"] },
      { command: "npm test && npm run lint", ok: false, keys: ["npm test", "npm lint"] },
      { command: "sed -i s/a/b/ x && npm test", ok: true, keys: ["sed", "npm test"] }
    ])).toEqual(["npm build-docs", "npm test"])
  })

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

  it("gives every file of the change a share of the room", () => {
    const chunk = (path: string, n: number) => ({ path, text: `diff --git a/${path} b/${path}\n${"+x\n".repeat(n)}` })
    const text = renderScript({
      prompt: RULE,
      commit: "0123456789abcdef",
      score: 0.6,
      files: [
        { path: "lib/md061.mjs", status: "added", added: 10, removed: 0, snapshot: false, now: "lib/md061.mjs" },
        { path: "doc-build/md061.md", status: "added", added: 5, removed: 0, snapshot: false, now: "doc-src/md061.md" },
        { path: "old.js", status: "modified", added: 1, removed: 1, snapshot: false, now: null }
      ],
      commands: ["npm test"],
      mistakes: [],
      nearby: [],
      diff: [chunk("lib/md061.mjs", 10), chunk("doc-build/md061.md", 2000)]
    }, 2000)
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain("- doc-src/md061.md (+5 -0; was doc-build/md061.md then)")
    expect(text).toContain("- old.js (+1 -1; no longer exists)")
    expect(text).toContain("diff --git a/lib/md061.mjs")
    expect(text).toContain("diff --git a/doc-build/md061.md")
    expect(text).toMatch(/… \(\d+ more lines\)/)
    expect(text).toContain("`git show 0123456789`")
  })
})

describe("task start", () => {
  it.effect("hands over the stored change most like the task, read from git with today's paths", () =>
    Effect.promise(() => {
      const root = tempDir()
      const repo = join(root, "repo")
      mkdirSync(join(repo, "doc-build"), { recursive: true })
      git(repo, "init", "-q")
      writeFileSync(join(repo, "README.md"), "# rules\n")
      git(repo, "add", ".")
      git(repo, "commit", "-qm", "start")
      const base = git(repo, "rev-parse", "HEAD")
      writeFileSync(join(repo, "doc-build", "md061.md"), "# MD061\n")
      writeFileSync(join(repo, "README.md"), "# rules\n- MD061\n")
      git(repo, "add", ".")
      git(repo, "commit", "-qm", "MD061")
      const head = git(repo, "rev-parse", "HEAD")
      git(repo, "mv", "doc-build", "doc-src")
      git(repo, "commit", "-qm", "rename")
      const tenantDir = join(root, "home", "tenants", "local")
      return run(Effect.gen(function*() {
        const store = yield* RecordStore
        const id = yield* identifyRepo(repo)
        const subject = yield* store.subjectFor(id!, { create: true })
        const record = buildRecord({
          tenant: "local",
          subject: subject!.id,
          trace: session(RULE, [[bash("npm test", "ok")]], repo),
          diff: git(repo, "diff", base, head),
          outcome: "success",
          checks: [],
          memory: null,
          run: {
            source: "session", log: "s.jsonl", run_dir: null, run_id: null, setup: null, task_id: null,
            repo, base_commit: base, head_commit: head, started_at: null, cost_usd: null, tokens: null
          },
          createdAt: "2026-10-14T12:00:00Z"
        })
        yield* store.put(record)
        const got = yield* startScripts({ sessionId: "s2", prompt: OTHER_RULE, cwd: repo }, { tenantDir })
        expect(got.picked?.commit).toBe(head)
        expect(got.text).toContain("doc-src/md061.md (+1 -0; was doc-build/md061.md then)")
        expect(got.text).toContain("+- MD061")
        expect(got.text).toContain("`npm test`")
        const none = yield* startScripts({ sessionId: "s3", prompt: RENAME, cwd: repo }, { tenantDir })
        expect(none.text).toBeUndefined()
      }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
    }))
})
