/**
 * Records from eval runs: each run in a run output directory (`results.jsonl`
 * plus `runs/<run id>/` with the transcript and diff) becomes a record, unless
 * its record exists already.
 *
 * The repo is recognized from the run's working directory (the eval
 * workspace, a clone of the suite's repo) or from `repo` when that's gone.
 * Runs with no outcome (setup failures, crashes) are skipped.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { identifyRepo, type RepoIdentity } from "../local/Git.ts"
import { parseSession } from "../traces/index.ts"
import { buildRecord, recordId } from "./Build.ts"
import type { Check, MemoryItem, MemoryUse } from "./Models.ts"
import { RecordStore } from "./RecordStore.ts"

/** The fields of a results.jsonl line that records use. Old lines lack some. */
const RunLine = Schema.Struct({
  run_id: Schema.String,
  setup: Schema.String,
  task_id: Schema.String,
  base_sha: Schema.optionalKey(Schema.String),
  started_at: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  session_id: Schema.optionalKey(Schema.String),
  cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({ total: Schema.Number }))),
  checks: Schema.optionalKey(Schema.Array(Schema.Struct({
    command: Schema.String,
    exit_code: Schema.NullOr(Schema.Number),
    timed_out: Schema.optionalKey(Schema.Boolean)
  }))),
  injection: Schema.optionalKey(Schema.Unknown)
})
type RunLine = typeof RunLine.Type

/** What eval memory setups record about what they handed over. */
const Injection = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  retrieved: Schema.optionalKey(Schema.NullOr(Schema.Struct({ task_id: Schema.String }))),
  also_retrieved: Schema.optionalKey(Schema.Array(Schema.Struct({ task_id: Schema.String }))),
  nodes: Schema.optionalKey(Schema.Array(Schema.String)),
  warnings: Schema.optionalKey(Schema.Struct({
    version: Schema.optionalKey(Schema.Number),
    nodes: Schema.optionalKey(Schema.Array(Schema.String))
  }))
})

/** The memory an eval run was given, from its setup and injection info. Which pieces helped isn't in the log. */
export const evalMemory = (setup: string, injection: unknown): MemoryUse | null => {
  if (setup === "no-memory") return null
  const info = Option.getOrUndefined(Schema.decodeUnknownOption(Injection)(injection ?? {}))
  if (info === undefined) return { setup, version: null, items: [] }
  const item = (id: string, kind: string): MemoryItem => ({ id, kind, moment: "start", outcome: "unknown", note: null })
  const saved = [info.retrieved ?? undefined, ...(info.also_retrieved ?? [])]
    .filter((r) => r !== undefined)
    .map((r) => item(`saved-scripts:${r.task_id}`, "saved-solution"))
  const steps = (info.nodes ?? []).map((n) => item(`graph:${n}`, "graph-step"))
  const warnings = (info.warnings?.nodes ?? []).map((n) => item(`graph:${n}`, "graph-warning"))
  return { setup, version: info.version ?? info.warnings?.version ?? null, items: [...saved, ...steps, ...warnings] }
}

export interface ImportResult {
  readonly added: number
  readonly existing: number
  readonly skipped: number
}

export interface ImportOptions {
  /** The repo, when a run's working directory no longer exists. */
  readonly repo?: string | undefined
  readonly onRecord?: ((id: string, line: RunLine) => Effect.Effect<void>) | undefined
}

export const importRunDirs = Effect.fn("importRunDirs")(function*(dirs: ReadonlyArray<string>, options: ImportOptions = {}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const store = yield* RecordStore
  const repos = new Map<string, RepoIdentity | undefined>()
  const repoAt = Effect.fnUntraced(function*(dir: string) {
    if (!repos.has(dir)) repos.set(dir, yield* identifyRepo(dir))
    return repos.get(dir)
  })
  let added = 0
  let existing = 0
  let skipped = 0
  for (const dir of dirs) {
    const file = path.join(dir, "results.jsonl")
    if (!(yield* fs.exists(file))) {
      skipped++
      continue
    }
    for (const text of (yield* fs.readFileString(file)).split(/\r?\n/)) {
      if (text.trim() === "") continue
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(RunLine))(text)
      if (Option.isNone(decoded)) {
        skipped++
        continue
      }
      const line = decoded.value
      const runDir = path.join(dir, "runs", line.run_id)
      const transcript = line.session_id === undefined ? undefined : path.join(runDir, "transcript", `${line.session_id}.jsonl`)
      if (typeof line.success !== "boolean" || transcript === undefined || !(yield* fs.exists(transcript))) {
        skipped++
        continue
      }
      const trace = yield* parseSession(transcript)
      const repo = (trace.cwd !== undefined && (yield* fs.exists(trace.cwd)) ? yield* repoAt(trace.cwd) : undefined) ??
        (options.repo === undefined ? undefined : yield* repoAt(options.repo))
      if (repo === undefined) {
        skipped++
        continue
      }
      const subject = yield* store.subjectFor(repo, { create: true })
      if (subject === undefined) {
        skipped++
        continue
      }
      if (yield* store.has(recordId(subject.id, trace.sessionId))) {
        existing++
        continue
      }
      const diffFile = path.join(runDir, "diff.patch")
      // The Python harness wrote diffs with CRLF line endings on Windows.
      const diff = (yield* fs.exists(diffFile)) ? (yield* fs.readFileString(diffFile)).replace(/\r\n?/g, "\n") : ""
      const checks: Array<Check> = (line.checks ?? []).map((c) => ({
        command: c.command,
        ok: c.exit_code === 0 && c.timed_out !== true,
        exit_code: c.exit_code === null ? null : Math.trunc(c.exit_code)
      }))
      const record = buildRecord({
        tenant: store.tenant,
        subject: subject.id,
        trace,
        diff,
        outcome: line.success ? "success" : "failure",
        checks,
        memory: evalMemory(line.setup, line.injection),
        run: {
          source: "eval",
          log: path.resolve(transcript),
          run_dir: path.resolve(dir),
          run_id: line.run_id,
          setup: line.setup,
          task_id: line.task_id,
          repo: trace.cwd ?? null,
          base_commit: line.base_sha ?? null,
          head_commit: null,
          started_at: line.started_at ?? null,
          cost_usd: line.cost_usd ?? null,
          tokens: line.tokens?.total === undefined ? null : Math.trunc(line.tokens.total)
        },
        createdAt: DateTime.formatIso(yield* DateTime.now)
      })
      yield* store.put(record)
      added++
      if (options.onRecord) yield* options.onRecord(record.id, line)
    }
  }
  return { added, existing, skipped } satisfies ImportResult
})
