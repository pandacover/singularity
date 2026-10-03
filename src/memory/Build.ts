/**
 * Build the memory graph from workflow records. Pure: the same records give
 * the same graph, so every build can be compared with the last one.
 *
 * - Kinds come from the records' task kinds, merged by name (the model reuses
 *   names it has seen, so the same kind keeps its name).
 * - Steps come from the records' steps, merged by name across kinds. Where
 *   they happen is collected per subject: the files they edit, landmarks
 *   (each counted by the records that found it) and the commands that
 *   checked them.
 * - A kind's route lists the steps its records took, in their usual order.
 *   A step is required if every record of the kind took it and none did it
 *   on its own initiative; otherwise it is optional, with a condition.
 * - Warnings come from lessons (the model's) and from detours with an exact
 *   trigger the log itself gives (a command that failed until a word was
 *   dropped, an edit whose text matched twice). Lessons about the same
 *   mistake merge: same trigger, or similar words in the same step. Of the
 *   triggers a merged warning has, it keeps the one that fits the most of its
 *   detours.
 * - Reach starts at the subjects of an item's evidence. A warning about the
 *   agent's own tools reaches the whole tenant once two subjects saw it; one
 *   about a command, every subject whose repo uses that command's tools.
 */
import { textSimilarity } from "../graph/Similarity.ts"
import type { Detour, Lesson, WorkflowRecord } from "../records/Models.ts"
import { checksOf, keyWord, segmentFor } from "../records/Shell.ts"
import type { ToolEvent, Trigger } from "../records/Triggers.ts"
import { matchTrigger, triggerKey, triggerProblem } from "../records/Triggers.ts"
import type { Kind, MemoryGraph, Place, Reach, RouteEntry, SeenLandmark, Step, Warning } from "./Models.ts"

/** An id from a name: `k-change-an-action-s-keyboard-shortcut`. */
export const slug = (prefix: string, name: string): string =>
  `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x"}`

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")

/** The id a step or kind gets from its name, so the same name always means the same item. */
export const stepIdOf = (name: string): string => slug("s", norm(name))
export const kindIdOf = (name: string): string => slug("k", norm(name))

const median = (xs: ReadonlyArray<number>): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The most common value, the first seen on ties. */
const mostCommon = <A>(xs: ReadonlyArray<A>, key: (a: A) => string = String): A | undefined => {
  const counts = new Map<string, { a: A; n: number }>()
  for (const x of xs) {
    const k = key(x)
    const e = counts.get(k)
    if (e === undefined) counts.set(k, { a: x, n: 1 })
    else e.n++
  }
  let best: { a: A; n: number } | undefined
  for (const e of counts.values()) if (best === undefined || e.n > best.n) best = e
  return best?.a
}

/** Distinct values seen at least `min` times, most often first. */
const byCount = (xs: ReadonlyArray<string>, min = 1): Array<string> => {
  const counts = new Map<string, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([x]) => x)
}

const subjectReach = (subjects: Iterable<string>): Reach => ({ scope: "subject", subjects: [...new Set(subjects)].sort(), tools: [] })

/** How a candidate warning came about. */
interface LessonSource {
  readonly record: WorkflowRecord
  /** Index into the record's detours; undefined for false leads. */
  readonly detour: number | undefined
  readonly lesson: string
  /** A model's lesson, rather than one written from the log alone. */
  readonly fromModel: boolean
  readonly stepName: string | null
  readonly kindName: string | null
  readonly trigger: Trigger | null
  readonly falseLead: { readonly what: string; readonly file: string | null } | undefined
}

/**
 * Whether `text` names one of the record's own values (the feature, the
 * key): text meant for other tasks shouldn't. Values the model wrote with
 * details in parentheses count by each part.
 */
export const namesValue = (text: string, r: WorkflowRecord): boolean =>
  valuePatterns(r).some(({ pattern }) => pattern.test(text))

/** The parts of a value the model wrote with details: "Alt+K (CODES.K / KeyK)" is three. A path stays whole. */
const valueParts = (value: string): Array<string> => value.split(/[(),;]|\s\/\s/).map((part) => part.trim())

/** Words in identifiers and paths: "actionToggleZenMode.tsx" is action, toggle, zen, mode, tsx. */
const identifierWords = (s: string): Array<string> =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "")

/**
 * Whether a file is the task's own: its name holds one of the record's
 * values as words (`actionToggleZenMode.tsx` for "zen mode",
 * `actionToggleMinimap.tsx` for "minimap"). Another task edits its own file
 * there, so the file isn't where the step happens for other tasks.
 */
export const namesValueFile = (file: string, r: WorkflowRecord): boolean => {
  const name = identifierWords(file.replace(/\\/g, "/").split("/").pop() ?? file)
  return (r.model?.values ?? []).flatMap((v) => valueParts(v.value)).some((part) => {
    const words = identifierWords(part)
    if (words.length === 0 || words.join("").length < 3) return false
    return name.some((_, i) => words.every((w, j) => name[i + j] === w))
  })
}

/**
 * Each of the record's values (each part, for values like "Alt+K (CODES.K)")
 * as a whole-word pattern, with its name. Single letters count only as
 * capitals ("R", not "a"); short values match case and all.
 */
const valuePatterns = (r: WorkflowRecord): Array<{ readonly pattern: RegExp; readonly name: string }> =>
  (r.model?.values ?? []).flatMap((v) =>
    valueParts(v.value).filter((part) => part.length >= 2 || /^[A-Z0-9]$/.test(part))
      .map((part) => ({
        pattern: new RegExp(
          `(^|[^A-Za-z0-9])${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9])`,
          part.length <= 2 ? "g" : "gi"
        ),
        name: v.name.trim().toLowerCase()
      }))
  ).sort((a, b) => b.pattern.source.length - a.pattern.source.length)

/** `text` with the record's values replaced by their names: "Verify Alt+K toggles stats" → "Verify the new key toggles the action". */
export const generalize = (text: string, r: WorkflowRecord): string => {
  let out = text
  for (const { name, pattern } of valuePatterns(r)) {
    const bare = name.replace(/^(the|a|an) /, "")
    out = out.replace(pattern, (_m, before: string, offset: number, whole: string) => {
      // "the Alt+S shortcut" becomes "the old key shortcut", not "the the old key shortcut".
      const article = /\b(the|a|an|its|their)\s*$/i.test(whole.slice(0, offset + before.length)) ? "" : "the "
      return `${before}${article}${bare}`
    })
  }
  return out
}

/** The text most like the others: the most typical wording of one thing said several ways. */
const medoid = (texts: ReadonlyArray<string>): string | undefined => {
  let best: string | undefined
  let bestScore = -1
  for (const t of texts) {
    const score = texts.reduce((s, o) => s + textSimilarity(t, o), 0)
    if (score > bestScore || (score === bestScore && best !== undefined && t.length < best.length)) {
      best = t
      bestScore = score
    }
  }
  return best
}

/**
 * The most typical text among those that don't name their record's own
 * values; if every one does, the most typical with its values replaced by
 * their names.
 */
export const generalText = (uses: ReadonlyArray<{ readonly text: string; readonly record: WorkflowRecord }>): string | undefined => {
  const nonEmpty = uses.filter((u) => u.text.trim() !== "")
  const general = nonEmpty.filter((u) => !namesValue(u.text, u.record)).map((u) => u.text)
  return medoid(general.length > 0 ? general : nonEmpty.map((u) => generalize(u.text, u.record)))
}

/**
 * A trigger the log itself gives, without a model: a command that failed
 * until some words were dropped from it (`test:update` with `--watch=false`),
 * or an edit that failed because its text matched several places.
 */
export const mechanicalTrigger = (d: Detour): Trigger | null => {
  if (d.kind === "edit_mismatch") {
    const phrase = /matches of the string to replace/.test(d.symptom)
      ? "matches of the string to replace"
      : /String to replace not found/.test(d.symptom)
      ? "String to replace not found"
      : undefined
    return phrase === undefined ? null : { on: "error", all: [phrase], none: [], file: null }
  }
  // Only a fix that dropped flags and changed nothing else says the flags were the mistake.
  if (d.failed.command !== null && d.removed.length > 0 && d.added.length === 0 && d.removed.every((w) => w.startsWith("-"))) {
    const key = d.keys.find((k) => segmentFor(d.failed.command!, k)?.words.some((w) => d.removed.includes(w)))
    if (key === undefined) return null
    const trigger: Trigger = { on: "command", all: [keyWord(key), ...new Set(d.removed)], none: [], file: null }
    return triggerProblem(trigger) === undefined ? trigger : null
  }
  return null
}

/** The lesson a detour teaches when no model has read the record. */
export const mechanicalLesson = (d: Detour): string => {
  if (d.kind === "edit_mismatch") {
    return /matches of the string to replace/.test(d.symptom)
      ? "An edit failed because its old text appears in more than one place; include enough surrounding lines to make it unique."
      : "An edit failed because its old text wasn't in the file; read the file again before editing it."
  }
  const what = d.symptom.split("\n")[0] ?? ""
  const dropped = d.removed.map((w) => `\`${w}\``).join(" ")
  return `\`${keyWord(d.keys[0] ?? "")}\` failed with ${dropped} (${what}); it worked without ${d.removed.length === 1 ? "it" : "them"}.`
}

export interface BuildOptions {
  readonly tenant: string
  /** The last committed graph: conditions written for it are kept while their evidence holds. */
  readonly previous?: MemoryGraph | undefined
  /**
   * Whether `trigger` fits the mistake in a record's detour: it matches the
   * failed call (an edit trigger: an edit before it) and not the fix.
   * Undefined when the log isn't available.
   */
  readonly fits?: ((trigger: Trigger, record: WorkflowRecord, detour: number) => boolean | undefined) | undefined
}

/**
 * Each read record's kind. Runs of the same task are the same kind, whatever
 * each reading called it: the name most of them used wins.
 */
export const kindNames = (records: ReadonlyArray<WorkflowRecord>): Map<string, string> => {
  const byPrompt = new Map<string, Array<WorkflowRecord>>()
  for (const r of records) {
    if (r.model === null) continue
    byPrompt.set(norm(r.task.prompt), [...(byPrompt.get(norm(r.task.prompt)) ?? []), r])
  }
  const kindOf = new Map<string, string>()
  for (const rs of byPrompt.values()) {
    const name = mostCommon(rs.map((r) => norm(r.model!.kind.name)))!
    for (const r of rs) kindOf.set(r.id, name)
  }
  return kindOf
}

/** Lessons whose words are at least this similar, in the same step, are the same mistake. */
const SAME_LESSON = 0.35
/** Landmarks in one file whose facts are at least this similar are the same fact. */
const SAME_FACT = 0.4

export const buildGraph = (records: ReadonlyArray<WorkflowRecord>, options: BuildOptions): MemoryGraph => {
  const tenant = options.tenant
  const read = records.filter((r) => r.model !== null && r.run.outcome === "success")

  // --- steps ---
  const stepNames = new Map<string, Array<{ record: WorkflowRecord; step: NonNullable<WorkflowRecord["model"]>["steps"][number] }>>()
  for (const r of read) {
    for (const s of r.model!.steps) {
      const key = norm(s.name)
      stepNames.set(key, [...(stepNames.get(key) ?? []), { record: r, step: s }])
    }
  }
  const stepId = stepIdOf
  const steps: Array<Step> = [...stepNames.values()].map((uses) => {
    const bySubject = new Map<string, typeof uses>()
    for (const u of uses) bySubject.set(u.record.subject, [...(bySubject.get(u.record.subject) ?? []), u])
    const where: Record<string, Place> = {}
    for (const [subject, us] of [...bySubject.entries()].sort()) {
      // The same fact in other words, in the same file, is one landmark; facts that name one task's values aren't kept.
      const landmarks: Array<SeenLandmark> = []
      for (const u of us) {
        for (const l of u.step.landmarks) {
          if (namesValue(l.fact, u.record)) continue
          const i = landmarks.findIndex((m) => m.file === l.file && textSimilarity(m.fact, l.fact) >= SAME_FACT)
          if (i < 0) landmarks.push({ ...l, seen: 1 })
          else landmarks[i] = { ...landmarks[i], seen: landmarks[i].seen + 1 }
        }
      }
      const runs = new Set(us.map((u) => u.record.id)).size
      // Where the step happens: files its runs edited, but not a task's own (named after its feature).
      const fileCounts = new Map<string, Set<string>>()
      for (const u of us) {
        for (const f of u.step.files) {
          if (!namesValueFile(f, u.record)) fileCounts.set(f, (fileCounts.get(f) ?? new Set()).add(u.record.id))
        }
      }
      where[subject] = {
        runs,
        files: [...fileCounts.entries()]
          .map(([path, ids]) => ({ path, seen: ids.size }))
          .sort((a, b) => b.seen - a.seen || a.path.localeCompare(b.path))
          .slice(0, 8),
        landmarks: landmarks.sort((a, b) => b.seen - a.seen || a.file.localeCompare(b.file)).slice(0, 4),
        // A check two runs used isn't tied to one task's test names or files.
        checks: byCount(us.flatMap((u) => (u.step.check === null ? [] : [checksOf(u.step.check)])), 2).slice(0, 3)
      }
    }
    const name = mostCommon(uses.map((u) => u.step.name))!
    return {
      id: stepId(name),
      type: "step",
      tenant,
      reach: subjectReach(uses.map((u) => u.record.subject)),
      name,
      purpose: generalText(uses.map((u) => ({ text: u.step.purpose, record: u.record }))) ?? "",
      where,
      evidence: [...new Set(uses.map((u) => u.record.id))].sort()
    } satisfies Step
  })

  // --- kinds and their routes ---
  const kindOf = kindNames(read)
  const kindGroups = new Map<string, Array<WorkflowRecord>>()
  for (const r of read) {
    const key = kindOf.get(r.id)!
    kindGroups.set(key, [...(kindGroups.get(key) ?? []), r])
  }
  const previousRoutes = new Map((options.previous?.kinds ?? []).map((k) => [k.id, new Map(k.route.map((e) => [e.step, e]))]))
  const kinds: Array<Kind> = [...kindGroups.values()].map((rs) => {
    const name = mostCommon(rs.map((r) => r.model!.kind.name))!
    const id = kindIdOf(name)
    const positions = new Map<string, Array<number>>()
    const counts = new Map<string, { taken: number; asked: number; needed: number; chosen: number }>()
    for (const r of rs) {
      const ss = r.model!.steps
      const seen = new Set<string>()
      ss.forEach((s, i) => {
        const sid = stepId(s.name)
        positions.set(sid, [...(positions.get(sid) ?? []), ss.length <= 1 ? 0 : i / (ss.length - 1)])
        if (seen.has(sid)) return
        seen.add(sid)
        const c = counts.get(sid) ?? { taken: 0, asked: 0, needed: 0, chosen: 0 }
        c.taken++
        c[s.origin]++
        counts.set(sid, c)
      })
    }
    const old = previousRoutes.get(id)
    const route: Array<RouteEntry> = [...counts.entries()]
      .sort((a, b) => median(positions.get(a[0])!) - median(positions.get(b[0])!) || (a[0] < b[0] ? -1 : 1))
      .map(([step, c]) => {
        const required = c.taken === rs.length && c.chosen === 0
        const before = old?.get(step)
        const sameEvidence = before !== undefined && before.taken === c.taken && before.asked === c.asked &&
          before.needed === c.needed && before.chosen === c.chosen && before.required === required
        return {
          step,
          required,
          condition: required ? null : sameEvidence && before.condition !== null ? before.condition : defaultCondition(c),
          ...c
        }
      })
    return {
      id,
      type: "kind",
      tenant,
      reach: subjectReach(rs.map((r) => r.subject)),
      name,
      description: mostCommon(rs.map((r) => r.model!.kind.description)) ?? "",
      examples: [...new Set(rs.map((r) => r.task.prompt.trim()))].slice(0, 8),
      route,
      evidence: rs.map((r) => r.id).sort()
    } satisfies Kind
  })

  // --- warnings ---
  const sources: Array<LessonSource> = []
  for (const r of records) {
    const lessons = new Map<number, Lesson>((r.model?.lessons ?? []).map((l) => [l.detour, l]))
    r.detours.forEach((d, i) => {
      const l = lessons.get(i)
      const modelTrigger = l?.trigger ?? null
      const trigger = modelTrigger !== null && triggerProblem(modelTrigger) === undefined ? modelTrigger : mechanicalTrigger(d)
      // A detour no model has explained still counts when the log gives its trigger.
      if (l === undefined && trigger === null) return
      sources.push({
        record: r,
        detour: i,
        lesson: l?.lesson ?? mechanicalLesson(d),
        fromModel: l !== undefined,
        stepName: l?.step ?? null,
        kindName: l === undefined ? null : kindOf.get(r.id) ?? null,
        trigger,
        falseLead: undefined
      })
    })
    for (const f of r.model?.false_leads ?? []) {
      sources.push({
        record: r,
        detour: undefined,
        lesson: f.what,
        fromModel: true,
        stepName: null,
        kindName: kindOf.get(r.id) ?? r.model!.kind.name,
        trigger: null,
        falseLead: { what: f.what, file: f.file }
      })
    }
  }
  const fits = (t: Trigger, s: LessonSource): boolean =>
    s.detour !== undefined && causes(t, s.record.detours[s.detour]) &&
    (options.fits?.(t, s.record, s.detour) ?? storedFit(t, s.record.detours[s.detour]))
  const warnings = mergeLessons(sources, fits)
    // A false lead one run reported may be that run's own confusion; two runs make it a fact.
    .filter((group) => group[0].falseLead === undefined || new Set(group.map((s) => s.record.id)).size >= 2)
    .map((group) => warningOf(group, tenant, stepId, fits))
  // Two warnings may have ended up with the same id; keep the better-supported one.
  const byId = new Map<string, Warning>()
  for (const w of warnings) {
    const seen = byId.get(w.id)
    if (seen === undefined || w.seen > seen.seen) byId.set(w.id, w)
  }

  const sortById = <A extends { id: string }>(xs: ReadonlyArray<A>) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { kinds: sortById(kinds), steps: sortById(steps), warnings: sortById([...byId.values()]) }
}

const defaultCondition = (c: { taken: number; asked: number; needed: number; chosen: number }): string =>
  c.asked + c.needed === 0
    ? "only when the task asks for it"
    : c.chosen > 0 && c.asked > 0 && c.needed === 0
    ? "when the task asks for it"
    : "when the change needs it: some tasks of this kind did, some didn't"

/**
 * Whether what a trigger looks for can be the cause of a detour of this kind:
 * a command can be wrong in itself (a bad flag, a missing program), while a
 * test that failed after `yarn test:update` was run failed for another
 * reason, even if the command matches. Edits cause failing tests and type
 * errors, never a bad command line.
 */
export const causes = (t: Trigger, d: Detour): boolean =>
  t.on === "command"
    ? d.kind === "command_error" || d.kind === "not_found"
    : t.on === "edit"
    ? d.kind === "test_failure" || d.kind === "type_error"
    : true

/**
 * Whether a trigger fits a detour by what the record kept of it: the failed
 * command (or the failure's text) and the command that fixed it. Edit
 * triggers need the log; without it they fit only their own detour.
 */
export const storedFit = (t: Trigger, d: Detour): boolean => {
  const event = (c: Detour["failed"], failed: boolean): ToolEvent => ({
    tool: c.tool,
    command: c.command ?? undefined,
    file: c.file ?? undefined,
    text: undefined,
    output: failed ? d.symptom : undefined,
    failed
  })
  return t.on !== "edit" && matchTrigger(t, event(d.failed, true)) && !matchTrigger(t, event(d.fixed, false))
}

/**
 * Single-link clusters of lessons about the same mistake: the same trigger, a
 * trigger that fits the other's detour, or similar words in the same step (or kind).
 */
const mergeLessons = (
  sources: ReadonlyArray<LessonSource>,
  fits: (t: Trigger, s: LessonSource) => boolean
): Array<Array<LessonSource>> => {
  const parent = sources.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  const place = (s: LessonSource) => norm(s.stepName ?? `kind:${s.kindName ?? ""}`)
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i]
      const b = sources[j]
      if (a.falseLead !== undefined || b.falseLead !== undefined) {
        // False leads: the same file, said in similar words, in the same kind of task.
        const same = a.falseLead !== undefined && b.falseLead !== undefined && a.kindName === b.kindName &&
          a.falseLead.file === b.falseLead.file && textSimilarity(a.falseLead.what, b.falseLead.what) >= SAME_LESSON
        if (same) union(i, j)
        continue
      }
      const sameTrigger = a.trigger !== null && b.trigger !== null && triggerKey(a.trigger) === triggerKey(b.trigger)
      const crossFit = (a.trigger !== null && fits(a.trigger, b)) || (b.trigger !== null && fits(b.trigger, a))
      const similar = place(a) === place(b) && textSimilarity(a.lesson, b.lesson) >= SAME_LESSON
      if (sameTrigger || crossFit || similar) union(i, j)
    }
  }
  const groups = new Map<number, Array<LessonSource>>()
  sources.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]))
  return [...groups.values()]
}

const warningOf = (
  group: ReadonlyArray<LessonSource>,
  tenant: string,
  stepId: (name: string) => string,
  fits: (t: Trigger, s: LessonSource) => boolean
): Warning => {
  // The trigger that fits the most of the group's detours; ties to the most common, then the most specific.
  const candidates = [...new Map(group.flatMap((s) => (s.trigger === null ? [] : [[triggerKey(s.trigger), s.trigger] as const]))).values()]
    .filter((t) => triggerProblem(t) === undefined)
  const detours = group.filter((s) => s.detour !== undefined)
  const score = (t: Trigger) =>
    detours.filter((s) => fits(t, s) || (s.trigger !== null && triggerKey(s.trigger) === triggerKey(t))).length
  const uses = (t: Trigger) => group.filter((s) => s.trigger !== null && triggerKey(s.trigger) === triggerKey(t)).length
  const trigger = candidates
    .map((t) => ({ t, score: score(t), uses: uses(t), size: t.all.length + t.none.length }))
    .sort((a, b) => b.score - a.score || b.uses - a.uses || b.size - a.size)[0]?.t ?? null
  // The most typical model lesson that doesn't name one task's values, preferring
  // those that came with the chosen trigger; the log's own wording only if no model read the detour.
  const modelLessons = group.filter((s) => s.fromModel)
  const withTrigger = trigger === null ? [] : modelLessons.filter((s) => s.trigger !== null && triggerKey(s.trigger) === triggerKey(trigger))
  const pool = withTrigger.length > 0 ? withTrigger : modelLessons.length > 0 ? modelLessons : group
  const lessonText = generalText(pool.map((s) => ({ text: s.lesson, record: s.record }))) ?? group[0].lesson
  const falseLead = group[0].falseLead
  const lesson = falseLead === undefined
    ? lessonText
    : `False lead: ${lessonText}${falseLead.file === null ? "" : ` (${falseLead.file})`}`
  const stepName = mostCommon(group.flatMap((s) => (s.stepName === null ? [] : [s.stepName])))
  const kindName = stepName === undefined ? mostCommon(group.flatMap((s) => (s.kindName === null ? [] : [s.kindName]))) : undefined
  const costs = detours.map((s) => s.record.detours[s.detour!].cost)
  const subjects = new Set(group.map((s) => s.record.subject))
  const toolLesson = trigger !== null && trigger.on === "error" && stepName === undefined && kindName === undefined
  const reach: Reach = subjects.size >= 2 && trigger !== null
    ? toolLesson
      ? { scope: "tenant", subjects: [...subjects].sort(), tools: [] }
      : trigger.on === "command"
      ? { scope: "tools", subjects: [...subjects].sort(), tools: commandTools(group) }
      : subjectReach(subjects)
    : subjectReach(subjects)
  const attached = stepName !== undefined || kindName !== undefined
  const id = trigger !== null
    ? `w-${hash(triggerKey(trigger))}`
    // Named after its earliest evidence, which later builds keep.
    : `w-${hash(group.map((s) => `${s.record.id}#${s.detour ?? s.lesson}`).sort()[0])}`
  return {
    id,
    type: "warning",
    tenant,
    reach,
    lesson,
    step: stepName === undefined ? null : stepId(stepName),
    kind: kindName === undefined ? null : kindIdOf(kindName),
    trigger,
    moment: trigger === null ? "start" : attached ? "both" : "trigger",
    cost: {
      tokens: Math.round(median(costs.map((c) => c.tokens))),
      turns: Math.round(median(costs.map((c) => c.turns)))
    },
    seen: detours.length || new Set(group.map((s) => s.record.id)).size,
    evidence: [...new Set(group.map((s) => s.record.id))].sort()
  }
}

/** The programs a command warning is about (`yarn`), for reaching other repos that use them. */
const commandTools = (group: ReadonlyArray<LessonSource>): Array<string> => {
  const programs = group.flatMap((s) => (s.detour === undefined ? [] : s.record.detours[s.detour].keys.map((k) => k.split(" ")[0])))
  const top = mostCommon(programs)
  return top === undefined ? [] : [top]
}

/** A short stable hash, for ids. */
const hash = (s: string): string => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
