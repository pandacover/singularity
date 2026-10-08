/**
 * Word-overlap similarity between short texts: task prompts and node descriptions.
 *
 * Cosine similarity of word counts (lowercase letters and digits), ignoring
 * stopwords and the boilerplate every task prompt ends with ("make sure the
 * tests and the typecheck pass"). On the excalidraw suite, prompts in one
 * family score 0.76-0.87 against each other and 0.12-0.24 across families.
 * Embeddings could replace it if that kind of separation stops holding.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have in into is it its of on or " +
    "should so that the this to was were will with make sure pass tests typecheck"
  ).split(" ")
)

/** Word counts of `text`, without stopwords. */
export const words = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (!STOPWORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return counts
}

export const cosine = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number => {
  let dot = 0
  for (const [w, n] of a) dot += n * (b.get(w) ?? 0)
  const norm = (m: ReadonlyMap<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0))
  const denom = norm(a) * norm(b)
  return denom ? dot / denom : 0
}

export const textSimilarity = (a: string, b: string): number => cosine(words(a), words(b))
