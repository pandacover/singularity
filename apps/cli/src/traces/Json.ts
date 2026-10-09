/**
 * Lenient reading of agents' logs, shared by the transcript parsers: a field
 * of an unexpected shape counts as missing.
 */
import { DateTime, Option, Predicate } from "effect"

export type Json = Readonly<Record<string, unknown>>

export const obj = (value: unknown): Json => (Predicate.isObject(value) && !Array.isArray(value) ? (value as Json) : {})

/** A non-empty string, or undefined (like Python's `x or default` on a string field). */
export const str = (value: unknown): string | undefined => (Predicate.isString(value) && value !== "" ? value : undefined)

/** A finite number, or undefined. */
export const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** The value of a JSON text, or undefined when it isn't JSON. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** An ISO timestamp; one without a zone is taken as UTC. */
export const timestamp = (value: unknown): DateTime.Utc | undefined => {
  if (!Predicate.isString(value)) return undefined
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
  return Option.getOrUndefined(DateTime.make(withZone).pipe(Option.map(DateTime.toUtc)))
}

/** Seconds since the epoch, as a time. */
export const fromSeconds = (value: unknown): DateTime.Utc | undefined => {
  const n = num(value)
  return n === undefined ? undefined : Option.getOrUndefined(DateTime.make(n * 1000).pipe(Option.map(DateTime.toUtc)))
}

/** Stable sort by time, entries without a time last. */
export const sortByTime = <A>(items: Array<A>, time: (a: A) => DateTime.Utc | undefined): Array<A> =>
  items.sort((a, b) => {
    const ta = time(a)
    const tb = time(b)
    if (ta === undefined || tb === undefined) return (ta === undefined ? 1 : 0) - (tb === undefined ? 1 : 0)
    return DateTime.toEpochMillis(ta) - DateTime.toEpochMillis(tb)
  })

/** The earliest and latest of some times. */
export const timeSpan = (times: ReadonlyArray<DateTime.Utc>): { readonly first: DateTime.Utc | undefined; readonly last: DateTime.Utc | undefined } => {
  let first: DateTime.Utc | undefined
  let last: DateTime.Utc | undefined
  for (const t of times) {
    const ms = DateTime.toEpochMillis(t)
    if (first === undefined || ms < DateTime.toEpochMillis(first)) first = t
    if (last === undefined || ms > DateTime.toEpochMillis(last)) last = t
  }
  return { first, last }
}
