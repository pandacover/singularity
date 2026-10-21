/**
 * The fact index of a repo, written when memory stores (workflows/
 * Commits.ts): built again whole from the repo's records (Facts.ts) each time
 * a change is stored, and when the index is missing (memory set up before
 * facts were kept). Facts no longer live (Lookup.ts `isLive`: a script gone
 * from disk, a package script gone from package.json) are left out, by the
 * same check the hooks make at use, in the checkout storing ran in.
 *
 *     <tenant>/facts/<subject>.json
 *     <tenant>/facts/commands/<record id>.json
 *
 * A record keeps each command to 500 characters. Records stored before the
 * code fed through a command was cut first (Shell.ts `compactCommand`) lost
 * what ran after a heredoc: the screenshot script a session wrote and ran
 * in one line. Their commands and detours are read again from their logs,
 * by today's rules (records/Extract.ts), once: the second file keeps them.
 * The record itself stays as it was stored.
 */
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { writeFileWhole } from "../local/Files.ts"
import { extractMechanical } from "../records/Extract.ts"
import { CommandRun, Detour, type WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { recordTrace } from "../records/Segment.ts"
import { buildFacts, type Env, type FactIndex } from "./Facts.ts"
import { factsDir, indexPath, isLive, packageScripts } from "./Lookup.ts"

/** Facts left out of an index: those not live in the checkout at `root`. */
export const liveIndex = (index: FactIndex, root: string): FactIndex => {
  const scripts = packageScripts(root)
  const facts = index.facts.filter((f) => isLive(f, root, scripts))
  const keep = new Set(facts.map((f) => f.id))
  const only = (m: Readonly<Record<string, ReadonlyArray<string>>>) =>
    Object.fromEntries(Object.entries(m).map(([k, ids]) => [k, ids.filter((id) => keep.has(id))] as const).filter(([, ids]) => ids.length > 0))
  return { ...index, facts, by_file: only(index.by_file), by_key: only(index.by_key) }
}

/** Raise when Extract.ts reads commands otherwise, so records are read again. */
export const COMMANDS_FORMAT = 1

const CommandsFile = Schema.Struct({
  format: Schema.Int,
  commands: Schema.Array(CommandRun),
  detours: Schema.Array(Detour)
})
const decodeCommands = Schema.decodeUnknownOption(Schema.fromJsonString(CommandsFile))

/** A record a command of which was cut short when it was stored. */
const clipped = (r: WorkflowRecord) => r.commands.some((c) => c.command.endsWith("..."))

/** A record's commands and detours read again from its log, by today's rules; undefined when its log is gone. */
export const commandsNow = Effect.fn("facts.commandsNow")(function*(r: WorkflowRecord) {
  const trace = yield* recordTrace(r).pipe(Effect.option)
  if (Option.isNone(trace)) return undefined
  const m = extractMechanical(trace.value, "", { succeeded: r.run.outcome === "success" })
  return { commands: m.commands, detours: m.detours }
})

/** The record with its commands as they are kept now: read again from its log once (`commandsNow`), then from the file kept. */
const withCommandsNow = Effect.fn("facts.withCommandsNow")(function*(tenantDir: string, r: WorkflowRecord) {
  if (!clipped(r)) return r
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(factsDir(tenantDir), "commands", `${r.id}.json`)
  const kept = (yield* fs.exists(file)) ? decodeCommands(yield* fs.readFileString(file)).pipe(Option.getOrUndefined) : undefined
  if (kept !== undefined && kept.format === COMMANDS_FORMAT) return { ...r, commands: kept.commands, detours: kept.detours }
  const now = yield* commandsNow(r)
  if (now === undefined) return r
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileWhole(fs, file, JSON.stringify({ format: COMMANDS_FORMAT, ...now }) + "\n")
  return { ...r, ...now }
})

/**
 * Write a repo's fact index from its records; with `onlyIfMissing`, only
 * when there is none yet. Returns the index written, if one was.
 */
export const writeFacts = Effect.fn("writeFacts")(function*(
  tenantDir: string,
  subject: string,
  root: string,
  options: { readonly onlyIfMissing?: boolean | undefined; readonly env?: Env | undefined } = {}
) {
  const fs = yield* FileSystem.FileSystem
  const file = indexPath(tenantDir, subject)
  if (options.onlyIfMissing === true && (yield* fs.exists(file))) return undefined
  const stored = yield* (yield* RecordStore).find({ subject, outcome: "success" })
  const records = yield* Effect.forEach(stored, (r) => withCommandsNow(tenantDir, r))
  const index = liveIndex(buildFacts(records, { subject, env: options.env ?? process.env, now: DateTime.formatIso(yield* DateTime.now) }), root)
  yield* fs.makeDirectory(factsDir(tenantDir), { recursive: true })
  yield* writeFileWhole(fs, file, JSON.stringify(index, null, 2) + "\n")
  return index
})
