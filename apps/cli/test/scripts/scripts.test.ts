import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import type { CommandRun } from "../../src/records/Models.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { askedShown } from "../../src/records/Task.ts"
import { commandsToShow, renderFull, renderPointer } from "../../src/scripts/Render.ts"
import { MIN_SCORE, pick, rank, rankRecall, score } from "../../src/scripts/Search.ts"
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

  it("finds a change filed under a prompt that asks for nothing by its commit message, never by that prompt", () => {
    const docs = [{ id: "spinner", prompt: "commit and open a PR", message: "Show the installer's steps one per line, with a spinner for the step running" }]
    expect(pick("Make the installer show each step on its own line, with a spinner for the step running", docs)?.doc.id).toBe("spinner")
    expect(pick("commit and open a PR", docs)).toBeUndefined()
    expect(pick("commit and open a PR", [{ id: "old", prompt: "commit and open a PR" }])?.doc.id).toBe("old")
  })
})

describe("recall mid-task", () => {
  it("finds a script from a short line of what the agent is about to do", () => {
    const docs = [
      { id: "rule", prompt: RULE, files: ["lib/md061.mjs", "doc-build/md061.md"] },
      { id: "rename", prompt: RENAME, files: ["package.json"] }
    ]
    expect(score("add a new rule with a parameter", RULE)).toBeLessThan(MIN_SCORE)
    const [top] = rankRecall("add a new rule with a parameter", docs)
    expect(top.doc.id).toBe("rule")
    expect(top.matches).toBe(true)
    expect(rankRecall("translate the readme to french", docs).some((r) => r.matches)).toBe(false)
    expect(rankRecall(OTHER_RULE, docs)[0].matches).toBe(true)
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

  it("points to a change by its commit, the first line of its task and its files, with no diff", () => {
    const file = (path: string, more: object = {}) => ({ path, status: "modified" as const, added: 2, removed: 1, snapshot: false, now: path, ...more })
    const text = renderPointer({
      prompt: "yes",
      message: "Show the installer's steps one per line\n\nEach step on its own line.",
      commit: "0123456789abcdef",
      files: [
        file("install.sh"),
        file("lib/old.mjs", { now: "lib/new.mjs" }),
        file("README.md", { fate: { kind: "stale", last: { hash: "fedcba9876", title: "Rewrite the README" } } }),
        file("test/__snapshots__/a.snap", { snapshot: true })
      ]
    })
    expect(text).toContain("committed as 0123456789: \"Show the installer's steps one per line\".")
    expect(text).toContain("`git show 0123456789`")
    expect(text).toContain(
      "- install.sh (+2 -1)\n- lib/new.mjs (+2 -1; was lib/old.mjs then)\n" +
        "- README.md (+2 -1; it has changed since, last in fedcba9876 \"Rewrite the README\")\n- 1 snapshot it regenerated"
    )
    expect(text).not.toContain("Each step on its own line")
    const many = renderPointer({ prompt: RULE, commit: "0123456789abcdef", files: Array.from({ length: 15 }, (_, i) => file(`locales/${i}.json`)) })
    expect(many).toContain("- locales/11.json (+2 -1)\n- and 3 more")
  })

  it("shows what the person asked only when the commit message says too little", () => {
    const PATH = "Put the singularity command back on PATH on update, with no setup step"
    expect(askedShown({ prompt: "this is what I am seeing - i just ran singularity uninstall --purge", message: PATH })).toBeUndefined()
    expect(askedShown({ prompt: RULE, message: "Add MD061" })).toBe(RULE)
    expect(askedShown({ prompt: RULE })).toBe(RULE)
    expect(askedShown({ prompt: "yes", message: "wip" })).toBeUndefined()
  })

  it("shows a change in full as its pointer, what git doesn't show, and never its diff or mistakes", () => {
    const view = { commit: "0123456789abcdef", files: [], commands: ["npm test", "npm run lint"] }
    const text = renderFull({ ...view, prompt: "this is what I am seeing", message: "Put the singularity command back on PATH on update\n\nThe installer adds it too." })
    expect(text).toContain("committed as 0123456789: \"Put the singularity command back on PATH on update\".")
    expect(text).toContain("`git show 0123456789` shows its change (add `-- <file>` for one file).\n")
    expect(text).not.toContain("memory then adds")
    expect(text).toContain("## Project commands it ran, in order\n\n`npm test`, `npm run lint`")
    expect(text).not.toContain("What it was asked")
    expect(text).not.toContain("this is what I am seeing")
    expect(text).not.toMatch(/diff --git|Mistakes/)
    // A request the message says too little about: its first line is the pointer's, the rest comes in full.
    const asked = `${RULE}\nKeep the rule's tests next to the others.`
    expect(renderFull({ ...view, prompt: asked, message: "MD061" })).toContain(`committed as 0123456789: "${RULE}".`)
    expect(renderFull({ ...view, prompt: asked, message: "MD061" })).toContain(`## What it was asked\n\n${asked}\n`)
    // A one-line request is all in the pointer's line already.
    expect(renderFull({ ...view, prompt: RULE, message: "MD061" })).not.toContain("## What it was asked")
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
        expect(got.text).not.toContain("+- MD061")
        expect(got.text).toContain("`npm test`")
        const none = yield* startScripts({ sessionId: "s3", prompt: RENAME, cwd: repo }, { tenantDir })
        expect(none.text).toBeUndefined()
      }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))
    }))
})
