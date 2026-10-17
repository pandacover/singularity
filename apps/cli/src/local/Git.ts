/**
 * What git says about a working directory: which repo it is, and what a file
 * looked like at a commit.
 *
 * A repo is recognized by its root commits, which every clone and fork shares
 * (the eval workspaces have no remote), and by its remotes.
 */
import { Effect, Schema } from "effect"
import { runQuick } from "../eval/Proc.ts"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String
}) {}

export interface RepoIdentity {
  /** The working tree's top directory. */
  readonly root: string
  readonly rootCommits: ReadonlyArray<string>
  /** Remote URLs without protocol, user or `.git`: `github.com/excalidraw/excalidraw`. */
  readonly remotes: ReadonlyArray<string>
  readonly head: string | undefined
}

const GIT_TIMEOUT_S = 60

/** Run git in `cwd`; fails on a nonzero exit. */
export const git = Effect.fn("git")(function*(cwd: string, args: ReadonlyArray<string>) {
  const r = yield* runQuick("git", args, { cwd, timeoutS: GIT_TIMEOUT_S, env: process.env })
  if (r.exitCode !== 0) {
    return yield* new GitError({ message: `git ${args.join(" ")}: ${r.timedOut ? "timed out" : r.stderr.trim()}` })
  }
  return r.stdout
})

/** `https://user@github.com/a/b.git` and `git@github.com:a/b.git` both become `github.com/a/b`. */
export const normalizeRemote = (url: string): string =>
  url.trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase()

/** The repo `cwd` is in, or undefined outside a git repo (or without git). */
export const identifyRepo = Effect.fn("identifyRepo")(function*(cwd: string) {
  const top = yield* git(cwd, ["rev-parse", "--show-toplevel"]).pipe(Effect.option)
  if (top._tag === "None") return undefined
  const root = top.value.trim()
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  const rootCommits = yield* git(root, ["rev-list", "--max-parents=0", "HEAD"]).pipe(
    Effect.map(lines),
    Effect.orElseSucceed(() => [] as Array<string>)
  )
  const remotes = yield* git(root, ["remote", "-v"]).pipe(
    Effect.map((s) => [...new Set(lines(s).map((l) => normalizeRemote(l.split(/\s+/)[1] ?? "")).filter((r) => r !== ""))]),
    Effect.orElseSucceed(() => [] as Array<string>)
  )
  const head = yield* git(root, ["rev-parse", "HEAD"]).pipe(
    Effect.map((s) => s.trim()),
    Effect.orElseSucceed(() => undefined)
  )
  return { root, rootCommits: rootCommits.sort(), remotes, head } satisfies RepoIdentity
})

/** A file's text at a commit, or undefined if it didn't exist there. Line endings normalized to `\n`. */
export const fileAt = Effect.fn("fileAt")(function*(repo: string, commit: string, file: string) {
  return yield* git(repo, ["show", `${commit}:${file.replace(/\\/g, "/")}`]).pipe(
    Effect.map((s) => s.replace(/\r\n?/g, "\n")),
    Effect.orElseSucceed(() => undefined)
  )
})

/** Whether `commit` exists in the repo. */
export const hasCommit = (repo: string, commit: string) =>
  git(repo, ["cat-file", "-e", `${commit}^{commit}`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

/**
 * The messages of the commits (full hashes) the repo has, by hash, in two git
 * calls however many there are: `cat-file --batch-check` says which exist,
 * since `git log` stops at the first it lacks. Lacking ones have none.
 */
export const commitMessages = Effect.fn("commitMessages")(function*(repo: string, commits: ReadonlyArray<string>) {
  const out = new Map<string, string>()
  const wanted = [...new Set(commits)]
  if (wanted.length === 0) return out
  const run = (args: ReadonlyArray<string>, input: string) => runQuick("git", args, { cwd: repo, timeoutS: GIT_TIMEOUT_S, env: process.env, input })
  const check = yield* run(["cat-file", "--batch-check"], wanted.join("\n") + "\n")
  const present = check.stdout.split(/\r?\n/).map((l) => l.split(" ")).filter((p) => p[1] === "commit").map((p) => p[0])
  if (check.exitCode !== 0 || present.length === 0) return out
  const log = yield* run(["log", "--no-walk=unsorted", "--stdin", "--format=%H%x1f%B%x1e"], present.join("\n") + "\n")
  if (log.exitCode !== 0) return out
  for (const chunk of log.stdout.split("\x1e")) {
    const at = chunk.indexOf("\x1f")
    if (at > 0) out.set(chunk.slice(0, at).trim(), chunk.slice(at + 1))
  }
  return out
})
