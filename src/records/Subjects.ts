/**
 * Subjects: the repos a tenant's memory is about.
 *
 * A repo belongs to the subject that shares one of its root commits (clones
 * and forks do) or one of its remotes. A new repo becomes a new subject named
 * after its remote, or its directory.
 */
import { Schema } from "effect"
import { posix } from "node:path"
import type { RepoIdentity } from "../local/Git.ts"

export const Subject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root_commits: Schema.Array(Schema.String),
  remotes: Schema.Array(Schema.String),
  /** Working trees it has been seen in. */
  paths: Schema.Array(Schema.String),
  created_at: Schema.String
})
export type Subject = typeof Subject.Type

export const SubjectsFile = Schema.Struct({ subjects: Schema.Array(Subject) })

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase()

/** The subject `repo` belongs to, if any. */
export const matchSubject = (subjects: ReadonlyArray<Subject>, repo: RepoIdentity): Subject | undefined =>
  subjects.find((s) => s.root_commits.some((c) => repo.rootCommits.includes(c))) ??
    subjects.find((s) => s.remotes.some((r) => repo.remotes.includes(r))) ??
    subjects.find((s) => s.paths.some((p) => samePath(p, repo.root)))

/** A readable, unused id: the remote's or the directory's name. */
export const subjectId = (subjects: ReadonlyArray<Subject>, repo: RepoIdentity): string => {
  const source = repo.remotes[0] ?? repo.root.replace(/\\/g, "/")
  const base = posix.basename(source).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "repo"
  const taken = new Set(subjects.map((s) => s.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** The subject with whatever `repo` adds to it (a new remote, root commit or path), or undefined if nothing is new. */
export const extendSubject = (s: Subject, repo: RepoIdentity): Subject | undefined => {
  const roots = [...new Set([...s.root_commits, ...repo.rootCommits])]
  const remotes = [...new Set([...s.remotes, ...repo.remotes])]
  const paths = s.paths.some((p) => samePath(p, repo.root)) ? s.paths : [...s.paths, repo.root]
  if (roots.length === s.root_commits.length && remotes.length === s.remotes.length && paths.length === s.paths.length) {
    return undefined
  }
  return { ...s, root_commits: roots, remotes, paths }
}
