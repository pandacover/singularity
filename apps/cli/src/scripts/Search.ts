/**
 * Which saved script a new task gets, if any.
 *
 * The old search (`SavedScripts.ts`) scored the cosine of word counts between
 * two prompts and handed over the best one above 0.35. On the markdownlint
 * long task that handed one-off tasks (a new API function, a folder rename)
 * a parameter change, and missed a new rule (0.31): a long prompt that spells
 * out new logic shares few words with any old one, and a short one-off prompt
 * shares the repo's boilerplate with all of them.
 *
 * This search asks a narrower question: does the new task ask for what the
 * old one asked? It scores how much of the old prompt's words the new prompt
 * holds (counted with repeats), and takes the geometric mean with the cosine,
 * so the old prompt must be both covered and alike. A new rule whose prompt
 * adds its own logic still covers an old rule's ask; a one-off covers only
 * the boilerplate. Below `MIN_SCORE` nothing is handed over: no script beats
 * a wrong one. No model call, and only the prompts: what the agent would know.
 *
 * Pure functions; the callers read the store.
 */
import { cosine, words } from "../graph/Similarity.ts"

/** A saved script, as the search sees it. */
export interface SearchDoc {
  readonly id: string
  readonly prompt: string
}

export interface Ranked<D extends SearchDoc = SearchDoc> {
  readonly doc: D
  readonly score: number
}

/**
 * Below this, nothing is handed over. Set from the check in
 * examples/scripts/check-search.ts: fitting picks there score 0.40 and up,
 * wrong ones 0.35 and below.
 */
export const MIN_SCORE = 0.38

/** How alike two prompts are, from 0 to 1: the share of the old prompt the new one holds, with their cosine. */
export const score = (prompt: string, old: string): number => {
  const a = words(prompt)
  const b = words(old)
  let held = 0
  let total = 0
  for (const [w, n] of b) {
    total += n
    if (a.has(w)) held += n
  }
  return total === 0 ? 0 : Math.sqrt((held / total) * cosine(a, b))
}

/** Every script with its score, best first (store order on ties). */
export const rank = <D extends SearchDoc>(prompt: string, docs: ReadonlyArray<D>): Array<Ranked<D>> =>
  docs.map((doc) => ({ doc, score: score(prompt, doc.prompt) })).sort((x, y) => y.score - x.score)

/** The script to hand over, or undefined when none clears `minScore`. */
export const pick = <D extends SearchDoc>(prompt: string, docs: ReadonlyArray<D>, minScore = MIN_SCORE): Ranked<D> | undefined => {
  const top = rank(prompt, docs)[0]
  return top !== undefined && top.score >= minScore ? top : undefined
}

/**
 * Recall mid-task (`singularity recall`) asks with a short line, such as "add a
 * keyboard shortcut to the context menu", which holds little of any old prompt,
 * so `score` misses it. A query is scored by how much of it a script covers:
 * the query's words found in the script's prompt or file paths, each weighted
 * by how rare it is among the scripts, so words every script has count little.
 * Below `QUERY_MIN` (and below `MIN_SCORE` by `score`) nothing is shown.
 */
export const QUERY_MIN = 0.6

export interface RecallDoc extends SearchDoc {
  /** The paths of the files it changed. */
  readonly files: ReadonlyArray<string>
}

/** Every script with how well it answers a recall query, best first; `score` is the better of the two measures. */
export const rankRecall = <D extends RecallDoc>(query: string, docs: ReadonlyArray<D>): Array<Ranked<D> & { readonly matches: boolean }> => {
  const q = [...words(query).keys()]
  const texts = docs.map((d) => words(`${d.prompt} ${d.files.join(" ")}`))
  const idf = new Map(q.map((w) => [w, Math.log((docs.length + 1) / (texts.filter((t) => t.has(w)).length + 1)) + 1] as const))
  const all = q.reduce((s, w) => s + idf.get(w)!, 0)
  return docs.map((doc, i) => {
    const held = q.filter((w) => texts[i].has(w))
    const covered = all === 0 ? 0 : held.reduce((s, w) => s + idf.get(w)!, 0) / all
    const asTask = score(query, doc.prompt)
    // One matching word is too little to go on, unless the query is one word.
    const matches = asTask >= MIN_SCORE || (covered >= QUERY_MIN && (held.length >= 2 || q.length === 1))
    return { doc, score: Math.max(asTask, covered), matches }
  }).sort((x, y) => Number(y.matches) - Number(x.matches) || y.score - x.score)
}
