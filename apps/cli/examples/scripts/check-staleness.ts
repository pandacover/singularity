// The staleness rules of src/scripts/Fresh.ts replayed over real history,
// with no agent run and nothing written to the repos: for a sample of
// non-merge commits on each repo's first-parent line, each file a commit
// changed is judged as of 10, 50 and 200 commits later (read with git show
// and git grep at that revision, never the working tree). Prints, per repo
// and horizon, the share of files fresh, moved, stale and gone, the share of
// commits whose every file is stale or gone (not handed over), and those
// reverted by then; writes a sample of file verdicts to check by hand.
//
//   node apps/cli/examples/scripts/check-staleness.ts [repo ...]   (from the repo root)
//
// Defaults to /root/ws/markdownlint and /root/ws/excalidraw.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { git } from "../../src/local/Git.ts"
import { judgeFile, revertedBy, type Verdict } from "../../src/scripts/Fresh.ts"
import { fileKind } from "../../src/scripts/Render.ts"
import { pathsNow, readableChunks } from "../../src/scripts/Start.ts"

const HORIZONS = [10, 50, 200]
const PER_REPO = 150
/** Files judged per commit at most: a bulk reformat of hundreds of files would weigh as much as the rest. */
const MAX_FILES = 40
const SEED = 20261015
const repos = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["/root/ws/markdownlint", "/root/ws/excalidraw"]
const out = join(import.meta.dirname, "results", "staleness-sample.tsv")

/** A small seeded random generator (mulberry32), so the sample is the same each run. */
const random = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const sample = <A>(xs: ReadonlyArray<A>, n: number, rnd: () => number): Array<A> => {
  const copy = [...xs]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

interface Row {
  readonly repo: string
  readonly commit: string
  readonly title: string
  readonly path: string
  readonly horizon: number
  readonly rev: string
  readonly verdict: Verdict
}

const KINDS = ["fresh", "moved", "stale", "gone"] as const
const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`)

const program = Effect.gen(function*() {
  const rnd = random(SEED)
  const rows: Array<Row> = []
  for (const root of repos) {
    const name = basename(root)
    const started = Date.now()
    const line = (yield* git(root, ["rev-list", "--first-parent", "--reverse", "--parents", "HEAD"])).trim().split("\n").map((l) => l.split(" "))
    const index = line.map((ps, i) => ({ hash: ps[0], parents: ps.length - 1, i }))
    const eligible = index.filter((c) => c.parents === 1 && c.i + Math.max(...HORIZONS) < index.length)
    const picked = sample(eligible, PER_REPO, rnd)
    const scripts = new Map(HORIZONS.map((h) => [h, { all: 0, gone: 0, reverted: 0, source: 0, sourceGone: 0 }]))
    let judgedCommits = 0
    const perCommit = yield* Effect.forEach(picked, (c) =>
      Effect.gen(function*() {
        const title = (yield* git(root, ["log", "-1", "--format=%s", c.hash])).trim()
        const chunks = readableChunks(yield* git(root, ["diff", `${c.hash}^`, c.hash]).pipe(Effect.orElseSucceed(() => "")))
          .filter((ch) => /^\+(?!\+\+)/m.test(ch.text))
          .slice(0, MAX_FILES)
        const mine: Array<Row> = []
        const perHorizon: Array<{ h: number; gone: boolean; reverted: boolean; source: boolean }> = []
        if (chunks.length === 0) return { mine, perHorizon }
        // Hand-written source among its files: a dependency bump or a translation update alone isn't a script anyone reuses.
        const source = chunks.some((ch) => fileKind(ch.path) === "source")
        for (const h of HORIZONS) {
          const rev = index[c.i + h].hash
          const now = yield* pathsNow(root, c.hash, chunks.map((ch) => ch.path), rev)
          const verdicts: Array<Verdict> = []
          for (const ch of chunks) {
            const v = yield* judgeFile({ root, rev }, c.hash, { now: now.get(ch.path) ?? ch.path, chunk: ch.text })
            // A change that adds no meaningful line has nothing to judge it by.
            if (v.kind === "fresh" && v.survival === undefined) continue
            verdicts.push(v)
            mine.push({ repo: name, commit: c.hash, title, path: ch.path, horizon: h, rev, verdict: v })
          }
          const reverted = (yield* revertedBy({ root, rev }, c.hash)) !== undefined
          if (verdicts.length > 0) perHorizon.push({ h, gone: verdicts.every((v) => v.kind === "stale" || v.kind === "gone"), reverted, source })
        }
        return { mine, perHorizon }
      }), { concurrency: 6 })
    for (const { mine, perHorizon } of perCommit) {
      rows.push(...mine)
      if (perHorizon.length > 0) judgedCommits++
      for (const p of perHorizon) {
        const s = scripts.get(p.h)!
        s.all++
        if (p.gone) s.gone++
        if (p.reverted) s.reverted++
        if (p.source) s.source++
        if (p.source && p.gone) s.sourceGone++
      }
    }
    const seconds = (Date.now() - started) / 1000
    console.log(`\n## ${name}: ${picked.length} commits sampled of ${eligible.length} eligible, ${judgedCommits} with lines to judge (${seconds.toFixed(0)} s, ${(1000 * seconds / picked.length / HORIZONS.length).toFixed(0)} ms per commit and horizon)\n`)
    console.log("| horizon | files | fresh | moved | stale | gone | source files fresh | scripts not handed over | of those changing source | reverted |")
    console.log("|---|---|---|---|---|---|---|---|---|---|")
    for (const h of HORIZONS) {
      const these = rows.filter((r) => r.repo === name && r.horizon === h)
      const n = (k: string) => these.filter((r) => r.verdict.kind === k).length
      const source = these.filter((r) => fileKind(r.path) === "source")
      const s = scripts.get(h)!
      console.log(
        `| ${h} | ${these.length} | ${KINDS.map((k) => pct(n(k), these.length)).join(" | ")} | ` +
          `${pct(source.filter((r) => r.verdict.kind === "fresh").length, source.length)} of ${source.length} | ` +
          `${s.gone} of ${s.all} (${pct(s.gone, s.all)}) | ${s.sourceGone} of ${s.source} (${pct(s.sourceGone, s.source)}) | ${s.reverted} |`
      )
    }
  }

  // A sample to check by hand, weighted toward what isn't fresh: those are the verdicts that change a hand-over.
  const want: Record<string, number> = { stale: 14, moved: 8, gone: 6, fresh: 12 }
  const chosen = KINDS.flatMap((k) => sample(rows.filter((r) => r.verdict.kind === k), want[k], rnd))
  const survival = (v: Verdict) => ("survival" in v && v.survival !== undefined ? v.survival.toFixed(2) : "")
  const tsv = [
    ["repo", "commit", "title", "path", "horizon", "rev", "survival", "verdict", "moved_to", "later_commit"].join("\t"),
    ...sample(chosen, chosen.length, rnd).map((r) => [
      r.repo,
      r.commit.slice(0, 10),
      r.title.replace(/\t/g, " "),
      r.path,
      r.horizon,
      r.rev.slice(0, 10),
      survival(r.verdict),
      r.verdict.kind,
      r.verdict.kind === "moved" ? r.verdict.to : "",
      r.verdict.kind === "stale" && r.verdict.last !== null ? `${r.verdict.last.hash} ${r.verdict.last.title.replace(/\t/g, " ")}` : ""
    ].join("\t"))
  ].join("\n") + "\n"
  writeFileSync(out, tsv)
  console.log(`\n${chosen.length} verdicts to check by hand: ${out}`)
})

await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
