import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord, commitRecordId } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { FILE_MIN_SCORE, MIN_SCORE, score, watchFiles } from "../../src/scripts/Search.ts"
import { editedFile, sweepWatches, type Watch, watchPath } from "../../src/scripts/Watch.ts"
import { HOOK_SCRIPT } from "../../src/setup/Wiring.ts"
import { git, run, tempDir } from "../eval/helpers.ts"
import { bash, session } from "../records/fixtures.ts"

const RULE = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const OTHER_RULE = "Add a new built-in rule MD062, alias `code-block-max-lines`, with parameters `maximum` and `ignore_languages`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const RENAME = "Rename the `doc-build` folder to `doc-src` and update everything that refers to it. `npm test` must pass."
/** Not like RULE enough to be handed it at the start, but enough to be handed it for its file. */
const FIX = "Rule MD061 (`heading-max-level`) reports headings inside code blocks. Fix the rule so it skips them, and add tests."
/** Like no stored task at all. */
const UNRELATED = "Rule MD061 reports headings inside code blocks: fix it, and add tests."

describe("files to watch", () => {
  it("watches the files few stored changes touched, of changes whose task is still somewhat like the new one", () => {
    expect(score(FIX, RULE)).toBeLessThan(MIN_SCORE)
    expect(score(FIX, RULE)).toBeGreaterThanOrEqual(FILE_MIN_SCORE)
    expect(score(UNRELATED, RULE)).toBeLessThan(FILE_MIN_SCORE)
    const docs = [
      { id: "rule", prompt: RULE, files: ["lib/md061.mjs", "lib/rules.mjs", "README.md", "test/scenarios.mjs.snapshot", "test/md061.test.mjs"] },
      { id: "other", prompt: OTHER_RULE, files: ["lib/md062.mjs", "lib/rules.mjs"] },
      { id: "rename", prompt: RENAME, files: ["doc-build/build.mjs", "package.json", "lib/rules.mjs"] }
    ]
    expect(score(FIX, RENAME)).toBeLessThan(FILE_MIN_SCORE)
    const watched = watchFiles(FIX, docs)
    // Not README (docs), the snapshot, or lib/rules.mjs, which every change touched; nor the files of the rename, a task too unlike.
    expect([...watched.keys()].sort()).toEqual(["lib/md061.mjs", "lib/md062.mjs", "test/md061.test.mjs"])
    expect(watched.get("lib/md061.mjs")!.map((r) => r.doc.id)).toEqual(["rule"])
    expect(watchFiles(UNRELATED, docs).size).toBe(0)
    expect(watchFiles(FIX, []).size).toBe(0)
  })
})

const write = (repo: string, file: string, text: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), text)
}

const newRepo = () => {
  const root = tempDir()
  const repo = join(root, "repo")
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q")
  write(repo, "lib/rules.mjs", "export const rules = []\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "start")
  return { root, repo, home: join(root, "home") }
}

const watchOn = (repo: string, files: Record<string, Array<string>>): Watch =>
  ({ root: repo, tenant: "local", tenant_dir: "unused", prompt: FIX, files })

describe("which call edits a watched file", () => {
  it("reads an edit tool's file, a patch's files, and a command that names a file git sees changed", () => {
    const { repo } = newRepo()
    write(repo, "lib/md061.mjs", "export const md061 = 1\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD061")
    const watch = watchOn(repo, { "lib/md061.mjs": ["rule"], "test/md061.test.mjs": ["rule"] })
    const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = repo) => ({ session_id: "s", cwd, tool_name, tool_input })

    expect(editedFile(call("Edit", { file_path: join(repo, "lib", "md061.mjs"), old_string: "1", new_string: "2" }), watch)).toBe("lib/md061.mjs")
    expect(editedFile(call("Write", { file_path: "md061.test.mjs", content: "" }, join(repo, "test")), watch)).toBe("test/md061.test.mjs")
    expect(editedFile(call("write_file", { path: "lib/md061.mjs", content: "" }), watch)).toBe("lib/md061.mjs")
    expect(editedFile(call("Edit", { file_path: join(repo, "lib", "rules.mjs") }), watch)).toBeUndefined()
    expect(editedFile(call("Edit", { file_path: join(dirname(repo), "lib", "md061.mjs") }), watch)).toBeUndefined()
    // Reading isn't editing.
    expect(editedFile(call("Read", { file_path: join(repo, "lib", "md061.mjs") }), watch)).toBeUndefined()
    // Codex's apply_patch, however it's passed.
    const patch = "*** Begin Patch\n*** Update File: lib/md061.mjs\n@@\n-export const md061 = 1\n+export const md061 = 2\n*** End Patch\n"
    expect(editedFile(call("apply_patch", { command: ["apply_patch", patch] }), watch)).toBe("lib/md061.mjs")
    expect(editedFile(call("apply_patch", { input: patch.replace("lib/md061.mjs", "lib/rules.mjs") }), watch)).toBeUndefined()

    // A command that names the file counts once git sees it changed.
    const sed = call("Bash", { command: "sed -i 's/1/2/' lib/md061.mjs" })
    expect(editedFile(sed, watch)).toBeUndefined()
    write(repo, "lib/md061.mjs", "export const md061 = 2\n")
    expect(editedFile(sed, watch)).toBe("lib/md061.mjs")
    expect(editedFile(call("Bash", { command: "npm test" }), watch)).toBeUndefined()
    // A new file, as a command writes it.
    write(repo, "test/md061.test.mjs", "test\n")
    expect(editedFile(call("Bash", { command: "cat > test/md061.test.mjs <<'E'\ntest\nE" }), watch)).toBe("test/md061.test.mjs")
  })
})

/** Store the change base..head as a record with `prompt`. */
const storeChange = (repo: string, tenantDir: string, prompt: string, base: string, head: string) =>
  run(Effect.gen(function*() {
    const store = yield* RecordStore
    const subject = yield* store.subjectFor((yield* identifyRepo(repo))!, { create: true })
    yield* store.put(buildRecord({
      id: commitRecordId(subject!.id, head),
      tenant: "local",
      subject: subject!.id,
      trace: session(prompt, [[bash("npm test", "ok")]], repo),
      diff: git(repo, "diff", base, head),
      outcome: "success",
      checks: [],
      memory: null,
      run: {
        source: "session", log: "s.jsonl", run_dir: null, run_id: null, setup: null, task_id: null,
        repo, base_commit: base, head_commit: head, started_at: null, cost_usd: null, tokens: null
      },
      createdAt: "2026-10-14T12:00:00Z"
    }))
  }).pipe(Effect.provide(JsonRecordStore.layer(tenantDir, "local"))))

/** Run the hook script for `event`, as an eval run's own hook (which stores nothing), with `home` as memory's home. */
const hook = (home: string, event: string, input: Record<string, unknown>) => {
  const done = spawnSync(process.execPath, [HOOK_SCRIPT, event, "--eval-run"], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, SINGULARITY_HOME: home, SINGULARITY_HOOKS: "off" }
  })
  expect(done.status).toBe(0)
  const errors = join(home, "hook-errors.log")
  expect(existsSync(errors) ? readFileSync(errors, "utf-8") : "").toBe("")
  return done.stdout
}

describe("which prompts start a task, through the hooks", () => {
  it("hands over at the first prompt that asks, again at the first after each commit, and never for one that asks for nothing", async () => {
    const { repo, home } = newRepo()
    const tenantDir = join(home, "tenants", "local")
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", "export const md061 = (params, onError) => {\n  const maximum = params.config.maximum ?? 6\n}\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD061")
    await storeChange(repo, tenantDir, RULE, base, git(repo, "rev-parse", "HEAD"))

    const say = (session_id: string, prompt: string) => hook(home, "user-prompt-submit", { session_id, cwd: repo, hook_event_name: "UserPromptSubmit", prompt })
    const marker = (s: string) => join(tenantDir, "scripts", "sessions", s)
    const LIKE = "A past change in this repository like your task"
    const s = "bbbbbbbb-0000-0000-0000-000000000001"
    // Pointers to read and approvals start nothing, and leave no marker.
    expect(say(s, "please read @HANDOFF.md")).toBe("")
    expect(existsSync(marker(s))).toBe(false)
    expect(say(s, OTHER_RULE)).toContain(LIKE)
    expect(say(s, "yes, go ahead")).toBe("")
    // The same task's follow-up, before any commit: nothing.
    expect(say(s, OTHER_RULE)).toBe("")
    write(repo, "lib/md062.mjs", "export const md062 = 1\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD062")
    expect(say(s, "commit and open a PR")).toBe("")
    // After a commit, the next request is a new task.
    expect(say(s, OTHER_RULE)).toContain(LIKE)

    // A session whose marker predates commits being kept starts its next task after its next commit.
    const old = "bbbbbbbb-0000-0000-0000-000000000002"
    mkdirSync(join(tenantDir, "scripts", "sessions"), { recursive: true })
    writeFileSync(marker(old), "an earlier first prompt")
    expect(say(old, OTHER_RULE)).toBe("")
    expect(JSON.parse(readFileSync(marker(old), "utf-8")).head).toBe(git(repo, "rev-parse", "HEAD"))
    git(repo, "commit", "-q", "--allow-empty", "-m", "later")
    expect(say(old, OTHER_RULE)).toContain(LIKE)
  }, 60_000)
})

describe("hand-over by file, through the hooks", () => {
  it("watches after a start with nothing, hands over once for the first watched file edited, and ends with the session", async () => {
    const { repo, home } = newRepo()
    const tenantDir = join(home, "tenants", "local")
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", "export const md061 = (params, onError) => {\n  const maximum = params.config.maximum ?? 6\n}\n")
    write(repo, "lib/rules.mjs", "import { md061 } from './md061.mjs'\nexport const rules = [md061]\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD061")
    const head = git(repo, "rev-parse", "HEAD")
    await storeChange(repo, tenantDir, RULE, base, head)

    const s = "aaaaaaaa-0000-0000-0000-000000000001"
    const at = { session_id: s, cwd: repo }
    expect(hook(home, "user-prompt-submit", { ...at, hook_event_name: "UserPromptSubmit", prompt: FIX })).toBe("")
    const watching = JSON.parse(readFileSync(watchPath(home, s), "utf-8")) as Watch
    // With one change stored, each of its files is one change's in one.
    expect(Object.keys(watching.files).sort()).toEqual(["lib/md061.mjs", "lib/rules.mjs"])

    const call = (command: string) => ({ ...at, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } })
    // Reading the file: nothing.
    expect(hook(home, "post-tool-use", call("cat lib/md061.mjs"))).toBe("")
    write(repo, "lib/md061.mjs", "export const md061 = (params, onError) => {\n  const maximum = params.config.maximum ?? 6\n  // skip code blocks\n}\n")
    const out = hook(home, "post-tool-use", call("python3 fix.py lib/md061.mjs"))
    const context = JSON.parse(out).hookSpecificOutput as { hookEventName: string; additionalContext: string }
    expect(context.hookEventName).toBe("PostToolUse")
    expect(context.additionalContext).toContain("# A past change to a file you're editing")
    expect(context.additionalContext).toContain("You just edited lib/md061.mjs.")
    expect(context.additionalContext).toContain(RULE)
    // Its change to the file edited comes first.
    expect(context.additionalContext.indexOf("diff --git a/lib/md061.mjs")).toBeLessThan(context.additionalContext.indexOf("diff --git a/lib/rules.mjs"))
    expect(existsSync(watchPath(home, s))).toBe(false)
    const log = readFileSync(join(tenantDir, "workflows", "handovers.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.map((l) => [l.moment, l.file ?? null, l.picked?.commit ?? null])).toEqual([["start", null, null], ["file", "lib/md061.mjs", head]])
    // One a session.
    expect(hook(home, "post-tool-use", call("python3 fix.py lib/md061.mjs"))).toBe("")

    // A change the session read in git already isn't handed over again for its file.
    const reader = { session_id: "aaaaaaaa-0000-0000-0000-000000000002", cwd: repo }
    const bash = (command: string, stdout: string) => ({ ...reader, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout } })
    expect(hook(home, "user-prompt-submit", { ...reader, hook_event_name: "UserPromptSubmit", prompt: FIX })).toBe("")
    const shown = hook(home, "post-tool-use", bash(`git show --stat ${head.slice(0, 10)}`, `commit ${head}\nAuthor: A <a@b.c>\n\n    MD061\n\n lib/md061.mjs | 3 +++\n`))
    expect(JSON.parse(shown).hookSpecificOutput.additionalContext).toContain(`# What git doesn't show about ${head.slice(0, 10)}`)
    expect(hook(home, "post-tool-use", bash("python3 fix.py lib/md061.mjs", ""))).toBe("")

    // A task like no stored one watches nothing; one handed a change at the start watches nothing either.
    expect(hook(home, "user-prompt-submit", { ...at, session_id: "s-unrelated", hook_event_name: "UserPromptSubmit", prompt: UNRELATED })).toBe("")
    expect(existsSync(watchPath(home, "s-unrelated"))).toBe(false)
    expect(hook(home, "user-prompt-submit", { ...at, session_id: "s-like", hook_event_name: "UserPromptSubmit", prompt: OTHER_RULE })).toContain("A past change in this repository like your task")
    expect(existsSync(watchPath(home, "s-like"))).toBe(false)

    // A session's watch ends with it.
    expect(hook(home, "user-prompt-submit", { ...at, session_id: "s-ends", hook_event_name: "UserPromptSubmit", prompt: FIX })).toBe("")
    expect(existsSync(watchPath(home, "s-ends"))).toBe(true)
    hook(home, "session-end", { ...at, session_id: "s-ends", hook_event_name: "SessionEnd", reason: "exit" })
    expect(existsSync(watchPath(home, "s-ends"))).toBe(false)

    // And one left behind is swept a day later.
    expect(hook(home, "user-prompt-submit", { ...at, session_id: "s-left", hook_event_name: "UserPromptSubmit", prompt: FIX })).toBe("")
    sweepWatches(home, Date.now() + 25 * 60 * 60 * 1000)
    expect(existsSync(watchPath(home, "s-left"))).toBe(false)
  }, 60_000)
})
