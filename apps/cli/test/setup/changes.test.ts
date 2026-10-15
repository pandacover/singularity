import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { identifyRepo } from "../../src/local/Git.ts"
import { buildRecord } from "../../src/records/Build.ts"
import * as JsonRecordStore from "../../src/records/JsonRecordStore.ts"
import { RecordStore } from "../../src/records/RecordStore.ts"
import { retire } from "../../src/scripts/Retired.ts"
import { renderStored } from "../../src/scripts/Start.ts"
import { findChange, gatherChanges, renderChange, renderChanges } from "../../src/setup/Changes.ts"
import { bash, session } from "../records/fixtures.ts"
import { git, run, tempDir } from "../eval/helpers.ts"

/** A repo with two committed changes stored and the second retired, and a third stored whose commit this clone lacks. */
const setUp = () => {
  const root = tempDir()
  const repo = join(root, "repo")
  const tenantDir = join(root, "home", "tenants", "local")
  git(root, "init", "-q", "repo")
  writeFileSync(join(repo, "a.txt"), "one\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "start")
  const commits: Array<{ base: string; head: string }> = []
  for (const [file, title, date] of [["b.txt", "Add b", "2026-10-15T10:00:00Z"], ["c.txt", "Add c", "2026-10-15T11:00:00Z"]]) {
    const base = git(repo, "rev-parse", "HEAD")
    writeFileSync(join(repo, file), `${file}\n`)
    git(repo, "add", ".")
    process.env.GIT_COMMITTER_DATE = date
    try {
      git(repo, "commit", "-qm", title)
    } finally {
      delete process.env.GIT_COMMITTER_DATE
    }
    commits.push({ base, head: git(repo, "rev-parse", "HEAD") })
  }
  const store = Effect.gen(function*() {
    const store = yield* RecordStore
    const subject = (yield* store.subjectFor((yield* identifyRepo(repo))!, { create: true }))!
    const put = (prompt: string, c: { base: string; head: string }, diff: string) =>
      store.put(buildRecord({
        tenant: "local",
        subject: subject.id,
        id: `${subject.id}-${c.head.slice(0, 12)}`,
        trace: session(prompt, [[bash("npm test", "ok")]], repo),
        diff,
        outcome: "success",
        checks: [{ command: "npm test", ok: true, exit_code: 0 }],
        memory: null,
        run: {
          source: "session", log: "s.jsonl", run_dir: null, run_id: null, setup: null, task_id: null,
          repo, base_commit: c.base, head_commit: c.head, started_at: null, cost_usd: null, tokens: null
        },
        createdAt: "2026-10-14T12:00:00Z"
      }))
    // The second holds both commits, as a session's follow-up folded in does.
    yield* put("please add file 0", commits[0], git(repo, "diff", commits[0].base, commits[0].head))
    yield* put("please add file 1", { base: commits[0].base, head: commits[1].head }, git(repo, "diff", commits[0].base, commits[1].head))
    yield* put("from another clone", { base: commits[1].head, head: "f".repeat(40) }, "")
    yield* retire(tenantDir, [{ id: `${subject.id}-${commits[1].head.slice(0, 12)}`, commit: commits[1].head, reason: "reverted by 0123456789ab", at: "2026-10-15T00:00:00Z" }])
    return subject.id
  })
  return { root, repo, tenantDir, commits, store }
}

describe("singularity changes", () => {
  it.effect("lists a repo's stored changes newest first, with titles from git and what was retired", () =>
    Effect.promise(() => {
      const t = setUp()
      return run(Effect.gen(function*() {
        const subject = yield* t.store
        const report = yield* gatherChanges({ cwd: t.repo, tenantDir: t.tenantDir })
        expect(report.repo?.id).toBe(subject)
        expect(report.changes.map((c) => c.title)).toEqual(["Add c", "Add b", null])
        expect(report.changes[0].retired?.reason).toBe("reverted by 0123456789ab")
        expect(report.changes[1].retired).toBeNull()
        expect(report.changes[1].files).toEqual([{ path: "b.txt", status: "added", added: 1, removed: 0 }])
        expect(report.changes[2].task).toBe("from another clone")
        expect(report.changes.map((c) => c.commits)).toEqual([2, 1, null])

        const text = renderChanges(report, { color: false }).join("\n")
        expect(text).toContain("3 changes stored in repo (1 retired)")
        expect(text).toMatch(new RegExp(`${t.commits[1].head.slice(0, 10)}  Add c .*2 files \\+2 -0 in 2 commits +retired: reverted by 0123456789ab`))
        expect(text).toMatch(/ffffffffff {2}from another clone .*commit not in this clone/)

        // By name from anywhere, and nothing for a folder memory doesn't know.
        expect((yield* gatherChanges({ cwd: t.root, repo: subject, tenantDir: t.tenantDir })).changes).toHaveLength(3)
        const elsewhere = yield* gatherChanges({ cwd: t.root, tenantDir: t.tenantDir })
        expect(elsewhere.repo).toBeNull()
        expect(renderChanges(elsewhere, { color: false }).join("\n")).toContain(`Memory has changes for ${subject}`)
      }).pipe(Effect.provide(JsonRecordStore.layer(t.tenantDir, "local"))))
    }))

  it.effect("prints one change as an agent would read it, found by its commit", () =>
    Effect.promise(() => {
      const t = setUp()
      return run(Effect.gen(function*() {
        const subject = yield* t.store
        const report = yield* gatherChanges({ cwd: t.repo, tenantDir: t.tenantDir })
        expect(findChange(report.changes, t.commits[0].head.slice(0, 7)).map((c) => c.title)).toEqual(["Add b"])
        expect(findChange(report.changes, `${subject}-${t.commits[0].head.slice(0, 12)}`)).toHaveLength(1)
        expect(findChange(report.changes, "ff")).toEqual([])
        expect(findChange(report.changes, "ffff").map((c) => c.task)).toEqual(["from another clone"])

        const [b] = findChange(report.changes, t.commits[0].head)
        const text = yield* renderStored(t.repo, t.tenantDir, yield* (yield* RecordStore).get(b.id))
        expect(text).toContain("please add file 0")
        expect(text).toContain("+b.txt")
        const shown = renderChange(b, text, { color: false, subject }).join("\n")
        expect(shown).toContain("Add b")
        expect(shown).toContain("1 file +1 -0 · 1 check passed")

        // Retired changes still show; one whose commit isn't here says so.
        const [c] = findChange(report.changes, t.commits[1].head)
        expect(renderChange(c, undefined, { color: false, subject }).join("\n")).toContain("retired: reverted by 0123456789ab")
        const [gone] = findChange(report.changes, "ffff")
        expect(yield* renderStored(t.repo, t.tenantDir, yield* (yield* RecordStore).get(gone.id))).toBeUndefined()
      }).pipe(Effect.provide(JsonRecordStore.layer(t.tenantDir, "local"))))
    }))
})
