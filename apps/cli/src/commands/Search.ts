/**
 * `singularity search ...`: exact and word search over local memory.
 */
import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { RecordStore } from "../records/RecordStore.ts"
import { MemoryStore } from "../memory/MemoryStore.ts"
import { excerpt, memoryDocs, recordDoc, type SearchDoc, searchExact, searchText } from "../search/Search.ts"
import { homeFlag, recordsLayer } from "./Common.ts"
import { memoryLayer } from "./Memory.ts"

const TYPES = ["record", "kind", "step", "warning"] as const

export const searchCommand = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.variadic({ min: 1 }), Argument.withDescription("what to look for")),
    exact: Flag.Boolean("exact").pipe(
      Flag.withDefault(false),
      Flag.withDescription("find this exact text in commands, file paths, errors and triggers")
    ),
    ignoreCase: Flag.Boolean("ignore-case").pipe(Flag.withDefault(false), Flag.withDescription("exact search ignores case")),
    subject: Flag.String("subject").pipe(Flag.optional, Flag.withDescription("only this subject (repo)")),
    type: Flag.Literals("type", TYPES).pipe(Flag.optional, Flag.withDescription("only this kind of item")),
    limit: Flag.Int("limit").pipe(Flag.withDefault(10)),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const query = args.query.join(" ")
    const subject = Option.getOrUndefined(args.subject)
    const records = yield* (yield* RecordStore).find({ subject })
    const docs: Array<SearchDoc> = [...records.map(recordDoc), ...memoryDocs(yield* (yield* MemoryStore).graph())]
      .filter((d) => Option.isNone(args.type) || d.type === args.type.value)
      .filter((d) => subject === undefined || d.subjects.length === 0 || d.subjects.includes(subject))
    if (args.exact) {
      const hits = searchExact(docs, query, { ignoreCase: args.ignoreCase, limit: args.limit })
      if (args.json) {
        return yield* Console.log(JSON.stringify(hits.map((h) => ({ type: h.doc.type, id: h.doc.id, field: h.field, value: h.value })), null, 2))
      }
      for (const h of hits) yield* Console.log(`${h.doc.type.padEnd(7)} ${h.doc.id.padEnd(28)} ${h.field.padEnd(8)} ${excerpt(h.value, query)}`)
      return yield* Console.error(`${hits.length} matches`)
    }
    const hits = searchText(docs, query, args.limit)
    if (args.json) {
      return yield* Console.log(JSON.stringify(hits.map((h) => ({ type: h.doc.type, id: h.doc.id, title: h.doc.title, score: h.score, coverage: h.coverage })), null, 2))
    }
    for (const h of hits) {
      yield* Console.log(`${h.score.toFixed(2).padStart(6)} ${h.doc.type.padEnd(7)} ${h.doc.id.padEnd(28)} ${excerpt(h.doc.title, "")}`)
    }
    yield* Console.error(`${hits.length} matches`)
  }, (effect, args) => Effect.provide(effect, Layer.merge(recordsLayer(args.home), memoryLayer(args.home))))
).pipe(Command.withDescription("search local memory: records, task kinds, steps and warnings"))
