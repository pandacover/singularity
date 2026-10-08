/**
 * What git says about a working directory: which repo it is, and what a file
 * looked like at a commit.
 *
 * A repo is recognized by its root commits, which every clone and fork shares
 * (the eval workspaces have no remote), and by its remotes.
 */
import { Effect, Schema } from "effect"
import { runProcess } from "../eval/Proc.ts"

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
  const r = yield* runProcess("git", args, { cwd, timeoutS: GIT_TIMEOUT_S, env: process.env }).pipe(
    Effect.mapError((e) => new GitError({ message: `git ${args.join(" ")}: ${e.message}` }))
  )
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
