/**
 * Word search: BM25 over short documents (tasks, steps, warnings).
 *
 * Words are lower-cased letters and digits; code identifiers also count by
 * their parts (`handleKeyboardGlobally` matches "keyboard"), and a plural `s`
 * is dropped. Common words and the boilerplate every task prompt has ("make
 * sure the tests pass") don't count.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have in into is it its of on or should so that the this to was " +
    "were will with make sure pass tests test typecheck do does not no all any can if then than when there their " +
    "them they we you your our us i me my also just only more most other some such these those which who what how"
  ).split(" ")
)

const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)

/** The words of `text` that search looks at, in order, repeats kept. */
export const tokenize = (text: string): Array<string> => {
  const out: Array<string> = []
  for (const raw of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const whole = raw.toLowerCase()
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((p) => p.toLowerCase())
    for (const w of parts.length > 1 ? [whole, ...parts] : [whole]) {
      if (!STOPWORDS.has(w) && w.length > 1) out.push(stem(w))
    }
  }
  return out
}

export interface Doc {
  readonly id: string
  readonly text: string
}

interface Indexed {
  readonly id: string
  readonly terms: ReadonlyMap<string, number>
  readonly length: number
}

export interface Index {
  readonly docs: ReadonlyArray<Indexed>
  readonly df: ReadonlyMap<string, number>
  readonly avgLength: number
}

export const buildIndex = (docs: ReadonlyArray<Doc>): Index => {
  const indexed = docs.map((d) => {
    const terms = new Map<string, number>()
    const words = tokenize(d.text)
    for (const w of words) terms.set(w, (terms.get(w) ?? 0) + 1)
    return { id: d.id, terms, length: words.length }
  })
  const df = new Map<string, number>()
  for (const d of indexed) for (const t of d.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLength = indexed.length === 0 ? 0 : indexed.reduce((s, d) => s + d.length, 0) / indexed.length
  return { docs: indexed, df, avgLength }
}

export interface Hit {
  readonly id: string
  /** BM25: only meaningful for ranking within one search. */
  readonly score: number
  /** How much of the query it matched, weighted by how rare each word is: 0 to 1. */
  readonly coverage: number
  /** How many of the query's distinct words it has. */
  readonly matched: number
}

const K1 = 1.2
const B = 0.75

/** Documents sharing words with `query`, best first (ties by id), at most `limit`. */
export const search = (index: Index, query: string, limit = 10): Array<Hit> => {
  const n = index.docs.length
  const terms = [...new Set(tokenize(query))]
  const idf = new Map(terms.map((t) => {
    const df = index.df.get(t) ?? 0
    return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))]
  }))
  const total = terms.reduce((s, t) => s + idf.get(t)!, 0)
  const hits: Array<Hit> = []
  for (const d of index.docs) {
    let score = 0
    let matched = 0
    let count = 0
    for (const t of terms) {
      const tf = d.terms.get(t)
      if (tf === undefined) continue
      const norm = index.avgLength === 0 ? 1 : 1 - B + B * (d.length / index.avgLength)
      score += idf.get(t)! * (tf * (K1 + 1)) / (tf + K1 * norm)
      matched += idf.get(t)!
      count++
    }
    if (score > 0) hits.push({ id: d.id, score, coverage: total === 0 ? 0 : matched / total, matched: count })
  }
  return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit)
}
