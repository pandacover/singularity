import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord, commitRecordId } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { addGiven, commitsRead, givenPath, listedCommits, namedCommits, readGiven, readsCommits, shellRuns } from "../../src/scripts/History.ts"
import { inlineCode, renderBehind } from "../../src/scripts/Render.ts"
import { HOOK_SCRIPT } from "../../src/setup/Wiring.ts"
import { git, run, tempDir } from "../eval/helpers.ts"
import { bash, session } from "../records/fixtures.ts"

/** The `singularity` command setup puts on PATH. */
const SINGULARITY = fileURLToPath(new URL("../../src/singularity.ts", import.meta.url))

const A = "0123456789abcdef0123456789abcdef01234567"
const B = "89abcdef0123456789abcdef0123456789abcdef"
const C = "fedcba9876543210fedcba9876543210fedcba98"
const header = (hash: string, subject: string) => `commit ${hash}\nAuthor: A <a@example.com>\nDate:   Fri Oct 16 10:00:00 2026 +0000\n\n    ${subject}\n`
const stat = " README.md   | 2 +-\n lib/md062.mjs | 40 ++++++++\n 2 files changed, 41 insertions(+), 1 deletion(-)\n"
const diff = "diff --git a/lib/md062.mjs b/lib/md062.mjs\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/lib/md062.mjs\n@@ -0,0 +1 @@\n+export const md062 = 1\n"

describe("which commits a call read", () => {
  it("reads the commits `git show` heads, one or two, in order", () => {
    expect(commitsRead(`git show --stat HEAD~1 | head -40`, header(A, "Add MD062.") + "\n" + stat)).toEqual({ hashes: [A], revs: [] })
    expect(commitsRead(`git show HEAD~2 -- README.md lib/md062.mjs`, header(A, "Add MD062.") + "\n" + diff)).toEqual({ hashes: [A], revs: [] })
    expect(commitsRead(`git show --stat HEAD~2 HEAD~4 | cat`, header(A, "Add MD063.") + stat + "\n" + header(B, "Add MD062.") + stat))
      .toEqual({ hashes: [A, B], revs: [] })
    // git's own options before the command, a graph, and colors.
    expect(commitsRead(`git -C "C:/work/repo" --no-pager show HEAD`, `\x1b[33mcommit ${A}\x1b[m\nAuthor: A\n`)).toEqual({ hashes: [A], revs: [] })
    expect(commitsRead(`git show --stat --oneline HEAD~1`, `${A.slice(0, 7)} Add MD062.\n${stat}`)).toEqual({ hashes: [A.slice(0, 7)], revs: [] })
  })

  it("takes the hashes and revisions the command names when the output lists none", () => {
    expect(commitsRead(`git show 8a4ba047a3 -- doc-src/md064.md | tail -30`, "+more\n+lines\n")).toEqual({ hashes: ["8a4ba047a3"], revs: [] })
    expect(commitsRead(`git show HEAD~2 -- lib/md063.mjs | tail -5`, "+x\n")).toEqual({ hashes: [], revs: ["HEAD~2"] })
    // A file read at a commit isn't a reading of its change; nor is a word, or a part of a path.
    expect(commitsRead(`git show 8a4ba047a3:lib/md064.mjs`, "export const x = 1\n")).toBeUndefined()
    expect(commitsRead(`git show HEAD:package.json`, "{}\n")).toBeUndefined()
    expect(namedCommits(`git show deadbeef -- build/0123abcd9/x.js`)).toEqual({ hashes: [], revs: [] })
    // `@` is git's short name for HEAD; an email, a reflog entry and an upstream name no commit read.
    expect(commitsRead(`git show @~1 -- lib/md063.mjs | tail -5`, "+x\n")).toEqual({ hashes: [], revs: ["@~1"] })
    expect(namedCommits(`git show @ --stat`)).toEqual({ hashes: [], revs: ["@"] })
    expect(namedCommits(`git log -p --author=me@example.com HEAD@{1} @{u}`)).toEqual({ hashes: [], revs: [] })
  })

  it("reads what a command runs, not what it mentions", () => {
    // A pull request or a commit message that names `git show` and a hash reads nothing (2026-10-24).
    const pr = "gh pr create --base main --title \"Lean hand-over\" --body-file - <<'EOF'\nThe `git show` add-on: `changes 4318912` printed 9,734 characters.\nEOF"
    expect(commitsRead(pr, "https://github.com/pandacover/singularity/pull/45\n")).toBeUndefined()
    expect(commitsRead("git commit -m \"see git show 4318912\"", "[main 1a2b3c4] see git show 4318912\n 1 file changed, 2 insertions(+)\n")).toBeUndefined()
    expect(commitsRead("git commit -m \"$(cat <<'EOF'\nUse git show 4318912 to read it\nEOF\n)\"", " 1 file changed, 2 insertions(+)\n")).toBeUndefined()
    expect(commitsRead("echo 'run git show 4318912' > notes.md", "")).toBeUndefined()
    // The commit comes from the git command's own arguments, not from anything else on the line.
    expect(commitsRead("echo 1234567 && git show HEAD~1 -- lib/md062.mjs | tail -3", "+x\n")).toEqual({ hashes: [], revs: ["HEAD~1"] })
    // A run beside a mention is still a reading, and a quoted path for git -C is still an argument.
    expect(commitsRead("git log --oneline -1 --grep 'git show' && git show 8a4ba047a3 -- a.md | tail -3", "+x\n")).toEqual({ hashes: ["8a4ba047a3"], revs: [] })
    expect(commitsRead("git -C 'my repo' show 8a4ba047a3 -- a.md | tail -3", "+x\n")).toEqual({ hashes: ["8a4ba047a3"], revs: [] })
    // A heredoc's body ends at its word, tabs before it with `<<-`; what comes after runs.
    expect(shellRuns("cat > a.sh <<-EOF\n\tgit show HEAD\n\tEOF\ngit show 8a4ba047a3")).toBe("cat > a.sh <<''\ngit show 8a4ba047a3")
  })

  it("reads a command continued over lines as one", () => {
    // bash's backslash and PowerShell's backtick at a line's end.
    expect(commitsRead("git \\\n  log -1 --stat", header(A, "Add MD062.") + "\n" + stat)).toEqual({ hashes: [A], revs: [] })
    expect(commitsRead("git -C C:/work/repo `\r\n  show HEAD~1 -- lib/md062.mjs | Select-Object -Last 5", "+x\n")).toEqual({ hashes: [], revs: ["HEAD~1"] })
    // The tool-call hook's input as a whole, JSON, where the newline arrives written `\n`.
    const stdin = JSON.stringify({
      session_id: "s", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "git \\\n  log -1 --stat" }, tool_response: { stdout: header(A, "Add MD062.") + "\n" + stat }
    })
    expect(stdin).not.toContain("\n")
    expect(readsCommits(stdin)).toBe(true)
  })

  it("leaves out surveys, logs without a change, and other git commands", () => {
    // Three commits at once is a look around the history.
    expect(commitsRead(`git log -3 --stat`, [A, B, C].map((h) => header(h, "x") + stat).join("\n"))).toBeUndefined()
    // A list of subjects shows no change.
    expect(commitsRead(`git log --oneline -1`, `${A.slice(0, 7)} Add MD062.\n`)).toBeUndefined()
    expect(commitsRead(`git log -1`, header(A, "Add MD062."))).toBeUndefined()
    // One commit's change through git log is a reading.
    expect(commitsRead(`git log -1 --stat -- lib/md062.mjs`, header(A, "Add MD062.") + "\n" + stat)).toEqual({ hashes: [A], revs: [] })
    // In a chain, the commit git show heads, not the subjects listed before it.
    const chained = [A, B, C].map((h) => `${h.slice(0, 7)} subject`).join("\n") + "\n" + header(B, "Add MD062.") + stat
    expect(commitsRead(`git log --oneline -3; git show --stat HEAD~1`, chained)).toEqual({ hashes: [B], revs: [] })
    expect(commitsRead(`git show-ref`, `${A} refs/heads/main\n`)).toBeUndefined()
    expect(commitsRead(`git status`, "")).toBeUndefined()
    expect(commitsRead(`cat notes.md`, header(A, "x") + stat)).toBeUndefined()
  })

  it("reads lines a diff or a commit message starts as neither", () => {
    // A commit message is indented; a stat line starts with a space; a diff line with its mark.
    expect(listedCommits(header(A, "Revert 89abcdef0123 by hand.") + "\n" + stat + diff)).toEqual([A])
  })
})

describe("what git doesn't show", () => {
  const RULE = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done."
  it("gives the commands, and the request only when the commit message says too little; never the diff or mistakes", () => {
    const text = renderBehind({ commit: A, prompt: RULE, message: "MD061", commands: ["npm test", "npm run lint"] })!
    expect(text).toContain(`# What git doesn't show about ${A.slice(0, 10)}`)
    expect(text).toContain(`Memory kept the session that made ${A.slice(0, 10)}, which you just read in git: what it was asked and the project commands it ran.`)
    expect(text).toContain("## What it was asked\n\n" + RULE)
    expect(text).toContain("## Project commands it ran, in order\n\n`npm test`, `npm run lint`")
    expect(text).not.toMatch(/diff|Mistakes/)
    // Its commit message says what it was for, and git shows that.
    const SAID = "Add the heading-max-level rule MD061, with its docs, schema and tests"
    const said = renderBehind({ commit: A, prompt: RULE, message: SAID, commands: ["npm test"] })!
    expect(said).not.toContain("## What it was asked")
    expect(said).toContain("which you just read in git: the project commands it ran.")
    // Filed under "yes": nothing was asked.
    expect(renderBehind({ commit: A, prompt: "yes", commands: ["npm test"] })).not.toContain("## What it was asked")
    expect(renderBehind({ commit: A, prompt: "commit and open a PR", commands: [] })).toBeUndefined()
    expect(renderBehind({ commit: A, prompt: RULE, message: SAID, commands: [] })).toBeUndefined()
  })

  it("fences a command with backticks in it with more of them", () => {
    expect(inlineCode("npm test")).toBe("`npm test`")
    expect(inlineCode("Write-Output \"a`tb\"")).toBe("``Write-Output \"a`tb\"``")
    expect(inlineCode("echo `date`")).toBe("`` echo `date` ``")
    expect(renderBehind({ commit: A, prompt: "yes", commands: ["npm test", "echo `date`"] }))
      .toContain("## Project commands it ran, in order\n\n`npm test`, `` echo `date` ``")
  })
})

describe("what a session was given", () => {
  it("notes each commit once", () => {
    const path = givenPath(tempDir(), "s")
    expect(readGiven(path)).toEqual([])
    addGiven(path, A)
    addGiven(path, A)
    addGiven(path, B)
    expect(readGiven(path)).toEqual([A, B])
  })
})

const write = (repo: string, file: string, text: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), text)
}

/** Store the change base..head, whose session ran `npm test`, saw it fail, and ran it again. */
const storeChange = (repo: string, tenantDir: string, prompt: string, base: string, head: string) =>
  run(Effect.gen(function*() {
    const store = yield* RecordStore
    const subject = yield* store.subjectFor((yield* identifyRepo(repo))!, { create: true })
    yield* store.put(buildRecord({
      id: commitRecordId(subject!.id, head),
      tenant: "local",
      subject: subject!.id,
      trace: session(prompt, [
        [bash("npm test", "Error: MD061 expected 2 errors, got 1\nnpm ERR! Test failed.", true)],
        [bash("npm test", "ok")]
      ], repo),
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

describe("reading a stored commit, through the hooks", () => {
  it("adds what git doesn't show once a session, never to the session that made it or one already given it", async () => {
    const root = tempDir()
    const repo = join(root, "repo")
    const home = join(root, "home")
    mkdirSync(repo, { recursive: true })
    git(repo, "init", "-q")
    write(repo, "lib/rules.mjs", "export const rules = []\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "start")
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", "export const md061 = (params, onError) => {\n  const maximum = params.config.maximum ?? 6\n}\n")
    git(repo, "add", "-A")
    // A change is found by its commit message (records/Task.ts `taskKeys`).
    git(repo, "commit", "-qm", "Add the built-in rule MD061/heading-max-level the way the existing rules are done: documentation, README, config schema, tests and snapshots.")
    const head = git(repo, "rev-parse", "HEAD")
    const tenantDir = join(home, "tenants", "local")
    const RULE ="Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
    await storeChange(repo, tenantDir, RULE, base, head)

    // git's own output, whatever this machine's git config says about colors and formats.
    const gitOutput = (command: string) =>
      spawnSync("git", ["-C", repo, "-c", "color.ui=never", "-c", "format.pretty=medium", ...command.replace(/^git /, "").split(" ")], { encoding: "utf-8" }).stdout
    const read = (session_id: string, command: string, stdout = gitOutput(command)) =>
      hook(home, "post-tool-use", { session_id, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "" } })

    const s = "cccccccc-0000-0000-0000-000000000001"
    const out = read(s, `git show ${head.slice(0, 10)}`)
    const context = JSON.parse(out).hookSpecificOutput as { hookEventName: string; additionalContext: string }
    expect(context.hookEventName).toBe("PostToolUse")
    expect(context.additionalContext).toContain(`# What git doesn't show about ${head.slice(0, 10)}`)
    expect(context.additionalContext).toContain("## Project commands it ran, in order\n\n`npm test`")
    // Its commit message says what it was for: what was asked isn't said again, nor the failed `npm test`.
    expect(context.additionalContext).not.toContain(RULE)
    expect(context.additionalContext).not.toMatch(/Mistakes|diff --git/)
    // Once a session.
    expect(read(s, `git show --stat ${head.slice(0, 10)}`)).toBe("")
    // A commit memory didn't store, a list of subjects, and a failed call: nothing.
    expect(read("cccccccc-0000-0000-0000-000000000002", `git show ${base.slice(0, 10)}`)).toBe("")
    expect(read("cccccccc-0000-0000-0000-000000000002", "git log --oneline")).toBe("")
    expect(hook(home, "post-tool-use", {
      session_id: "cccccccc-0000-0000-0000-000000000002", cwd: repo, hook_event_name: "PostToolUseFailure", tool_name: "Bash",
      tool_input: { command: `git show ${head.slice(0, 10)}` }, error: "fatal: bad object"
    })).toBe("")
    // The output cut before its header: the revision the command names.
    expect(read("cccccccc-0000-0000-0000-000000000003", "git show HEAD -- lib/md061.mjs | tail -3", "+  const maximum = params.config.maximum ?? 6\n+}\n")).toContain("# What git doesn't show about")
    // A command continued over lines.
    const continued = "cccccccc-0000-0000-0000-000000000006"
    expect(read(continued, `git \\\n  show --stat ${head.slice(0, 10)}`, gitOutput(`git show --stat ${head.slice(0, 10)}`))).toContain("# What git doesn't show about")
    // The session that made it isn't told about its own commit.
    expect(read("11111111-2222-3333-4444-555555555555", `git show ${head.slice(0, 10)}`)).toBe("")
    // A session handed the change at its start isn't given it again.
    const started = "cccccccc-0000-0000-0000-000000000004"
    const OTHER_RULE = "Add a new built-in rule MD062, alias `code-block-max-lines`, with parameters `maximum` and `ignore_languages`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
    expect(hook(home, "user-prompt-submit", { session_id: started, cwd: repo, hook_event_name: "UserPromptSubmit", prompt: OTHER_RULE })).toContain("A past change in this repository like your task")
    expect(read(started, `git show ${head.slice(0, 10)}`)).toBe("")
    // Nor one whose agent ran recall and got it (`recall "…"; git show HEAD~1`): Claude Code tells its commands the session.
    const recalled = "cccccccc-0000-0000-0000-000000000005"
    const recall = spawnSync(process.execPath, [SINGULARITY, "recall", "add a new built-in rule"], {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, SINGULARITY_HOME: home, SINGULARITY_HOOKS: "off", CLAUDE_CODE_SESSION_ID: recalled }
    })
    expect(recall.stdout).toContain(`committed as ${head.slice(0, 10)}`)
    expect(read(recalled, `git show ${head.slice(0, 10)}`)).toBe("")

    const log = readFileSync(join(tenantDir, "workflows", "handovers.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.filter((l) => l.moment === "git").map((l) => [l.session_id, l.picked?.commit ?? null]))
      .toEqual([[s, head], ["cccccccc-0000-0000-0000-000000000003", head], [continued, head]])
  }, 60_000)

  it("adds it for a commit inside a stored change of several, and not for one before or after it", async () => {
    const root = tempDir()
    const repo = join(root, "repo")
    const home = join(root, "home")
    mkdirSync(repo, { recursive: true })
    git(repo, "init", "-q")
    write(repo, "lib/rules.mjs", "export const rules = []\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "start")
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", "export const md061 = () => {}\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "Add MD061")
    const inside = git(repo, "rev-parse", "HEAD")
    write(repo, "test/md061.test.mjs", "test('md061', () => {})\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "Test MD061")
    const head = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/later.mjs", "export const later = 1\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "Later")
    const later = git(repo, "rev-parse", "HEAD")
    const RULE = "Add a new built-in rule MD061 with its test"
    await storeChange(repo, join(home, "tenants", "local"), RULE, base, head)

    const read = (session_id: string, hash: string) => {
      const stdout = spawnSync("git", ["-C", repo, "-c", "color.ui=never", "show", "--stat", hash], { encoding: "utf-8" }).stdout
      return hook(home, "post-tool-use", { session_id, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `git show --stat ${hash.slice(0, 10)}` }, tool_response: { stdout, stderr: "" } })
    }
    const out = read("dddddddd-0000-0000-0000-000000000001", inside)
    expect(out).toContain(`# What git doesn't show about ${head.slice(0, 10)}`)
    expect(out).toContain(RULE)
    expect(read("dddddddd-0000-0000-0000-000000000002", later)).toBe("")
    expect(read("dddddddd-0000-0000-0000-000000000003", base)).toBe("")
  }, 60_000)
})
