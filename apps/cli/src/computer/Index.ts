/**
 * An app's index, built again from all its trails whenever one is stored:
 * what the card and the notes are written from, and what capture asks to
 * tell whether a string was seen in another session (Trail.ts).
 *
 * Routes, when the app changes (computer-use-memory.md, "Routes"):
 *
 * - the newest route to a screen wins over older ones;
 * - it retires when its controls were missing in the last two sessions that
 *   reached the screen a hop starts from;
 * - or when the app's last two sessions that worked on its screen got there
 *   another way;
 * - or when the app's last three sessions never reached its first screen.
 *   A monthly task's route survives between uses while its first screen is
 *   still in use.
 */
import type { AppIndex, IndexRoute, IndexScreen, Trail, TrailRoute } from "./Model.ts"
import { pathKey } from "./Text.ts"

const RETIRE_MISSING = 2
const RETIRE_OTHER_WAY = 2
const RETIRE_UNREACHED = 3

const hopsKey = (r: TrailRoute) => JSON.stringify([r.start, r.hops.map((h) => [h.from, h.role, h.fp])])

export const emptyIndex = (app: string): AppIndex => ({
  version: 1,
  app,
  sessions: [],
  texts: {},
  seen: {},
  screens: {},
  routes: [],
  retired: [],
  rules: [],
  left_out: {}
})

export const buildIndex = (app: string, all: ReadonlyArray<Trail>): AppIndex => {
  const trails = [...all].filter((t) => t.app === app).sort((a, b) => a.started_at.localeCompare(b.started_at) || a.session.localeCompare(b.session))
  if (trails.length === 0) return emptyIndex(app)

  // Seen-twice: per screen, the sessions that saw each string.
  const seen: Record<string, Record<string, number>> = {}
  const count = (screen: string, fp: string) => {
    const m = (seen[screen] ??= {})
    m[fp] = (m[fp] ?? 0) + 1
  }
  for (const t of trails) {
    const addressTexts = new Set<string>()
    for (const s of t.screens) {
      for (const fp of new Set(s.seen)) count(s.key, fp)
      for (const x of [...s.address.path, ...(s.address.hash ?? [])]) if ("fp" in x) addressTexts.add(x.fp)
    }
    for (const fp of addressTexts) count("", fp)
  }
  const texts: Record<string, string> = {}
  for (const t of trails) Object.assign(texts, t.texts)

  // Screens.
  const screens: Record<string, IndexScreen> = {}
  for (const t of trails) {
    for (const s of t.screens) {
      const prev = screens[s.key]
      const fields = new Map((prev?.fields ?? []).map((f) => [`${f.role}:${f.fp}`, { ...f }]))
      for (const f of s.fields) {
        const id = `${f.role}:${f.fp}`
        const was = fields.get(id)
        fields.set(id, { role: f.role, fp: f.fp, state: f.state, seen_in: (was?.seen_in ?? 0) + 1, changed_in: (was?.changed_in ?? 0) + (f.changed ? 1 : 0), last: t.started_at })
      }
      const tally = (list: ReadonlyArray<readonly [string, number]>, add: ReadonlyArray<string>) => {
        const m = new Map(list)
        for (const v of new Set(add)) m.set(v, (m.get(v) ?? 0) + 1)
        return [...m]
      }
      const checked = new Map((prev?.checked_at ?? []).map((c) => [c.key, { ...c }]))
      for (const key of new Set(s.checked_at)) {
        const target = t.screens.find((x) => pathKey(x.address) === key)
        const c = checked.get(key)
        if (target !== undefined) checked.set(key, { key, address: { ...target.address, query: [] }, sessions: (c?.sessions ?? 0) + 1 })
      }
      screens[s.key] = {
        key: s.key,
        address: s.address,
        region: s.region,
        worked_in: (prev?.worked_in ?? 0) + (s.worked ? 1 : 0),
        fields: [...fields.values()],
        traps: tally((prev?.traps ?? []).map((x) => [x.fp, x.sessions] as const), s.traps).map(([fp, sessions]) => ({ fp, sessions })),
        keys: tally((prev?.keys ?? []).map((x) => [x.key, x.sessions] as const), s.keys).map(([key, sessions]) => ({ key, sessions })),
        checked_at: [...checked.values()]
      }
    }
  }

  // Routes: the newest to each screen, unless retired.
  const routes: Array<IndexRoute> = []
  const retired: Array<{ to: string; why: string }> = []
  const targets = new Set(trails.flatMap((t) => t.routes.map((r) => r.to)))
  for (const to of targets) {
    const taken = trails.flatMap((t, i) => t.routes.filter((r) => r.to === to).map((r) => ({ r, i, t })))
    const newest = taken[taken.length - 1]
    const later = trails.slice(newest.i + 1)
    const why = retirement(newest.r, later)
    if (why !== undefined) {
      retired.push({ to, why })
      continue
    }
    const start = trails[newest.i].screens.find((s) => s.key === newest.r.start)
    if (start === undefined) continue
    routes.push({
      to,
      start: newest.r.start,
      start_address: start.address,
      hops: newest.r.hops,
      at: newest.t.started_at,
      used_in: new Set(taken.filter((x) => hopsKey(x.r) === hopsKey(newest.r)).map((x) => x.t.session)).size
    })
  }

  const rules = new Map<string, string>()
  for (const t of trails) for (const r of t.rules) rules.set(r.text, r.at)
  const leftOut: Record<string, number> = {}
  for (const t of trails) for (const [k, v] of Object.entries(t.left_out)) leftOut[k] = (leftOut[k] ?? 0) + v
  // Prompt words, and the screens sessions went to next: by session, each counted once per session.
  const words: Record<string, number> = {}
  for (const t of trails) for (const w of new Set(t.words ?? [])) words[w] = (words[w] ?? 0) + 1
  const next: Record<string, Record<string, number>> = {}
  for (const t of trails) {
    for (const m of new Set((t.next ?? []).map((x) => JSON.stringify([x.from, x.to])))) {
      const [from, to] = JSON.parse(m) as [string, string]
      const row = (next[from] ??= {})
      row[to] = (row[to] ?? 0) + 1
    }
  }

  return {
    version: 1,
    app,
    sessions: trails.map((t) => ({ session: t.session, agent: t.agent, started_at: t.started_at, ended_at: t.ended_at })),
    texts,
    seen,
    screens,
    routes: routes.sort((a, b) => (screens[b.to]?.worked_in ?? 0) - (screens[a.to]?.worked_in ?? 0) || b.at.localeCompare(a.at)),
    retired,
    rules: [...rules].map(([text, at]) => ({ text, at })).sort((a, b) => b.at.localeCompare(a.at)),
    left_out: leftOut,
    words,
    next
  }
}

/**
 * Prompt words that name one app: before two or more sessions in it, and
 * before none in any other app (computer-use-memory.md, "The app card").
 */
export const appWords = (indexes: ReadonlyArray<AppIndex>): Record<string, string> => {
  const apps = new Map<string, Array<{ app: string; sessions: number }>>()
  for (const index of indexes) for (const [w, n] of Object.entries(index.words ?? {})) apps.set(w, [...(apps.get(w) ?? []), { app: index.app, sessions: n }])
  const out: Record<string, string> = {}
  for (const [w, list] of apps) if (list.length === 1 && list[0].sessions >= 2) out[w] = list[0].app
  return out
}

/** Why a route no longer holds, judged by the sessions after the one that took it; undefined while it holds. */
export const retirement = (r: TrailRoute, later: ReadonlyArray<Trail>): string | undefined => {
  for (const h of r.hops) {
    const reached = later.filter((t) => t.screens.some((s) => s.key === h.from && s.controls.length > 0))
    const last = reached.slice(-RETIRE_MISSING)
    if (last.length === RETIRE_MISSING && last.every((t) => !t.screens.find((s) => s.key === h.from)!.controls.includes(`${h.role}:${h.fp}`))) {
      return "its controls were missing in the last two sessions"
    }
  }
  const worked = later.filter((t) => t.screens.some((s) => s.key === r.to && s.worked)).slice(-RETIRE_OTHER_WAY)
  if (worked.length === RETIRE_OTHER_WAY && worked.every((t) => !t.routes.some((x) => x.to === r.to && hopsKey(x) === hopsKey(r)))) {
    return "the last two sessions got there another way"
  }
  const recent = later.slice(-RETIRE_UNREACHED)
  if (recent.length === RETIRE_UNREACHED && recent.every((t) => !t.screens.some((s) => s.key === r.start))) {
    return "the last sessions never reached its first screen"
  }
  return undefined
}
