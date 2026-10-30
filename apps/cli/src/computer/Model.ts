/**
 * What computer-use memory writes to disk, as Schemas: files are read back
 * with them, never trusted. Keys are snake_case, like the rest of memory's
 * files.
 *
 *     <tenant>/computer/salt                          the fingerprints' salt (Text.ts)
 *     <tenant>/computer/apps/<app>/trails/<session>.json   one trail per session (Trail.ts)
 *     <tenant>/computer/apps/<app>/index.json         the app's index, built from its trails (Index.ts)
 *     <tenant>/computer/sessions/<session>.json       what a session was handed (Handover.ts)
 */
import { Schema } from "effect"

export const Segment = Schema.Union([Schema.Struct({ n: Schema.Literal(true) }), Schema.Struct({ fp: Schema.String })])

export const Address = Schema.Struct({
  app: Schema.String,
  path: Schema.Array(Segment),
  hash: Schema.optionalKey(Schema.Array(Segment)),
  query: Schema.Array(Schema.String)
})

export const ControlRef = Schema.Struct({ role: Schema.String, fp: Schema.String })

export const FieldState = Schema.Literals(["ticked", "partly ticked", "selected", "set"])

export const TrailField = Schema.Struct({ ...ControlRef.fields, state: FieldState, changed: Schema.Boolean })

export const TrailScreen = Schema.Struct({
  key: Schema.String,
  address: Address,
  region: Schema.NullOr(ControlRef),
  controls: Schema.Array(Schema.String),
  seen: Schema.Array(Schema.String),
  worked: Schema.Boolean,
  wrote: Schema.Boolean,
  fields: Schema.Array(TrailField),
  traps: Schema.Array(Schema.String),
  keys: Schema.Array(Schema.String),
  checked_at: Schema.Array(Schema.String)
})

export const Hop = Schema.Struct({ ...ControlRef.fields, from: Schema.String })

export const TrailRoute = Schema.Struct({ to: Schema.String, start: Schema.String, hops: Schema.Array(Hop) })

export const Rule = Schema.Struct({ text: Schema.String, at: Schema.String })

export const Trail = Schema.Struct({
  version: Schema.Literal(1),
  app: Schema.String,
  session: Schema.String,
  agent: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.String,
  screens: Schema.Array(TrailScreen),
  routes: Schema.Array(TrailRoute),
  rules: Schema.Array(Rule),
  texts: Schema.Record(Schema.String, Schema.String),
  left_out: Schema.Record(Schema.String, Schema.Number),
  desktop: Schema.optionalKey(Schema.Struct({ calls: Schema.Number, menus: Schema.Array(Schema.Array(Schema.String)) })),
  /** The words of the prompts before the session's first action in the app, by fingerprint (Text.ts `promptWords`). */
  words: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Screens reached from each screen worked on or passed through, for hub screens' notes: `from` → `to`, both screen keys. */
  next: Schema.optionalKey(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })))
})
export type Trail = typeof Trail.Type
export type TrailScreen = typeof TrailScreen.Type
export type TrailRoute = typeof TrailRoute.Type
export type TrailField = typeof TrailField.Type
export type ControlRef = typeof ControlRef.Type
export type Address = typeof Address.Type
export type Segment = typeof Segment.Type
export type FieldState = typeof FieldState.Type

export const IndexScreen = Schema.Struct({
  key: Schema.String,
  address: Address,
  region: Schema.NullOr(ControlRef),
  /** Sessions that worked on it. */
  worked_in: Schema.Number,
  fields: Schema.Array(Schema.Struct({ ...ControlRef.fields, state: FieldState, seen_in: Schema.Number, changed_in: Schema.Number, last: Schema.String })),
  traps: Schema.Array(Schema.Struct({ fp: Schema.String, sessions: Schema.Number })),
  keys: Schema.Array(Schema.Struct({ key: Schema.String, sessions: Schema.Number })),
  checked_at: Schema.Array(Schema.Struct({ key: Schema.String, address: Address, sessions: Schema.Number }))
})
export type IndexScreen = typeof IndexScreen.Type

export const IndexRoute = Schema.Struct({
  to: Schema.String,
  start: Schema.String,
  start_address: Address,
  hops: Schema.Array(Hop),
  /** When the session that took it started: the newest route to a screen wins. */
  at: Schema.String,
  /** Sessions that took these same hops to the screen. */
  used_in: Schema.Number
})
export type IndexRoute = typeof IndexRoute.Type

export const AppIndex = Schema.Struct({
  version: Schema.Literal(1),
  app: Schema.String,
  sessions: Schema.Array(Schema.Struct({ session: Schema.String, agent: Schema.String, started_at: Schema.String, ended_at: Schema.String })),
  /** Strings two sessions saw, in plain text, by fingerprint. */
  texts: Schema.Record(Schema.String, Schema.String),
  /** For each screen (`""` for address segments), how many sessions saw each string there. */
  seen: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number)),
  screens: Schema.Record(Schema.String, IndexScreen),
  routes: Schema.Array(IndexRoute),
  /** Routes retired since, and why: shown in status. */
  retired: Schema.Array(Schema.Struct({ to: Schema.String, why: Schema.String })),
  rules: Schema.Array(Rule),
  left_out: Schema.Record(Schema.String, Schema.Number),
  /** For each prompt word's fingerprint, the sessions whose prompts had it before their first action here. */
  words: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  /** For each screen, the screens sessions went to next from it, and in how many sessions. */
  next: Schema.optionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number)))
})
export type AppIndex = typeof AppIndex.Type

/** `<tenant>/computer/words.json`: prompt words that name one app (two sessions there, none elsewhere), by fingerprint. */
export const AppWords = Schema.Record(Schema.String, Schema.String)

/**
 * What a session was handed: the apps whose card it got, the screens whose
 * notes it got; and the page it last read, for tools whose answers don't
 * repeat it, as memory keeps addresses (its host, and its path by
 * fingerprint, query keys without values): never the address itself, which
 * can hold what a form sent.
 */
export const Given = Schema.Struct({
  cards: Schema.Array(Schema.String),
  screens: Schema.Array(Schema.String),
  host: Schema.optionalKey(Schema.String),
  address: Schema.optionalKey(Address)
})
export type Given = typeof Given.Type
