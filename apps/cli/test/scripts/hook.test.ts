/**
 * The task-start hook, run as Claude Code runs it: which prompts start a
 * task, and what a task's start hands over (a pointer to the stored change
 * most like it, and the repo's card of check scripts), once a session.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { writeFacts } from "../../src/facts/Index.ts"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord, commitRecordId } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { HOOK_SCRIPT } from "../../src/setup/Wiring.ts"
import { git, run, tempDir } from "../eval/helpers.ts"
import { bash, type CallSpec, session } from "../records/fixtures.ts"

const RULE = "Add a new built-in rule MD061, alias `heading-max-level`, with one parameter `maximum`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
const OTHER_RULE = "Add a new built-in rule MD062, alias `code-block-max-lines`, with parameters `maximum` and `ignore_languages`. Do it the way the existing rules are done: documentation, README, config schema, tests and snapshots."
/** What the stored change's commit said: a change is found by its commit message (records/Task.ts `taskKeys`). */
const RULE_MESSAGE = "Add rule MD061, heading-max-level, the way existing rules are done\n\nDocumentation, README, config schema, tests and snapshots."
const RULE_TITLE = "Add rule MD061, heading-max-level, the way existing rules are done"
/** Like no stored task at all. */
const UNRELATED = "Make the settings page scroll on small windows, and keep its header in view."
const LIKE = "# A past change in this repository like your task"
const CARD = "# Check scripts earlier sessions here ran"
/** The session the stored change came from (records/fixtures.ts `session`). */
const ITS_SESSION = "11111111-2222-3333-4444-555555555555"

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

let stored = 0

/** Store the change base..head as a record with `prompt`, its session having run `calls`; then the repo's fact index. */
const storeChange = (
  repo: string,
  tenantDir: string,
  prompt: string,
  base: string,
  head: string,
  calls: Array<CallSpec> = [bash("npm test", "ok")],
  message = RULE_MESSAGE
) =>
  run(Effect.gen(function*() {
    const store = yield* RecordStore
    const subject = yield* store.subjectFor((yield* identifyRepo(repo))!, { create: true })
    yield* store.put(buildRecord({
      id: commitRecordId(subject!.id, head),
      tenant: "local",
      subject: subject!.id,
      trace: session(prompt, calls.map((c) => [c]), repo),
      diff: git(repo, "diff", base, head),
      outcome: "success",
      checks: [],
      memory: null,
      run: {
        source: "session", log: "s.jsonl", run_dir: null, run_id: null, setup: null, task_id: null,
        repo, base_commit: base, head_commit: head, started_at: null, cost_usd: null, tokens: null
      },
      // Each change stored later than the one before, as commits are.
      createdAt: new Date(Date.UTC(2026, 9, 14, 12, 0, stored++)).toISOString(),
      message
    }))
    yield* writeFacts(tenantDir, subject!.id, repo)
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

const context = (out: string): string => (out === "" ? "" : (JSON.parse(out).hookSpecificOutput as { additionalContext: string }).additionalContext)

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

describe("what a task's start hands over", () => {
  it("points to the change without its diff, adds the card of check scripts on disk, and gives each once a session", async () => {
    const { root, repo, home } = newRepo()
    const tenantDir = join(home, "tenants", "local")
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", "export const md061 = (params, onError) => {\n  const maximum = params.config.maximum ?? 6\n}\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD061")
    const head = git(repo, "rev-parse", "HEAD")
    // A check script outside git, which two changes' sessions ran after their build.
    const script = join(root, "checks", "ui-check.mjs").replace(/\\/g, "/")
    write(root, "checks/ui-check.mjs", "console.log('PASS')\n")
    const checked = [bash("npm run build", "ok"), bash(`npm run build && node "${script}" out`, "PASS"), bash("npm test", "ok")]
    // And one only the MD061 change's session wrote for it, in the same line as the script itself.
    const own = join(root, "checks", "rule-check.mjs").replace(/\\/g, "/")
    write(root, "checks/rule-check.mjs", "console.log('PASS')\n")
    const code = Array.from({ length: 30 }, (_, i) => `console.log("case ${i}")`).join("\n")
    await storeChange(repo, tenantDir, RULE, base, head, [...checked, bash(`cat > "${own}" <<'EOF'\n${code}\nEOF\nnode "${own}"`, "PASS")])
    write(repo, "lib/loader.mjs", "export const load = () => []\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "loader")
    const later = git(repo, "rev-parse", "HEAD")
    await storeChange(repo, tenantDir, "Load the rules in the order the config lists them, and test that order.", head, later, checked, "Load rules in config order")

    const say = (session_id: string, prompt: string) => context(hook(home, "user-prompt-submit", { session_id, cwd: repo, hook_event_name: "UserPromptSubmit", prompt }))
    const s = "dddddddd-0000-0000-0000-000000000001"
    const first = say(s, OTHER_RULE)
    expect(first).toContain(LIKE)
    expect(first).toContain(`committed as ${head.slice(0, 10)}: "${RULE_TITLE}"`)
    expect(first).toContain(`\`git show ${head.slice(0, 10)}\``)
    expect(first).toContain("- lib/md061.mjs (+3 -0)")
    expect(first).not.toContain("diff --git")
    expect(first).toContain(CARD)
    // The pointed-to change's scripts first, the strongest first, the one only it ran too.
    const lines = first.slice(first.indexOf(CARD)).split("\n").filter((l) => l.startsWith("- "))
    expect(lines).toEqual([
      `- \`npm run build; node "${script}" out\` (2 changes, last ${later.slice(0, 10)} "Load rules in config order")`,
      `- \`node "${own}"\` (1 change, last ${head.slice(0, 10)} "${RULE_TITLE}")`
    ])
    // Not the project's own checks: agents run them anyway.
    expect(first).not.toContain("`npm test`")

    // The next task of the session: the pointer again, the card not, since its facts haven't changed.
    write(repo, "lib/md062.mjs", "export const md062 = 1\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD062")
    const second = say(s, OTHER_RULE)
    expect(second).toContain(LIKE)
    expect(second).not.toContain(CARD)

    // A task like no stored one: the card alone.
    const alone = say("dddddddd-0000-0000-0000-000000000002", UNRELATED)
    expect(alone).not.toContain(LIKE)
    expect(alone.startsWith(CARD)).toBe(true)
    // Pointed to nothing, a script one change ran isn't on it.
    expect(alone).not.toContain("rule-check.mjs")
    // The session that made the change gets nothing of its own.
    expect(say(ITS_SESSION, OTHER_RULE)).toBe("")
    // The script gone from disk: nothing worth sending.
    rmSync(join(root, "checks"), { recursive: true })
    expect(say("dddddddd-0000-0000-0000-000000000003", UNRELATED)).toBe("")

    const log = readFileSync(join(tenantDir, "workflows", "handovers.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.map((l) => [l.session_id, l.picked?.commit ?? null, l.facts.length])).toEqual([
      [s, head, 2],
      [s, head, 0],
      ["dddddddd-0000-0000-0000-000000000002", null, 1],
      [ITS_SESSION, null, 0],
      ["dddddddd-0000-0000-0000-000000000003", null, 0]
    ])
  }, 60_000)
})

/** Run the hook script with `args` (an event, and its flags), as an eval run's own hook; `env` on top of this one's. */
const hookWith = (home: string, args: Array<string>, input: Record<string, unknown>, env: Record<string, string> = {}) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(k.toUpperCase() === "PATH" && "PATH" in env)))
  const done = spawnSync(process.execPath, [HOOK_SCRIPT, ...args, "--eval-run"], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...base, SINGULARITY_HOME: home, SINGULARITY_HOOKS: "off", ...env }
  })
  expect(done.status).toBe(0)
  const errors = join(home, "hook-errors.log")
  expect(existsSync(errors) ? readFileSync(errors, "utf-8") : "").toBe("")
  return done.stdout
}

/** A PATH with git on it and no agent's command. */
const gitOnly = () =>
  (process.env.PATH ?? process.env.Path ?? "").split(delimiter)
    .filter((d) => d !== "" && existsSync(join(d, process.platform === "win32" ? "git.exe" : "git")))
    .join(delimiter)

describe("a model's pick at a task's start", () => {
  it("leaves the change to the background pick when a model picks, and picks by words when the model can't be asked", async () => {
    const { repo, home } = newRepo()
    const tenantDir = join(home, "tenants", "local")
    const base = git(repo, "rev-parse", "HEAD")
    write(repo, "lib/md061.mjs", "export const md061 = (params, onError) => {\n  const maximum = params.config.maximum ?? 6\n}\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "MD061")
    const head = git(repo, "rev-parse", "HEAD")
    await storeChange(repo, tenantDir, RULE, base, head)
    const config = (picks: unknown) => writeFileSync(join(home, "config.json"), JSON.stringify({ tenant: "local", picks }))
    config({ agent: "claude", model: "haiku" })
    const input = (session_id: string) => ({ session_id, cwd: repo, hook_event_name: "UserPromptSubmit", prompt: OTHER_RULE })

    const s = "eeeeeeee-0000-0000-0000-000000000001"
    // Beside the pick, the start's hook leaves the change out: here that's all it had.
    expect(hookWith(home, ["user-prompt-submit", "--picks"], input(s))).toBe("")
    // An agent with no pick beside its hook gets word search's pointer.
    expect(context(hookWith(home, ["user-prompt-submit"], input("eeeeeeee-0000-0000-0000-000000000002")))).toContain(LIKE)
    // The pick, with Claude Code's command nowhere on PATH: word search picks instead, once a task.
    const picked = context(hookWith(home, ["user-prompt-pick"], input(s), { PATH: gitOnly() }))
    expect(picked).toContain(LIKE)
    expect(picked).toContain(`committed as ${head.slice(0, 10)}`)
    expect(hookWith(home, ["user-prompt-pick"], input(s), { PATH: gitOnly() })).toBe("")
    const log = readFileSync(join(tenantDir, "workflows", "handovers.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    const pick = log.find((l) => l.moment === "pick")
    expect(pick).toMatchObject({ session_id: s, by: "words", model: "haiku", picked: { commit: head } })
    expect(pick.error).toContain("isn't on PATH")
    // A prompt that asks for nothing starts no pick.
    expect(hookWith(home, ["user-prompt-pick"], { ...input("eeeeeeee-0000-0000-0000-000000000003"), prompt: "yes, go ahead" })).toBe("")
    // Word search chosen at setup: the pick says nothing, and the start's hook hands the change over itself.
    config(null)
    const t = "eeeeeeee-0000-0000-0000-000000000004"
    expect(hookWith(home, ["user-prompt-pick"], input(t))).toBe("")
    expect(context(hookWith(home, ["user-prompt-submit", "--picks"], input(t)))).toContain(LIKE)
  }, 60_000)
})
