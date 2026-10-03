/**
 * Close calls between steps: two names that may be the same step, said two
 * ways ("add the key to the KEYS table", "add the key code to the KEYS
 * table"). Exact names are matched first, when records are read; what's left
 * is decided by a model, once per pair, and the decision is kept:
 *
 *     <memory dir>/aliases.json   { merged: [{ from, to }], distinct: [[a, b]] }
 *
 * A pair is a close call when no run took both (a run that did both proves
 * they differ), their names share most words, and they edit the same files
 * or no files at all. The graph is built with merged names replaced.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { textSimilarity } from "../graph/Similarity.ts"
import { callStructured } from "../eval/Llm.ts"
import type { WorkflowRecord } from "../records/Models.ts"

export const Aliases = Schema.Struct({
  merged: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  distinct: Schema.Array(Schema.Tuple([Schema.String, Schema.String]))
})
export type Aliases = typeof Aliases.Type

export const noAliases: Aliases = { merged: [], distinct: [] }

/** Names at least this similar may be one step. */
export const CLOSE_NAMES = 0.5

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")
const pairKey = (a: string, b: string) => [norm(a), norm(b)].sort().join("\u0000")

/** A step name with merges followed to the end. */
export const resolve = (aliases: Aliases, name: string): string => {
  const to = new Map(aliases.merged.map((m) => [norm(m.from), m.to]))
  let current = name
  const seen = new Set<string>()
  while (to.has(norm(current)) && !seen.has(norm(current))) {
    seen.add(norm(current))
    current = to.get(norm(current))!
  }
  return current
}

/** Records with merged step names replaced, in their steps and lessons. */
export const applyAliases = (records: ReadonlyArray<WorkflowRecord>, aliases: Aliases): Array<WorkflowRecord> =>
  aliases.merged.length === 0 ? [...records] : records.map((r) =>
    r.model === null ? r : {
      ...r,
      model: {
        ...r.model,
        steps: r.model.steps.map((s) => ({ ...s, name: resolve(aliases, s.name) })),
        lessons: r.model.lessons.map((l) => ({ ...l, step: l.step === null ? null : resolve(aliases, l.step) }))
      }
    }
  )

export interface StepUse {
  readonly name: string
  readonly purpose: string
  readonly files: ReadonlySet<string>
  readonly prompts: ReadonlyArray<string>
}

/** Pairs of step names that may be one step and haven't been decided yet. */
export const closeCalls = (records: ReadonlyArray<WorkflowRecord>, aliases: Aliases): Array<readonly [StepUse, StepUse]> => {
  const uses = new Map<string, { name: string; purpose: string; files: Set<string>; prompts: Set<string>; records: Set<string> }>()
  for (const r of records) {
    for (const s of r.model?.steps ?? []) {
      const key = norm(s.name)
      const u = uses.get(key) ?? { name: s.name, purpose: s.purpose, files: new Set(), prompts: new Set(), records: new Set() }
      for (const f of s.files) u.files.add(f)
      u.prompts.add(r.task.prompt.trim())
      u.records.add(r.id)
      uses.set(key, u)
    }
  }
  const decided = new Set([...aliases.distinct.map(([a, b]) => pairKey(a, b)), ...aliases.merged.map((m) => pairKey(m.from, m.to))])
  const all = [...uses.values()]
  const pairs: Array<readonly [StepUse, StepUse]> = []
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]
      const b = all[j]
      if (decided.has(pairKey(a.name, b.name))) continue
      if ([...a.records].some((id) => b.records.has(id))) continue
      const sameFiles = (a.files.size === 0 && b.files.size === 0) || [...a.files].some((f) => b.files.has(f))
      if (!sameFiles || textSimilarity(a.name, b.name) < CLOSE_NAMES) continue
      const use = (u: typeof a): StepUse => ({ name: u.name, purpose: u.purpose, files: u.files, prompts: [...u.prompts].slice(0, 2) })
      pairs.push([use(a), use(b)])
    }
  }
  return pairs
}

export const MERGE_PROMPT = `You keep the vocabulary of steps that a coding agent's procedures are made of, in one repository. The same step sometimes gets two names. For each pair below, decide whether the two names are the same step: the same change to the same place, so that a task needing one needs the other. Steps that do different things to the same file are different steps (adding an entry to a table is not replacing one). If they are the same, give the name to keep: the clearer and more general of the two, unchanged.`

export const MergeAnswer = Schema.Struct({
  pairs: Schema.Array(Schema.Struct({ a: Schema.String, b: Schema.String, same: Schema.Boolean, keep: Schema.String, why: Schema.String }))
})

const describeUse = (u: StepUse) =>
  [`"${u.name}": ${u.purpose}`, `  files: ${[...u.files].join(", ") || "(none)"}`, ...u.prompts.map((p) => `  in a task like: ${p.replace(/\s+/g, " ").slice(0, 200)}`)].join("\n")

export const mergePrompt = (pairs: ReadonlyArray<readonly [StepUse, StepUse]>): string =>
  pairs.map(([a, b], i) => `## Pair ${i + 1}\n\n- a: ${describeUse(a)}\n- b: ${describeUse(b)}`).join("\n\n")

export interface MergeConfig {
  readonly claude: ReadonlyArray<string>
  readonly cwd: string
  readonly model: string
}

const aliasFile = (dir: string, path: Path.Path) => path.join(dir, "aliases.json")

export const readAliases = Effect.fn("readAliases")(function*(memoryDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = aliasFile(memoryDir, path)
  if (!(yield* fs.exists(file))) return noAliases
  const text = yield* fs.readFileString(file)
  return Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(Aliases))(text), () => noAliases)
})

const writeAliases = Effect.fn("writeAliases")(function*(memoryDir: string, aliases: Aliases) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(memoryDir, { recursive: true })
  yield* fs.writeFileString(aliasFile(memoryDir, path), JSON.stringify(aliases, null, 2) + "\n")
})

/** Ask about the undecided close calls, keep the answers, and return all decisions so far with the cost. */
export const decideCloseCalls = Effect.fn("decideCloseCalls")(function*(
  memoryDir: string,
  records: ReadonlyArray<WorkflowRecord>,
  config: MergeConfig | undefined
) {
  const aliases = yield* readAliases(memoryDir)
  const pairs = closeCalls(applyAliases(records, aliases), aliases)
  if (pairs.length === 0 || config === undefined) return { aliases, costUsd: 0, asked: 0 }
  const answer = yield* callStructured({
    claude: config.claude,
    system: MERGE_PROMPT,
    prompt: mergePrompt(pairs),
    schema: MergeAnswer,
    model: config.model,
    thinking: false,
    cwd: config.cwd,
    maxBudgetUsd: 0.5,
    timeoutS: 300
  })
  const merged = [...aliases.merged]
  const distinct = [...aliases.distinct]
  for (const [a, b] of pairs) {
    const said = answer.value.pairs.find((p) => pairKey(p.a, p.b) === pairKey(a.name, b.name))
    if (said === undefined) continue
    if (said.same && (norm(said.keep) === norm(a.name) || norm(said.keep) === norm(b.name))) {
      const keep = norm(said.keep) === norm(a.name) ? a.name : b.name
      merged.push({ from: keep === a.name ? b.name : a.name, to: keep })
    } else {
      distinct.push([a.name, b.name])
    }
  }
  const next = { merged, distinct }
  yield* writeAliases(memoryDir, next)
  return { aliases: next, costUsd: answer.costUsd ?? 0, asked: pairs.length }
})
