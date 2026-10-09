import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadHome } from "../../src/local/Home.ts"
import { commitRecordId, recordId } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { leftOut } from "../../src/setup/Status.ts"
import { HOOK_SCRIPT } from "../../src/setup/Wiring.ts"
import { gatherEvidence } from "../../src/workflows/Evidence.ts"
import { A_COPY, chainsOf, isDocs, MADE_TOGETHER, NOT_FROM_A_SESSION, readSkips, storeCommits, storePast } from "../../src/workflows/Commits.ts"
import * as JsonWorkflowStore from "../../src/workflows/JsonWorkflowStore.ts"
import { writeSession } from "../../src/workflows/Session.ts"
import { commandOf, ranCommit } from "../../src/workflows/StoreTrigger.ts"
import { projectDirName } from "../../src/workflows/Transcripts.ts"
import { run, tempDir } from "../eval/helpers.ts"

/** Times in these tests: seconds after 2026-09-01 10:00 UTC. */
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const gitAt = (cwd: string, when: string | undefined, ...args: Array<string>) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf-8",
    env: when === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
  }).trim()

/** A repo whose first commit (an hour before T0) has app.ts with one color, committed as t@example.com, the repo's own author. */
const makeRepo = (root: string): string => {
  const repo = join(root, "app")
  mkdirSync(repo)
  gitAt(repo, undefined, "init", "-q")
  gitAt(repo, undefined, "config", "user.email", "t@example.com")
  gitAt(repo, undefined, "config", "user.name", "t")
  writeFileSync(join(repo, "app.ts"), `export const colors = ["red"]\n`)
  gitAt(repo, at(-3600), "add", ".")
  gitAt(repo, at(-3600), "commit", "-qm", "start")
  return repo
}

/** Write app.ts with `colors` and commit it at `s` seconds (`authored`: an older author time, as a rebase leaves). */
const commitColors = (repo: string, s: number, colors: ReadonlyArray<string>, options: { readonly email?: string; readonly authored?: number } = {}) => {
  writeFileSync(join(repo, "app.ts"), `export const colors = [${colors.map((c) => `"${c}"`).join(", ")}]\n`)
  const env = { ...process.env, GIT_AUTHOR_DATE: at(options.authored ?? s), GIT_COMMITTER_DATE: at(s) }
  const who = options.email === undefined ? [] : ["-c", `user.email=${options.email}`]
  execFileSync("git", ["-c", "core.autocrlf=false", ...who, "commit", "-qam", `colors ${colors.join(" ")}`], { cwd: repo, env })
  return gitAt(repo, undefined, "rev-parse", "HEAD")
}

const usage = { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }

type Step =
  | { readonly prompt: string; readonly at: number }
  | { readonly edit: ReadonlyArray<string>; readonly from: ReadonlyArray<string>; readonly at: number }
  | { readonly bash: string; readonly at: number; readonly output?: string; readonly error?: boolean }

/** A Claude Code transcript of a session in `cwd`: prompts, edits of app.ts's colors and shell commands, each answered a second later. */
const writeTranscript = (claudeHome: string, cwd: string, sessionId: string, steps: ReadonlyArray<Step>): string => {
  const lines: Array<unknown> = []
  steps.forEach((s, i) => {
    if ("prompt" in s) {
      lines.push({ type: "user", timestamp: at(s.at), cwd, sessionId, message: { role: "user", content: s.prompt } })
      return
    }
    const id = `t${i}`
    const list = (cs: ReadonlyArray<string>) => `export const colors = [${cs.map((c) => `"${c}"`).join(", ")}]`
    const use = "edit" in s
      ? { type: "tool_use", id, name: "Edit", input: { file_path: join(cwd, "app.ts"), old_string: list(s.from), new_string: list(s.edit) } }
      : { type: "tool_use", id, name: "Bash", input: { command: s.bash } }
    lines.push({ type: "assistant", timestamp: at(s.at), cwd, message: { id: `${sessionId}-m${i}`, model: "claude-test", content: [use], usage } })
    const error = "bash" in s && s.error === true
    const output = "bash" in s ? s.output ?? "ok" : "ok"
    lines.push({ type: "user", timestamp: at(s.at + 1), cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: error }] } })
  })
  const dir = join(claudeHome, "projects", projectDirName(cwd))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return file
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

const setup = () => {
  const root = tempDir()
  const claudeHome = join(root, "claude")
  const homeDir = join(root, "home")
  const repo = makeRepo(root)
  return { root, claudeHome, homeDir, repo }
}

const store = (t: ReturnType<typeof setup>, options: Parameters<typeof storeCommits>[3] = {}) =>
  run(Effect.gen(function*() {
    const home = yield* loadHome(t.homeDir)
    return yield* storeCommits(t.repo, { claude: t.claudeHome }, home.tenantDir, options)
  }).pipe(Effect.provide(storesFor(t.homeDir))))

const records = (t: ReturnType<typeof setup>) =>
  run(Effect.gen(function*() {
    return yield* (yield* RecordStore).find({ subject: "app" })
  }).pipe(Effect.provide(storesFor(t.homeDir))))

const skips = (t: ReturnType<typeof setup>) =>
  run(Effect.gen(function*() {
    return yield* readSkips((yield* loadHome(t.homeDir)).tenantDir)
  }))

describe("what starts storing", () => {
  const hook = (tool_input: unknown) => JSON.stringify({ session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input, tool_response: { stdout: "commit 1a2b" } })

  it("knows commands that can make a commit, in every agent's shape", () => {
    expect(ranCommit(hook({ command: "git add -A && git commit -qm 'Add blue'" }))).toBe(true)
    expect(ranCommit(hook({ command: "git -C ../app cherry-pick 1a2b" }))).toBe(true)
    expect(ranCommit(hook({ cmd: ["git", "pull", "--rebase"] }))).toBe(true)
    // Output that mentions commits isn't a commit.
    expect(ranCommit(hook({ command: "git log --oneline -3" }))).toBe(false)
    expect(ranCommit(hook({ command: "npm test" }))).toBe(false)
    expect(ranCommit("not json, but commit")).toBe(false)
    expect(commandOf({ cmd: ["git", "status"] })).toBe("git status")
  })

  it("counts what status shows as left out: the latest reason per commit, not stored since, a session's", () => {
    const skip = (commit: string, reason: string) => ({ at: "", subject: "app", commit, session: null, reason })
    const skips = [
      skip("c1", "no check was run before it"),
      skip("c1", "the last check before it failed"),
      skip("c2", "no check was run before it"),
      skip("c3", NOT_FROM_A_SESSION),
      skip("c4", "no check was run before it")
    ]
    expect(leftOut(skips, "app", new Set([commitRecordId("app", "c4")]))).toEqual([
      ["no check was run before it", 1],
      ["the last check before it failed", 1]
    ])
  })
})

describe("storing commits", () => {
  it("stores each commit a session makes, with the prompts and steps since its previous one", async () => {
    const t = setup()
    const s1 = "aaaaaaa1-0000-0000-0000-000000000001"
    // The session's commands run while the commits are made.
    const first = commitColors(t.repo, 5, ["red", "blue"])
    const second = commitColors(t.repo, 15, ["red", "blue", "green"])
    writeTranscript(t.claudeHome, t.repo, s1, [
      { prompt: "Add blue to the colors", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "npm test", at: 3 },
      { bash: "git commit -am 'Add blue'", at: 5 },
      { prompt: "Now add green", at: 10 },
      { edit: ["red", "blue", "green"], from: ["red", "blue"], at: 11 },
      { bash: "timeout 600 npx turbo run test", at: 13 },
      { bash: "git add -A && git commit -m 'Add green'", at: 15 }
    ])

    const result = await store(t)
    expect(result.stored).toEqual([commitRecordId("app", first), commitRecordId("app", second)])
    const [one, two] = await records(t)
    expect(one.task).toEqual({ prompt: "Add blue to the colors", followups: [] })
    expect([one.run.base_commit, one.run.head_commit]).toEqual([gitAt(t.repo, undefined, "rev-parse", `${first}^`), first])
    expect(one.run.segment).toEqual({ from: null, to: at(5) })
    expect(one.checks.map((c) => c.command)).toEqual(["npm test"])
    // The second commit's record starts after the first one's commit.
    expect(two.task).toEqual({ prompt: "Now add green", followups: [] })
    expect(two.run.segment).toEqual({ from: at(5), to: at(15) })
    expect([two.run.base_commit, two.run.head_commit]).toEqual([first, second])
    expect(two.commands.map((c) => c.command)).toEqual(["timeout 600 npx turbo run test", "git add -A && git commit -m 'Add green'"])

    // What reads a record's log again reads its part only.
    const evidence = await run(gatherEvidence([two], { repo: t.repo }))
    expect(evidence.runs[0].calls.map((c) => c.name)).toEqual(["Edit", "Bash", "Bash"])

    // Whichever moment looks again, nothing is stored twice.
    expect((await store(t)).stored).toEqual([])
    expect((await store(t, { session: { sessionId: s1, transcript: "" } })).stored).toEqual([])
  }, 60_000)

  it("stores a commit made outside the session with the session whose edits it holds", async () => {
    const t = setup()
    writeTranscript(t.claudeHome, t.repo, "bbbbbbb1-0000-0000-0000-000000000001", [
      { prompt: "Add teal to the colors", at: 0 },
      { edit: ["red", "teal"], from: ["red"], at: 1 },
      { bash: "npm test", at: 3 }
    ])
    // Another session, which edited something else, ran at the same time.
    writeTranscript(t.claudeHome, t.repo, "bbbbbbb2-0000-0000-0000-000000000002", [
      { prompt: "Look at the readme", at: 0 },
      { bash: "npm test", at: 2 }
    ])
    // The user reviewed the change and committed it from an editor, a minute later.
    const commit = commitColors(t.repo, 70, ["red", "teal"])

    const result = await store(t)
    expect(result.stored).toEqual([commitRecordId("app", commit)])
    const [r] = await records(t)
    expect(r.run.session_id).toBe("bbbbbbb1-0000-0000-0000-000000000001")
    expect(r.task.prompt).toBe("Add teal to the colors")
    expect(r.run.segment).toEqual({ from: null, to: new Date(T0 + 70_000 - 1).toISOString() })
  }, 60_000)

  it("leaves out what isn't a tested change of a session's, once, and says why", async () => {
    const t = setup()
    const untested = commitColors(t.repo, 5, ["red", "blue"])
    writeTranscript(t.claudeHome, t.repo, "ccccccc1-0000-0000-0000-000000000001", [
      { prompt: "Add blue", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "git commit -am blue", at: 5 }
    ])
    const failing = commitColors(t.repo, 25, ["red", "blue", "green"])
    writeTranscript(t.claudeHome, t.repo, "ccccccc2-0000-0000-0000-000000000002", [
      { prompt: "Add green", at: 20 },
      { edit: ["red", "blue", "green"], from: ["red", "blue"], at: 21 },
      { bash: "npm test", at: 23, output: "1 test failed", error: true },
      { bash: "git commit -am green", at: 25 }
    ])
    // The user's own work, with no session near it.
    const own = commitColors(t.repo, 5000, ["black"])
    // A teammate's, pulled in: not looked at at all.
    commitColors(t.repo, 5100, ["white"], { email: "teammate@example.com" })

    const result = await store(t)
    expect(result.stored).toEqual([])
    expect(Object.fromEntries(result.skipped)).toEqual({
      "no check was run before it": 1,
      "the last check before it failed": 1,
      [NOT_FROM_A_SESSION]: 1
    })
    const logged = await skips(t)
    expect(new Map(logged.map((s) => [s.commit, s.reason]))).toEqual(new Map([
      [untested, "no check was run before it"],
      [failing, "the last check before it failed"],
      [own, NOT_FROM_A_SESSION]
    ]))
    expect(logged.find((s) => s.commit === untested)?.session).toBe("ccccccc1-0000-0000-0000-000000000001")

    // A sweep doesn't look at them again; reading the past again does, without logging a reason twice.
    expect((await store(t)).examined).toBe(0)
    const again = await run(Effect.gen(function*() {
      return yield* storePast(t.repo, { claude: t.claudeHome }, (yield* loadHome(t.homeDir)).tenantDir)
    }).pipe(Effect.provide(storesFor(t.homeDir))))
    expect(again.examined).toBe(3)
    expect((await skips(t)).length).toBe(3)
  }, 60_000)

  it("leaves out a commit two sessions could have made or written, and one a rebase wrote again", async () => {
    const t = setup()
    for (const id of ["ddddddd1-0000-0000-0000-000000000001", "ddddddd2-0000-0000-0000-000000000002"]) {
      writeTranscript(t.claudeHome, t.repo, id, [
        { prompt: "Add teal", at: 0 },
        { edit: ["red", "teal"], from: ["red"], at: 1 },
        { bash: "npm test", at: 3 }
      ])
    }
    commitColors(t.repo, 60, ["red", "teal"])
    commitColors(t.repo, 400, ["red", "teal", "gold"], { authored: 100 })
    writeTranscript(t.claudeHome, t.repo, "ddddddd3-0000-0000-0000-000000000003", [
      { prompt: "Rebase onto main", at: 390 },
      { edit: ["red", "teal", "gold"], from: ["red", "teal"], at: 391 },
      { bash: "npm test", at: 393 },
      { bash: "git pull --rebase", at: 398 }
    ])
    const result = await store(t)
    expect(Object.fromEntries(result.skipped)).toEqual({
      "more than one session wrote what it adds": 1,
      "it rewrites an earlier commit (a rebase, an amend or a cherry-pick)": 1
    })
  }, 60_000)

  it("lets the session that made a commit store it after a sweep couldn't place it", async () => {
    const t = setup()
    const commit = commitColors(t.repo, 5, ["red", "blue"])
    // A sweep from another session ran before this one's log was on disk.
    writeTranscript(t.claudeHome, t.repo, "eeeeeee2-0000-0000-0000-000000000002", [
      { prompt: "Look around", at: 0 },
      { bash: "npm test", at: 4 }
    ])
    expect(Object.fromEntries((await store(t)).skipped)).toEqual({ [NOT_FROM_A_SESSION]: 1 })
    const id = "eeeeeee1-0000-0000-0000-000000000001"
    const transcript = writeTranscript(t.claudeHome, t.repo, id, [
      { prompt: "Add blue", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "npm test", at: 3 },
      { bash: "git commit -am blue", at: 5 }
    ])
    expect((await store(t)).stored).toEqual([])
    expect((await store(t, { session: { sessionId: id, transcript } })).stored).toEqual([commitRecordId("app", commit)])
  }, 60_000)

  it("judges the memory handed over at a session's start by its first change only", async () => {
    const t = setup()
    const id = "aaaaaaa9-0000-0000-0000-000000000009"
    commitColors(t.repo, 5, ["red", "blue"])
    commitColors(t.repo, 15, ["red", "blue", "green"])
    writeTranscript(t.claudeHome, t.repo, id, [
      { prompt: "Add blue to the colors", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "npm test", at: 3 },
      { bash: "git commit -am blue", at: 5 },
      { prompt: "Now add green", at: 10 },
      { edit: ["red", "blue", "green"], from: ["red", "blue"], at: 11 },
      { bash: "npm test", at: 13 },
      { bash: "git commit -am green", at: 15 }
    ])
    // What the task-start hook kept when it handed memory over.
    await run(Effect.gen(function*() {
      const home = yield* loadHome(t.homeDir)
      yield* writeSession(home.tenantDir, {
        session_id: id,
        tenant: home.tenant,
        subject: "app",
        repo: t.repo,
        head: null,
        started_at: at(0),
        prompt: "Add blue to the colors",
        version: 0,
        workflows: [],
        shown: [],
        missing: [],
        pitfalls: [],
        triggers: [],
        selection: null
      })
    }))
    await store(t)
    const [one, two] = await records(t)
    expect(one.memory).toMatchObject({ setup: "workflows", version: 0 })
    expect(two.memory).toBeNull()
  }, 60_000)

  it("stores the commit an agent just made from the tool-call hook, in the background", async () => {
    const t = setup()
    await run(loadHome(t.homeDir))
    // Ten minutes ago, within the window a background run looks at.
    const s0 = Math.floor((Date.now() - 600_000 - T0) / 1000)
    const id = "abcdef01-0000-0000-0000-000000000001"
    const commit = commitColors(t.repo, s0 + 5, ["red", "blue"])
    const transcript = writeTranscript(t.claudeHome, t.repo, id, [
      { prompt: "Add blue to the colors", at: s0 },
      { edit: ["red", "blue"], from: ["red"], at: s0 + 1 },
      { bash: "npm test", at: s0 + 3 },
      { bash: "git commit -qam blue", at: s0 + 5 }
    ])
    const hook = spawnSync(process.execPath, [HOOK_SCRIPT, "post-tool-use"], {
      input: JSON.stringify({
        session_id: id,
        transcript_path: transcript,
        cwd: t.repo,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "git commit -qam blue" },
        tool_response: { stdout: "" }
      }),
      encoding: "utf-8",
      env: {
        ...process.env,
        SINGULARITY_HOME: t.homeDir,
        SINGULARITY_HOOKS: "on",
        SINGULARITY_AUTOLEARN: "off",
        CLAUDE_CONFIG_DIR: t.claudeHome,
        CODEX_HOME: join(t.root, "no-codex"),
        HERMES_HOME: join(t.root, "no-hermes")
      }
    })
    expect(hook.status).toBe(0)
    expect(hook.stdout).toBe("")
    const file = join(t.homeDir, "tenants", "local", "records", "app", `${commitRecordId("app", commit)}.json`)
    for (let i = 0; i < 120 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
    expect(existsSync(file), readFileSync(join(t.homeDir, "store.log"), "utf-8")).toBe(true)
  }, 60_000)

  it("stores the commits one command made as one change, and a copy of a commit once", async () => {
    const t = setup()
    const id = "aaaaaaa7-0000-0000-0000-000000000007"
    // One command commits twice: the colors, then a second file.
    const first = commitColors(t.repo, 5, ["red", "blue"])
    writeFileSync(join(t.repo, "notes.md"), "Blue is new.\n")
    gitAt(t.repo, at(5), "add", "notes.md")
    gitAt(t.repo, at(5), "commit", "-qm", "notes")
    const second = gitAt(t.repo, undefined, "rev-parse", "HEAD")
    // Another branch holds a copy of the first commit: same author, times and title, another parent.
    gitAt(t.repo, undefined, "checkout", "-q", "-b", "copy", `${first}~1`)
    writeFileSync(join(t.repo, "app.ts"), `export const colors = ["red", "blue"]\n`)
    gitAt(t.repo, undefined, "add", "app.ts")
    writeFileSync(join(t.repo, "extra.txt"), "x\n")
    gitAt(t.repo, at(-1800), "add", "extra.txt")
    gitAt(t.repo, at(-1800), "commit", "-qm", "extra")
    const env = { ...process.env, GIT_AUTHOR_DATE: at(5), GIT_COMMITTER_DATE: at(5) }
    writeFileSync(join(t.repo, "app.ts"), `export const colors = ["red", "blue", "x"]\n`)
    execFileSync("git", ["-c", "core.autocrlf=false", "commit", "-qam", "colors red blue"], { cwd: t.repo, env })
    gitAt(t.repo, undefined, "checkout", "-q", "-")
    writeTranscript(t.claudeHome, t.repo, id, [
      { prompt: "Add blue, and a note about it", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "npm test", at: 3 },
      { bash: "git commit -qam blue && git add notes.md && git commit -qm notes", at: 5 }
    ])
    const result = await store(t)
    expect(result.stored).toEqual([commitRecordId("app", second)])
    const [r] = await records(t)
    expect([r.run.base_commit, r.run.head_commit]).toEqual([gitAt(t.repo, undefined, "rev-parse", `${first}^`), second])
    expect(Object.fromEntries(result.skipped)).toEqual({ [MADE_TOGETHER]: 1, [A_COPY]: 1 })
    const hashes = (cs: Array<Array<{ readonly hash: string }>>) => cs.map((c) => c.map((x) => x.hash))
    expect(hashes(chainsOf([{ hash: "b", parent: "a" }, { hash: "c", parent: "b" }, { hash: "a", parent: "z" }]))).toEqual([["a", "b", "c"]])
    expect(hashes(chainsOf([{ hash: "b", parent: "a" }, { hash: "c", parent: "x" }]))).toEqual([["b"], ["c"]])
    // Two commits on one parent: each starts a run of its own.
    expect(hashes(chainsOf([{ hash: "b", parent: "a" }, { hash: "c", parent: "a" }, { hash: "d", parent: "c" }]))).toEqual([["b"], ["c", "d"]])
  }, 60_000)

  it("takes any passing check before a change to code, and none before a change to docs alone", async () => {
    const t = setup()
    // A typecheck is the code's only check.
    const typed = commitColors(t.repo, 5, ["red", "blue"])
    writeTranscript(t.claudeHome, t.repo, "aaaaaaa5-0000-0000-0000-000000000005", [
      { prompt: "Add blue", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "timeout 300 npx tsc --noEmit", at: 3 },
      { bash: "git commit -qam blue", at: 5 }
    ])
    // The notes need none.
    writeFileSync(join(t.repo, "NOTES.md"), "Blue is the second color.\n")
    gitAt(t.repo, at(25), "add", "NOTES.md")
    gitAt(t.repo, at(25), "commit", "-qm", "notes")
    const notes = gitAt(t.repo, undefined, "rev-parse", "HEAD")
    writeTranscript(t.claudeHome, t.repo, "aaaaaaa6-0000-0000-0000-000000000006", [
      { prompt: "Write down why blue", at: 20 },
      { bash: "printf 'Blue is the second color.' > NOTES.md", at: 21 },
      { bash: "git add NOTES.md && git commit -qm notes", at: 25 }
    ])
    const result = await store(t)
    expect(result.stored).toEqual([commitRecordId("app", typed), commitRecordId("app", notes)])
    const [code, docs] = await records(t)
    expect(code.checks.map((c) => c.command)).toEqual(["timeout 300 npx tsc --noEmit"])
    expect(docs.checks).toEqual([])
    expect([isDocs("HANDOFF.md"), isDocs("docs/guide.mdx"), isDocs("LICENSE"), isDocs("src/readme.ts"), isDocs("app.ts")]).toEqual([true, true, true, false, false])
  }, 60_000)

  it("keeps a session recorded whole before commits were stored one by one", async () => {
    const t = setup()
    const id = "fffffff1-0000-0000-0000-000000000001"
    commitColors(t.repo, 5, ["red", "blue"])
    writeTranscript(t.claudeHome, t.repo, id, [
      { prompt: "Add blue", at: 0 },
      { edit: ["red", "blue"], from: ["red"], at: 1 },
      { bash: "npm test", at: 3 },
      { bash: "git commit -am blue", at: 5 }
    ])
    // The session's record from before, whole (only its file's name matters here).
    mkdirSync(join(t.homeDir, "tenants", "local", "records", "app"), { recursive: true })
    writeFileSync(join(t.homeDir, "tenants", "local", "records", "app", `${recordId("app", id)}.json`), "{}\n")
    const result = await store(t)
    expect(Object.fromEntries(result.skipped)).toEqual({ "stored before with its whole session": 1 })
  }, 60_000)
})
