/**
 * A disposable clone of the suite repo that every run starts from.
 *
 * The clone has no remote, so nothing the agent does (e.g. `git push`) can
 * reach the source repo. Reset deletes everything untracked except `keep`
 * paths, so expensive setup like node_modules survives between runs.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { runProcess } from "./Proc.ts"

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String
}) {}

export interface Workspace {
  readonly source: string
  readonly path: string
  readonly keep: ReadonlyArray<string>
}

export const makeWorkspace = (source: string, path: string, keep: ReadonlyArray<string> = []): Workspace => ({
  source,
  path,
  keep
})

const GIT_TIMEOUT_S = 600

const git = Effect.fn("Workspace.git")(function*(cwd: string | undefined, args: ReadonlyArray<string>, input?: string) {
  const fullArgs = cwd === undefined ? args : ["-C", cwd, ...args]
  const r = yield* runProcess("git", fullArgs, { cwd: cwd ?? ".", timeoutS: GIT_TIMEOUT_S, env: process.env, input }).pipe(
    Effect.mapError((e) => new WorkspaceError({ message: `git ${fullArgs.join(" ")} failed to start: ${e.message}` }))
  )
  if (r.exitCode !== 0) {
    const why = r.timedOut ? "timed out" : r.stderr.trim()
    return yield* new WorkspaceError({ message: `git ${fullArgs.join(" ")} failed: ${why}` })
  }
  return r.stdout
})

/** Full commit sha for `ref` in the source repo. */
export const resolveRef = (ws: Workspace, ref: string) =>
  git(ws.source, ["rev-parse", "--verify", `${ref}^{commit}`]).pipe(Effect.map((s) => s.trim()))

/** Check out `sha` in a clean state, cloning the workspace first if needed. */
export const resetWorkspace = Effect.fn("resetWorkspace")(function*(ws: Workspace, sha: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!(yield* fs.exists(path.join(ws.path, ".git")))) {
    if ((yield* fs.exists(ws.path)) && (yield* fs.readDirectory(ws.path)).length > 0) {
      return yield* new WorkspaceError({ message: `${ws.path} exists and is not a workspace clone` })
    }
    yield* fs.makeDirectory(path.dirname(ws.path), { recursive: true })
    yield* git(undefined, ["clone", "--quiet", "--no-checkout", "--no-hardlinks", ws.source, ws.path])
    yield* git(ws.path, ["remote", "remove", "origin"])
  }
  if (!(yield* hasCommit(ws, sha))) {
    yield* git(ws.path, ["fetch", "--quiet", "--tags", ws.source, "+refs/heads/*:refs/remotes/source/*"])
  }
  yield* git(ws.path, ["checkout", "--quiet", "--force", "--detach", sha])
  yield* git(ws.path, ["clean", "-ffdxq", ...ws.keep.flatMap((k) => ["-e", k])])
  yield* hideOtherCommits(ws)
})

/**
 * Drop every ref and reflog entry, leaving only the detached base commit.
 *
 * Later commits in the source repo can hold the answer (hidden tests, notes
 * from earlier attempts), and `git log --all` or `git reflog` would otherwise
 * show them to the agent.
 */
const hideOtherCommits = Effect.fn("hideOtherCommits")(function*(ws: Workspace) {
  const refs = (yield* git(ws.path, ["for-each-ref", "--format=%(refname)"])).split(/\s+/).filter(Boolean)
  if (refs.length > 0) {
    yield* git(ws.path, ["update-ref", "--stdin"], refs.map((r) => `delete ${r}\n`).join(""))
  }
  yield* git(ws.path, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"])
})

const hasCommit = (ws: Workspace, sha: string) =>
  git(ws.path, ["cat-file", "-e", `${sha}^{commit}`]).pipe(
    Effect.as(true),
    Effect.catchTag("WorkspaceError", () => Effect.succeed(false))
  )

/** Everything the agent changed since `sha`, including new files and commits. */
export const workspaceDiff = Effect.fn("workspaceDiff")(function*(ws: Workspace, sha: string) {
  yield* git(ws.path, ["add", "--all"])
  return yield* git(ws.path, ["diff", "--cached", "--binary", sha])
})

/** Copy a directory tree over the workspace, replacing files that exist. */
export const overlayWorkspace = Effect.fn("overlayWorkspace")(function*(ws: Workspace, files: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.copy(files, ws.path, { overwrite: true })
})
