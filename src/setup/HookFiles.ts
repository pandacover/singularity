/**
 * Memory's hooks in an agent's hook file: added next to whatever else the
 * file holds, replaced when set up again (from wherever singularity was
 * installed before, v0's hooks included), and taken out alone.
 *
 * Files are read with Schema; one that isn't plain JSON (comments, say) is
 * left as it is, and setup says so. The first change keeps the file as it
 * was in `<file>.before-singularity`.
 */
import { Effect, FileSystem, Path, Predicate, Schema } from "effect"
import { writeFileWhole } from "../local/Files.ts"
import { type HookEvents, type HookFile, isMemoryHookCommand } from "./Agents.ts"

type Json = Record<string, unknown>

export class HookFileError extends Schema.TaggedError<HookFileError>()("HookFileError", {
  file: Schema.String,
  message: Schema.String
}) {}

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const isOurs = (entry: unknown): boolean =>
  Predicate.isObject(entry) && Array.isArray((entry as Json).hooks) &&
  ((entry as Json).hooks as Array<unknown>).some((h) =>
    Predicate.isObject(h) && Predicate.isString((h as Json).command) && isMemoryHookCommand((h as Json).command as string)
  )

/** The events object of a file's JSON. */
export const eventsOf = (json: Json, layout: HookFile["layout"]): Json =>
  layout === "events" ? json : Predicate.isObject(json.hooks) ? (json.hooks as Json) : {}

/** The file's JSON with `events` as its hooks. */
export const withEvents = (json: Json, layout: HookFile["layout"], events: Json): Json => {
  if (layout === "events") return events
  const { hooks: _hooks, ...rest } = json
  return Object.keys(events).length === 0 ? rest : { ...rest, hooks: events }
}

/** `events` without memory's entries; other entries stay as they were, and events left empty go. */
export const withoutMemoryHooks = (events: Json): Json => {
  const out: Json = {}
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) {
      out[event] = entries
      continue
    }
    const kept = entries.filter((e) => !isOurs(e))
    if (kept.length > 0) out[event] = kept
  }
  return out
}

/** `events` with memory's entries added after the others, replacing any earlier copy of them. */
export const withMemoryHooks = (events: Json, ours: HookEvents): Json => {
  const out = withoutMemoryHooks(events)
  for (const [event, entries] of Object.entries(ours)) {
    const existing = Array.isArray(out[event]) ? (out[event] as Array<unknown>) : []
    out[event] = [...existing, ...entries]
  }
  return out
}

/** The events memory's hooks are on. */
export const memoryHookEvents = (events: Json): ReadonlyArray<string> =>
  Object.entries(events).filter(([, entries]) => Array.isArray(entries) && entries.some(isOurs)).map(([event]) => event)

/** A JSON file's object: `{}` when it is missing or blank. */
export const readJsonFile = Effect.fn("readJsonFile")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return {} as Json
  const text = yield* fs.readFileString(file).pipe(Effect.mapError((e) => new HookFileError({ file, message: e.message })))
  if (text.trim() === "") return {} as Json
  return yield* Schema.decodeUnknownEffect(JsonObject)(text.replace(/^﻿/, "")).pipe(
    Effect.mapError(() => new HookFileError({ file, message: "isn't plain JSON (comments, perhaps), so it was left alone" }))
  )
})

/** Write a JSON file whole, keeping the file as it was before the first change. */
export const writeJsonFile = Effect.fn("writeJsonFile")(function*(file: string, json: Json) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const backup = `${file}.before-singularity`
  if ((yield* fs.exists(file)) && !(yield* fs.exists(backup))) yield* fs.copyFile(file, backup)
  yield* writeFileWhole(fs, file, JSON.stringify(json, null, 2) + "\n")
})

/** Add memory's hooks to a hook file. */
export const installHooks = Effect.fn("installHooks")(function*(target: HookFile, ours: HookEvents) {
  const json = yield* readJsonFile(target.file)
  yield* writeJsonFile(target.file, withEvents(json, target.layout, withMemoryHooks(eventsOf(json, target.layout), ours)))
})

/** Take memory's hooks out of a hook file; whether there were any. */
export const removeHooks = Effect.fn("removeHooks")(function*(target: HookFile) {
  const json = yield* readJsonFile(target.file)
  const events = eventsOf(json, target.layout)
  if (memoryHookEvents(events).length === 0) return false
  yield* writeJsonFile(target.file, withEvents(json, target.layout, withoutMemoryHooks(events)))
  return true
})

/** The events memory's hooks are on in a hook file (none when the file is missing or unreadable). */
export const hooksIn = (target: HookFile) =>
  readJsonFile(target.file).pipe(
    Effect.map((json) => memoryHookEvents(eventsOf(json, target.layout))),
    Effect.orElseSucceed((): ReadonlyArray<string> => [])
  )

/** Whether a hook file holds hooks of the user's own (other than memory's). */
export const hasOtherHooks = (target: HookFile) =>
  readJsonFile(target.file).pipe(
    Effect.map((json) => Object.keys(withoutMemoryHooks(eventsOf(json, target.layout))).length > 0),
    Effect.orElseSucceed(() => false)
  )
