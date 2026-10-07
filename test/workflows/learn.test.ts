import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadHome } from "../../src/local/Home.ts"
import { identifyRepo } from "../../src/local/Git.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { sourceFiles } from "../../src/records/Models.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { backfill, branchCommits, pastSessions, projectDirName, sessionRange } from "../../src/workflows/Backfill.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { learnState, learnSubject, mergeSubject, waitReason } from "../../src/workflows/Learn.ts"
import { HOOK_SCRIPT } from "../../src/setup/Wiring.ts"
import { emptyMemory, type WorkflowMemory } from "../../src/workflows/Models.ts"
import { forSubject, startTask } from "../../src/workflows/Start.ts"
import { WorkflowStore } from "../../src/workflows/WorkflowStore.ts"
import { FAKE_CLAUDE, run, tempDir, withEnv } from "../eval/helpers.ts"

/** Times in these tests: seconds after 2026-09-01 10:00 UTC. */
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const gitAt = (cwd: string, when: string | undefined, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf-8",
    env: when === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
  }).trim()

/** A repo whose first commit (an hour before T0) has app.ts; then a commit at each of `commits` (seconds), each changing it. */
const makeRepo = (root: string, name: string, commits: ReadonlyArray<number>): string => {
  const repo = join(root, name)
  mkdirSync(repo)
  gitAt(repo, undefined, "init", "-q")
  writeFileSync(join(repo, "app.ts"), `export const name = "${name}"\nexport const colors = ["red"]\n`)
  gitAt(repo, at(-3600), "add", ".")
  gitAt(repo, at(-3600), "commit", "-qm", "start")
  commits.forEach((s, i) => {
    writeFileSync(join(repo, "app.ts"), `export const name = "${name}"\nexport const colors = ["red", "c${i}"]\n`)
    gitAt(repo, at(s), "commit", "-qam", `change ${i}`)
  })
  return repo
}

const usage = { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }

/** A Claude Code transcript of a session in `cwd` from `start` (seconds) for ten seconds: an edit, then `npm test` unless tests is "none". */
const writeTranscript = (claudeHome: string, cwd: string, sessionId: string, start: number, prompt: string, tests: "pass" | "fail" | "none") => {
  const msg = (n: number, content: Array<unknown>) => ({
    type: "assistant",
    timestamp: at(start + n),
    message: { id: `${sessionId}-m${n}`, model: "claude-test", content, usage }
  })
  const result = (n: number, id: string, error: boolean) => ({
    type: "user",
    timestamp: at(start + n),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: error ? "1 test failed" : "ok", is_error: error }] }
  })
  const lines = [
    { type: "user", timestamp: at(start), cwd, sessionId, message: { role: "user", content: prompt } },
    msg(1, [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(cwd, "app.ts"), old_string: "\"red\"", new_string: "\"red\", \"blue\"" } }]),
    result(2, "t1", false),
    ...(tests === "none" ? [] : [msg(3, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }]), result(4, "t2", tests === "fail")]),
    msg(10, [{ type: "text", text: "Done" }])
  ]
  const dir = join(claudeHome, "projects", projectDirName(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

const workflowAnswer = {
  workflows: [{
    id: "change-colors",
    name: "Change the app's colors",
    use_when: "a task changes the colors",
    blanks: [],
    steps: [{ do: "Edit the colors list in app.ts.", place: null, when: null }],
    checks: ["npm test"],
    pitfalls: [],
    from_runs: [],
    only_if_asked: false
  }],
  edges: [
    { from: "start", to: "change-colors", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null },
    { from: "change-colors", to: "end", relation: "LEADS_TO", condition: null, guidance: null, pitfalls: null }
  ],
  pitfalls: [],
  entries: [],
  rationale: "every session changed the colors"
}
const cuesAnswer = {
  workflows: [{ id: "change-colors", any: ["colors"], none: [], steps: [], fills: [] }],
  tasks: [],
  rationale: "the word colors"
}

const storesFor = (homeDir: string) =>
  Layer.unwrap(Effect.gen(function*() {
    const home = yield* loadHome(homeDir)
    const path = yield* Path.Path
    return Layer.merge(
      JsonRecordStore.layer(home.tenantDir, home.tenant),
      JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(home.tenantDir, path), home.tenant)
    )
  }))

describe("past sessions", () => {
  it("names project directories as Claude Code does", () => {
    expect(projectDirName("C:\\Users\\a\\my repo")).toBe("C--Users-a-my-repo")
    expect(projectDirName("/home/a/repo.js")).toBe("-home-a-repo-js")
  })

  it("takes a session's commits from its first event to a few minutes after its last", () => {
    const commits = [
      { hash: "c3", parent: "c2", time: 9_000_000 },
      { hash: "c2", parent: "c1", time: 1_100_000 },
      { hash: "c1", parent: "c0", time: 1_050_000 },
      { hash: "c0", parent: undefined, time: 0 }
    ]
    expect(sessionRange(commits, 1_000_000, 1_060_000)).toEqual({ base: "c0", head: "c2" })
    expect(sessionRange(commits, 1_060_000, 1_070_000)).toEqual({ base: "c1", head: "c2" })
    expect(sessionRange(commits, 2_000_000, 2_100_000)).toBeUndefined()
  })

  it("records past sessions that committed a change with passing tests, each with its own commits", async () => {
    const root = tempDir()
    const claudeHome = join(root, "claude")
    const homeDir = join(root, "home")
    const repo = makeRepo(root, "app", [5, 7205, 10805])
    writeTranscript(claudeHome, repo, "aaaaaaa1-0000-0000-0000-000000000001", 0, "Add blue to the colors", "pass")
    writeTranscript(claudeHome, repo, "aaaaaaa2-0000-0000-0000-000000000002", 3600, "Look around", "none")
    writeTranscript(claudeHome, repo, "aaaaaaa3-0000-0000-0000-000000000003", 7200, "Add green to the colors", "fail")
    writeTranscript(claudeHome, repo, "aaaaaaa4-0000-0000-0000-000000000004", 10800, "Add teal to the colors", "pass")
    // A session in another directory is someone else's.
    writeTranscript(claudeHome, join(root, "elsewhere"), "bbbbbbb1-0000-0000-0000-000000000001", 0, "Other work", "pass")

    const sessions = await run(pastSessions(repo, claudeHome))
    expect(sessions.map((s) => s.sessionId.slice(0, 8))).toEqual(["aaaaaaa1", "aaaaaaa2", "aaaaaaa3", "aaaaaaa4"])

    const home = await run(loadHome(homeDir))
    const result = await run(backfill(repo, claudeHome, home.tenantDir).pipe(Effect.provide(storesFor(homeDir))))
    expect(result.recorded).toEqual(["app-aaaaaaa1", "app-aaaaaaa4"])
    expect(Object.fromEntries(result.skipped)).toEqual({ "nothing was committed": 1, "the last test run failed": 1 })

    const commits = await run(branchCommits(repo))
    const records = await run(Effect.gen(function*() {
      return yield* (yield* RecordStore).find({ subject: "app" })
    }).pipe(Effect.provide(storesFor(homeDir))))
    // The last session's record holds its own commit only, not the ones before it.
    const last = records.find((r) => r.id === "app-aaaaaaa4")!
    expect([last.run.base_commit, last.run.head_commit]).toEqual([commits[1].hash, commits[0].hash])
    expect(sourceFiles(last)).toEqual(["app.ts"])

    // Running it again records nothing twice.
    const again = await run(backfill(repo, claudeHome, home.tenantDir).pipe(Effect.provide(storesFor(homeDir))))
    expect(again.recorded).toEqual(["app-aaaaaaa1", "app-aaaaaaa4"])
  }, 60_000)
})

describe("learning repo by repo", () => {
  const memoryOf = (subject: string, ids: ReadonlyArray<string>): WorkflowMemory => ({
    ...emptyMemory("local"),
    workflows: ids.map((id) => ({
      id,
      subject,
      name: id,
      use_when: "",
      only_if_asked: false,
      blanks: [],
      steps: [{ do: "x", place: null, when: null }],
      checks: [],
      pitfalls: ["trap"],
      evidence: [],
      tasks: []
    })),
    pitfalls: [{ id: "trap", subject, text: "a trap", trigger: null, evidence: [], cost_tokens: 0 }],
    edges: ids.flatMap((id) => [
      { from: "start", to: id, relation: "LEADS_TO" as const, condition: null, guidance: null, pitfalls: null },
      { from: id, to: "end", relation: "LEADS_TO" as const, condition: null, guidance: null, pitfalls: null }
    ])
  })

  it("merges a repo's memory in without touching another's, renaming ids they share", () => {
    const a = memoryOf("a", ["fix", "test"])
    const merged = mergeSubject(a, "b", memoryOf("b", ["fix"]))
    expect(merged.workflows.map((w) => `${w.subject}:${w.id}`)).toEqual(["a:fix", "a:test", "b:fix-b"])
    expect(merged.pitfalls.map((p) => p.id)).toEqual(["trap", "trap-b"])
    expect(merged.workflows.find((w) => w.id === "fix-b")?.pitfalls).toEqual(["trap-b"])
    // Each repo still sees its own graph, whole.
    expect(forSubject(merged, "a")).toEqual(forSubject(a, "a"))
    expect(forSubject(merged, "b").edges.map((e) => `${e.from}>${e.to}`)).toEqual(["start>fix-b", "fix-b>end"])
    // A repo learned again replaces its own memory only.
    const again = mergeSubject(merged, "a", memoryOf("a", ["fix"]))
    expect(again.workflows.map((w) => `${w.subject}:${w.id}`)).toEqual(["b:fix-b", "a:fix"])
  })

  it("waits for two sessions before a first memory, then for new ones", () => {
    const state = (records: number, fresh: number, workflows: number) => ({
      records: Array.from({ length: records }) as never,
      learned: [],
      unlearned: [],
      fresh: Array.from({ length: fresh }) as never,
      memory: memoryOf("a", Array.from({ length: workflows }, (_, i) => `w${i}`))
    })
    expect(waitReason(state(1, 1, 0), 3, false)).toBe("1 of 2 sessions recorded for a first build")
    expect(waitReason(state(2, 2, 0), 3, false)).toBeUndefined()
    expect(waitReason(state(2, 0, 0), 3, false)).toBe("nothing new since the last try")
    expect(waitReason(state(5, 2, 1), 3, false)).toBe("2 of 3 new sessions recorded")
    expect(waitReason(state(5, 1, 1), 3, true)).toBeUndefined()
  })

  it("builds a repo's first memory from its sessions, with cues, and keeps another repo's when it learns that one", async () => {
    const root = tempDir()
    const claudeHome = join(root, "claude")
    const homeDir = join(root, "home")
    const config = { claude: FAKE_CLAUDE, cwd: root, model: "sonnet", effort: "high", every: 3 }
    const home = await run(loadHome(homeDir))

    const learnRepo = async (name: string) => {
      // The fake model answers in order: the workflows, then their cues (and the cues again if asked twice).
      const answers = join(root, `answers-${name}.json`)
      writeFileSync(answers, JSON.stringify([workflowAnswer, cuesAnswer]))
      const repo = makeRepo(root, name, [5, 3605])
      writeTranscript(claudeHome, repo, `${name.padEnd(7, "x")}1-0000-0000-0000-000000000001`, 0, "Add blue to the colors", "pass")
      writeTranscript(claudeHome, repo, `${name.padEnd(7, "x")}2-0000-0000-0000-000000000002`, 3600, "Add green to the colors", "pass")
      return withEnv({ FAKE_CLAUDE_ANSWERS: answers, SINGULARITY_HOME: homeDir }, () =>
        run(Effect.gen(function*() {
          yield* backfill(repo, claudeHome, home.tenantDir)
          const subject = (yield* (yield* RecordStore).subjectFor((yield* identifyRepo(repo))!))!
          const outcome = yield* learnSubject(subject, config)
          return { repo, subject, outcome }
        }).pipe(Effect.provide(storesFor(homeDir)))))
    }

    const a = await learnRepo("alpha")
    expect(a.outcome).toMatchObject({ kind: "learned", round: "build", workflows: ["Change the app's colors"], sessions: 2 })
    const b = await learnRepo("beta")
    expect(b.outcome.kind).toBe("learned")

    const after = await run(Effect.gen(function*() {
      const memory = yield* (yield* WorkflowStore).memory()
      const waiting = yield* learnSubject(a.subject, config)
      const stateA = yield* learnState(a.subject.id)
      // A task in repo alpha is picked its workflow by cues, with no model call.
      const handed = yield* startTask({ sessionId: "s", prompt: "Make the colors darker", cwd: a.repo }, { tenantDir: home.tenantDir, cues: true, persist: false })
      return { memory, waiting, stateA, handed }
    }).pipe(Effect.provide(storesFor(homeDir))))
    expect(after.memory.workflows.map((w) => `${w.subject}:${w.id}`)).toEqual(["alpha:change-colors", "beta:change-colors-beta"])
    expect(after.memory.workflows.every((w) => w.cues?.any.includes("colors"))).toBe(true)
    expect(after.waiting).toMatchObject({ kind: "waiting", reason: "0 of 3 new sessions recorded" })
    expect(after.stateA.learned).toHaveLength(2)
    // (A workflow with no place and only checks is folded into the one finishing command.)
    expect(after.handed.text).toContain("When all your edits are in, run once: `npm test`")

    // Gemini CLI's hook gets the same hand-over, under its own event's name.
    const hook = spawnSync(process.execPath, [HOOK_SCRIPT, "user-prompt-submit"], {
      input: JSON.stringify({ session_id: "gemini-1", cwd: a.repo, hook_event_name: "BeforeAgent", prompt: "Make the colors darker" }),
      encoding: "utf-8",
      env: { ...process.env, SINGULARITY_HOME: homeDir, SINGULARITY_HOOKS: "on" }
    })
    const out = JSON.parse(hook.stdout).hookSpecificOutput
    expect(out.hookEventName).toBe("BeforeAgent")
    expect(out.additionalContext).toContain("run once: `npm test`")
  }, 60_000)
})
