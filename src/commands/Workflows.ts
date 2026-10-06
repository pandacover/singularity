/**
 * `singularity workflows ...`: memory v1, workflows with blanks in a graph.
 *
 *     workflows build [--task ID ...] [--repo DIR] [--fresh] [--dry-run]   induce from the records
 *     workflows show [AT] [--json]                                         print a version or candidate
 *     workflows candidates                                                 proposals and what became of them
 *     workflows handover TASK... [--cwd REPO] [--at COMMIT] [--pick cues|words|model] [--draft]   preview a task's hand-over
 *     workflows evolve [--task ID ...] [--records-from HOME] [--repo DIR]    learn from new runs
 *     workflows cues [--repo DIR] [--dry-run]                              write cues for picking without a model
 *     workflows finish [--repo DIR]                                        learn what the checks rewrite (no model)
 *
 * Local first: at task start memory is picked by its cues, with no model
 * call (`--pick cues`, the hook's default). Building memory, writing its cues
 * and learning from runs use a model, once per batch of runs. A build writes
 * workflows without cues: run `workflows cues` after it. A learning round on
 * memory with cues writes them again for its revision, and its gate replays
 * with them. Builds and learning rounds learn what each workflow's checks
 * rewrite (Finish.ts), so the hand-over ends with one command; `workflows
 * finish` adds that to memory built before.
 */
import { Console, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defaultClaude } from "../eval/Agent.ts"
import { lowerPriority } from "../eval/Proc.ts"
import { defaultWorkspaces } from "../eval/Runner.ts"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"
import type { WorkflowRecord } from "../records/Models.ts"
import { RecordStore } from "../records/RecordStore.ts"
import { cuesPrompt, writeCues } from "../workflows/CueWriter.ts"
import { describeMemory } from "../workflows/Describe.ts"
import { gatherEvidence } from "../workflows/Evidence.ts"
import { hasCues } from "../workflows/Cues.ts"
import { describeReplay, handedTexts, lookupsText, passes, refine, replay, shownInRecord } from "../workflows/Evolve.ts"
import { withSnapshots } from "../workflows/Finish.ts"
import { DEFAULT_INDUCE_EFFORT, DEFAULT_INDUCE_MODEL, induce } from "../workflows/Induce.ts"
import * as JsonWorkflowStore from "../workflows/JsonWorkflowStore.ts"
import { startTask } from "../workflows/Start.ts"
import { WorkflowStore } from "../workflows/WorkflowStore.ts"
import { homeFlag, recordsLayer } from "./Common.ts"

/** The workflow store of the home's tenant. */
export const workflowsLayer = (home: Option.Option<string>) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const h = yield* loadHome(Option.getOrUndefined(home))
      const path = yield* Path.Path
      return JsonWorkflowStore.layer(JsonWorkflowStore.workflowsDir(h.tenantDir, path), h.tenant)
    })
  )

const bothLayers = (home: Option.Option<string>) => Layer.merge(recordsLayer(home), workflowsLayer(home))

const atOf = (at: Option.Option<string>) => Option.match(at, { onNone: () => undefined, onSome: (a) => (/^\d+$/.test(a) ? Number(a) : a) })

const build = Command.make(
  "build",
  {
    task: Flag.String("task").pipe(Flag.atLeast(0), Flag.withDescription("only the records of this eval task (repeatable)")),
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("a clone to read files at the runs' base commits from")),
    fresh: Flag.Boolean("fresh").pipe(Flag.withDefault(false), Flag.withDescription("induce from nothing instead of revising the head")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_INDUCE_MODEL)),
    effort: Flag.String("effort").pipe(Flag.withDefault(DEFAULT_INDUCE_EFFORT)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("show the evidence the model would read, and stop")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const records = (yield* (yield* RecordStore).find({ outcome: "success" }))
      .filter((r) => args.task.length === 0 || (r.run.task_id !== null && args.task.includes(r.run.task_id)))
    const evidence = yield* gatherEvidence(records, { repo: Option.getOrUndefined(args.repo) })
    yield* Console.log(`${evidence.runs.length} runs of ${new Set(evidence.runs.map((r) => r.task)).size} tasks; ${evidence.places.length} places`)
    for (const s of evidence.skipped) yield* Console.log(`  skipped ${s}`)
    if (args.dryRun) return
    const store = yield* WorkflowStore
    const baseVersion = yield* store.head()
    const current = args.fresh ? undefined : yield* store.memory()
    const cwd = path.join(defaultWorkspaces(), "_learner")
    yield* fs.makeDirectory(cwd, { recursive: true })
    const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
    const result = yield* induce({ claude, cwd, model: args.model, effort: args.effort }, evidence, store.tenant, current)
    const m = withSnapshots(result.memory, evidence.runs)
    yield* Console.log(`${m.workflows.length} workflows, ${m.places.length} places, ${m.pitfalls.length} pitfalls, ${m.edges.length} edges; ` +
      `${result.calls} model call${result.calls === 1 ? "" : "s"}, $${result.costUsd.toFixed(3)}`)
    for (const p of result.problems) yield* Console.log(`  ${p}`)
    const candidate = yield* store.propose(m, {
      baseVersion,
      rationale: result.rationale,
      records: evidence.runs.map((r) => r.record),
      model: args.model,
      costUsd: result.costUsd,
      report: { problems: result.problems, replay: null }
    })
    if (m.workflows.length === 0) {
      yield* store.reject(candidate.id, "no workflows")
      return yield* Console.log(`rejected ${candidate.id}: no workflows`)
    }
    const version = yield* store.commit(candidate.id)
    yield* Console.log(`committed ${candidate.id} as version ${version}`)
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("induce workflows, their graph and pitfalls from the records (one model call or two)"))

const show = Command.make(
  "show",
  {
    at: Argument.String("at").pipe(Argument.optional, Argument.withDescription("a version number or candidate id (default: the head)")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const store = yield* WorkflowStore
    const at = atOf(args.at)
    const m = yield* store.memory(at)
    yield* Console.log(args.json ? JSON.stringify(m, null, 2) : describeMemory(m, at ?? (yield* store.head())))
  }, (effect, args) => Effect.provide(effect, workflowsLayer(args.home)))
).pipe(Command.withDescription("print the workflow memory"))

const candidates = Command.make(
  "candidates",
  { home: homeFlag },
  Effect.fn(function*(_args) {
    for (const c of yield* (yield* WorkflowStore).candidates()) {
      const r = c.report?.replay
      const nums = r == null ? "" : ` (edited ${r.edited}, shown and edited ${r.shown_and_edited}, shown unused ${r.shown_unused})`
      yield* Console.log(
        `${c.id} ${c.status.padEnd(9)} base ${c.base_version}${c.committed_version === null ? "" : ` -> ${c.committed_version}`}` +
          ` ${c.created_at} ${c.memory.workflows.length} workflows${nums}${c.reason ? `: ${c.reason}` : ""}`
      )
    }
  }, (effect, args) => Effect.provide(effect, workflowsLayer(args.home)))
).pipe(Command.withDescription("list proposals and what became of them"))

const handover = Command.make(
  "handover",
  {
    task: Argument.String("task").pipe(Argument.atLeast(1), Argument.withDescription("the task's text")),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("the repo the task is in (default: here)")),
    at: Flag.String("at").pipe(Flag.optional, Flag.withDescription("read the code at this commit instead of the working tree")),
    pick: Flag.Literals("pick", ["cues", "words", "model"]).pipe(
      Flag.withDefault("cues"),
      Flag.withDescription(
        "how workflows are picked: by memory's cues with no model call, filling the blanks the task states (the default, as the hook does; " +
          "words when memory has no cues), by shared words, or by a model call (about two cents)"
      )
    ),
    draft: Flag.Boolean("draft").pipe(Flag.withDefault(false), Flag.withDescription("hand over the change itself, drafted by the model (about 10 cents)")),
    parts: Flag.Int("parts").pipe(
      Flag.withDefault(1),
      Flag.withDescription("how many hooks carry the hand-over, each up to 9,800 characters (2 as the workflows-split setup)")
    ),
    model: Flag.String("model").pipe(Flag.withDefault("sonnet")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* loadHome(Option.getOrUndefined(args.home))
    const cwd = path.join(defaultWorkspaces(), "_learner")
    yield* fs.makeDirectory(cwd, { recursive: true })
    const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
    const selector = args.pick === "model" ? { claude, cwd, model: args.model } : undefined
    const drafter = args.draft ? { claude, cwd, model: args.model } : undefined
    const result = yield* startTask(
      { sessionId: "preview", prompt: args.task.join(" "), cwd: Option.getOrElse(args.cwd, () => process.cwd()) },
      { tenantDir: home.tenantDir, selector, drafter, cues: args.pick === "cues", persist: false, at: Option.getOrUndefined(args.at), parts: args.parts }
    )
    for (const r of result.reasons) yield* Console.log(`# ${r}`)
    if (result.state?.selection?.cost_usd != null) yield* Console.log(`# selection: $${result.state.selection.cost_usd.toFixed(4)}`)
    const d = result.draft
    if (d !== null) {
      yield* Console.log(
        `# draft: ${d.error ?? `${d.edits} edits, ${d.files.length} new files, ${d.used ? "handed over" : "not handed over"}`}` +
          `${d.cost_usd === null ? "" : `, $${d.cost_usd.toFixed(4)}`}${d.duration_s === null ? "" : ` in ${Math.round(d.duration_s)}s`}`
      )
      for (const x of d.dropped) yield* Console.log(`# left out: ${x}`)
    }
    if (result.state !== undefined && result.state.missing.length > 0) yield* Console.log(`# not found in the code: ${result.state.missing.join(", ")}`)
    const sizes = result.parts.length > 1 ? ` in ${result.parts.length} parts of ${result.parts.map((t) => t.length).join(" and ")}` : ""
    yield* Console.log(result.text === undefined ? "(nothing to hand over)" : `# ${result.text.length} characters${sizes}\n\n${result.text}`)
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("show what a task would be handed at its start, without keeping anything"))

const evolve = Command.make(
  "evolve",
  {
    task: Flag.String("task").pipe(Flag.atLeast(0), Flag.withDescription("only new runs of this eval task (repeatable)")),
    setup: Flag.String("setup").pipe(Flag.atLeast(0), Flag.withDescription("only new eval runs of this memory setup (repeatable), e.g. no-memory")),
    recordsFrom: Flag.String("records-from").pipe(
      Flag.optional,
      Flag.withDescription("take the new runs from another home's records (they are copied in if the revision is kept)")
    ),
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("a clone to read files at the runs' base commits from")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_INDUCE_MODEL)),
    effort: Flag.String("effort").pipe(Flag.withDefault(DEFAULT_INDUCE_EFFORT)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("list the new runs and what they looked up before their first edit, and stop")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const store = yield* WorkflowStore
    const own = yield* RecordStore
    const learnedIds = new Set((yield* store.candidates("committed")).flatMap((c) => c.records))
    const pick = (r: WorkflowRecord) =>
      r.run.outcome === "success" && !learnedIds.has(r.id) &&
      (args.task.length === 0 || (r.run.task_id !== null && args.task.includes(r.run.task_id))) &&
      (args.setup.length === 0 || (r.run.setup !== null && args.setup.includes(r.run.setup)))
    const from = Option.getOrUndefined(args.recordsFrom)
    const fresh = from !== undefined
      ? yield* Effect.gen(function*() {
        const other = yield* loadHome(from)
        return yield* Effect.gen(function*() {
          return yield* (yield* RecordStore).find({ outcome: "success" })
        }).pipe(Effect.provide(JsonRecordStore.layer(other.tenantDir, other.tenant)))
      })
      : yield* own.find({ outcome: "success" })
    const newRecords = fresh.filter(pick)
    const learned = (yield* own.find({ outcome: "success" })).filter((r) => learnedIds.has(r.id))
    yield* Console.log(`${newRecords.length} new runs (${[...new Set(newRecords.map((r) => r.run.task_id ?? r.id))].join(", ")}); ${learned.length} learned from before`)
    if (newRecords.length === 0) return
    const repo = Option.getOrUndefined(args.repo)
    const evidence = yield* gatherEvidence(newRecords, { repo })
    if (args.dryRun) {
      // What the refining model would read about what the runs handed memory still looked up.
      const handed = evidence.runs.flatMap((run) => {
        const r = newRecords.find((x) => x.id === run.record)
        const shown = r === undefined ? undefined : shownInRecord(r)
        return shown === undefined ? [] : [{ run, shown }]
      })
      return yield* Console.log(`
${yield* lookupsText(yield* store.memory(), handed, repo, yield* handedTexts(newRecords))}`)
    }
    const before = yield* gatherEvidence(learned, { repo })
    const cwd = path.join(defaultWorkspaces(), "_learner")
    yield* fs.makeDirectory(cwd, { recursive: true })
    const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
    const baseVersion = yield* store.head()
    const current = yield* store.memory()
    // Local first: memory picked by cues is replayed with cues, written again for the revision.
    const local = hasCues(current)
    const selector = local ? "cues" as const : { claude, cwd, model: "sonnet" }
    const refined = yield* refine(
      { claude, cwd, model: args.model, effort: args.effort },
      selector,
      current,
      evidence,
      new Map(newRecords.map((r) => [r.id, r])),
      yield* store.candidates("rejected"),
      { repo, texts: yield* handedTexts(newRecords) }
    )
    for (const p of refined.problems) yield* Console.log(`  ${p}`)
    const runs = [...before.runs, ...evidence.runs]
    let revision = withSnapshots(refined.memory, runs)
    let cueCost = 0
    if (local) {
      // The tasks memory learned from, old and new, are the examples the cues must pick right.
      const written = yield* writeCues({ claude, cwd, model: args.model, effort: args.effort }, revision, runs)
      for (const p of written.problems) yield* Console.log(`  cues: ${p}`)
      revision = written.memory
      cueCost = written.costUsd
    }
    // The gate: replayed over every run, old and new, the revision must fit at least as well.
    const now = yield* replay(current, runs, selector)
    const then = yield* replay(revision, runs, selector)
    const verdict = passes(then, now)
    const costUsd = refined.costUsd + cueCost + now.costUsd + then.costUsd
    yield* Console.log(`current:  ${describeReplay(now)}\nrevision: ${describeReplay(then)}\nmodel calls: ${costUsd.toFixed(3)}`)
    const candidate = yield* store.propose(revision, {
      baseVersion,
      rationale: refined.rationale,
      records: [...learned.map((r) => r.id), ...newRecords.map((r) => r.id)],
      model: args.model,
      costUsd,
      report: { problems: refined.problems, replay: { runs: then.runs, edited: then.edited, shown_and_edited: then.shown_and_edited, shown_unused: then.shown_unused, workflows: then.workflows } }
    })
    if (!verdict.commit) {
      yield* store.reject(candidate.id, verdict.reason)
      return yield* Console.log(`rejected ${candidate.id}: ${verdict.reason}`)
    }
    // The runs it learned from become this home's records, so later rounds know them.
    for (const r of newRecords) if (!(yield* own.has(r.id))) yield* own.put(r)
    const version = yield* store.commit(candidate.id)
    yield* Console.log(`committed ${candidate.id} as version ${version}: ${verdict.reason}`)
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("learn from new runs: revise memory from what they did and what it showed them, kept only if it fits the runs better"))

const cues = Command.make(
  "cues",
  {
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("a clone to read files at the runs' base commits from")),
    model: Flag.String("model").pipe(Flag.withDefault(DEFAULT_INDUCE_MODEL)),
    effort: Flag.String("effort").pipe(Flag.withDefault(DEFAULT_INDUCE_EFFORT)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("show what the model would read, and stop")),
    claude: Flag.String("claude").pipe(Flag.optional, Flag.withDescription("path to the claude executable")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    yield* lowerPriority
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const store = yield* WorkflowStore
    const baseVersion = yield* store.head()
    const memory = yield* store.memory()
    if (memory.workflows.length === 0) return yield* Console.log("memory has no workflows to write cues for")
    // The tasks memory learned from: the records of its committed candidates.
    const learned = new Set((yield* store.candidates("committed")).flatMap((c) => c.records))
    const records = (yield* (yield* RecordStore).find({ outcome: "success" })).filter((r) => learned.has(r.id))
    const evidence = yield* gatherEvidence(records, { repo: Option.getOrUndefined(args.repo) })
    yield* Console.log(`${memory.workflows.length} workflows; learned from ${evidence.runs.length} runs of ${new Set(evidence.runs.map((r) => r.task)).size} tasks`)
    if (args.dryRun) return yield* Console.log(`\n${cuesPrompt(memory, evidence.runs)}`)
    const cwd = path.join(defaultWorkspaces(), "_learner")
    yield* fs.makeDirectory(cwd, { recursive: true })
    const claude = Option.isSome(args.claude) ? [args.claude.value] : yield* defaultClaude()
    const result = yield* writeCues({ claude, cwd, model: args.model, effort: args.effort }, memory, evidence.runs)
    const withCues = result.memory.workflows.filter((w) => (w.cues?.any.length ?? 0) > 0).length
    yield* Console.log(`cues for ${withCues} of ${result.memory.workflows.length} workflows; ${result.calls} model call${result.calls === 1 ? "" : "s"}, $${result.costUsd.toFixed(3)}`)
    for (const p of result.problems) yield* Console.log(`  ${p}`)
    const candidate = yield* store.propose(result.memory, {
      baseVersion,
      rationale: result.rationale,
      records: evidence.runs.map((r) => r.record),
      model: args.model,
      costUsd: result.costUsd,
      report: { problems: result.problems, replay: null }
    })
    if (withCues === 0) {
      yield* store.reject(candidate.id, "no workflow got cues")
      return yield* Console.log(`rejected ${candidate.id}: no workflow got cues`)
    }
    const version = yield* store.commit(candidate.id)
    yield* Console.log(`committed ${candidate.id} as version ${version}`)
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("write cues so tasks can be given workflows without a model: phrases, step conditions and blank values (one model call or two)"))

const finish = Command.make(
  "finish",
  {
    repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription("a clone to read files at the runs' base commits from")),
    home: homeFlag
  },
  Effect.fn(function*(args) {
    const store = yield* WorkflowStore
    const baseVersion = yield* store.head()
    const memory = yield* store.memory()
    if (memory.workflows.length === 0) return yield* Console.log("memory has no workflows")
    const learned = new Set((yield* store.candidates("committed")).flatMap((c) => c.records))
    const records = (yield* (yield* RecordStore).find({ outcome: "success" })).filter((r) => learned.has(r.id))
    const evidence = yield* gatherEvidence(records, { repo: Option.getOrUndefined(args.repo) })
    const m = withSnapshots(memory, evidence.runs)
    for (const w of m.workflows) yield* Console.log(`${w.id}: ${w.snapshots?.length ? w.snapshots.join(", ") : "no snapshots every run rewrote"}`)
    const candidate = yield* store.propose(m, {
      baseVersion,
      rationale: "what each workflow's checks rewrite, from the snapshot files every run it was learned from regenerated",
      records: evidence.runs.map((r) => r.record),
      costUsd: 0,
      report: { problems: [], replay: null }
    })
    const version = yield* store.commit(candidate.id)
    yield* Console.log(`committed ${candidate.id} as version ${version}`)
  }, (effect, args) => Effect.provide(effect, bothLayers(args.home)))
).pipe(Command.withDescription("learn what each workflow's checks rewrite from the runs memory learned from, so the hand-over ends with one command (no model)"))

export const workflowsCommand = Command.make("workflows").pipe(
  Command.withDescription("memory v1: workflows with blanks, connected in a graph that learns from results"),
  Command.withSubcommands([build, show, candidates, handover, evolve, cues, finish])
)
