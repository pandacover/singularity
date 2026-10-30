/**
 * The two hand-overs (computer-use-memory.md, "The design"), written as
 * statements of fact, as the hooks reference asks of hook text:
 *
 * - **The app card,** once a session, at most 700 characters: your rules for
 *   the app, in your words with their dates, and the routes to the screens
 *   past sessions worked on, the most worked on first. A route shows only
 *   when every string in it was seen in two sessions.
 * - **Screen notes,** once a session per screen, at most about 400
 *   characters, only when the screen's stored fields are on the live screen:
 *   fields that start set, by state only, ending "Decide from the task";
 *   traps; keys that did something there; where past sessions checked their
 *   result; on a hub, the screens past sessions went on to. Names come
 *   from the live screen, so a field one past session saw is named the
 *   second time it is seen.
 *
 * Every page string is quoted, cut to 40 characters, and dropped when it
 * reads as an instruction (Text.ts `showable`).
 */
import type { AppIndex, IndexScreen } from "./Model.ts"
import type { SnapNode } from "./Snapshot.ts"
import { blankNumbers, fingerprint, showable, showAddress } from "./Text.ts"

export const MAX_CARD = 700
export const MAX_NOTES = 400

const quote = (s: string) => `"${s}"`

const known = (index: AppIndex) => (fp: string): string | undefined => index.texts[fp]

const shown = (index: AppIndex, fp: string): string | undefined => {
  const t = known(index)(fp)
  return t === undefined ? undefined : showable(blankNumbers(t))
}

const regionWord = (role: string) => (role === "form" ? "form" : "dialog")

/** A screen as the card names it: its dialog or form, else its address. */
export const screenLabel = (index: AppIndex, s: IndexScreen): string | undefined => {
  if (s.region !== null) {
    const name = shown(index, s.region.fp)
    if (name !== undefined) return `${quote(name)} ${regionWord(s.region.role)}`
  }
  return showAddress(s.address, known(index))
}

const day = (iso: string) => iso.slice(0, 10)

/** Lines that fit a budget, in order; `keep` lines always go in. */
const fit = (head: ReadonlyArray<string>, body: ReadonlyArray<string>, tail: ReadonlyArray<string>, max: number): string | undefined => {
  const out = [...head]
  const size = (lines: ReadonlyArray<string>) => lines.join("\n").length
  for (const line of body) if (size([...out, line, ...tail]) <= max) out.push(line)
  const text = [...out, ...tail].join("\n")
  return text.length <= max ? text : undefined
}

/** The routes the card can show, each with its line: every word in it shown. */
export const shownRoutes = (index: AppIndex) => {
  const out: Array<{ readonly route: AppIndex["routes"][number]; readonly line: string }> = []
  for (const r of index.routes) {
    const screen = index.screens[r.to]
    if (screen === undefined) continue
    const label = screenLabel(index, screen)
    const start = showAddress(r.start_address, known(index))
    const hops = r.hops.map((h) => shown(index, h.fp))
    if (label === undefined || start === undefined || hops.some((h) => h === undefined)) continue
    out.push({ route: r, line: `- ${label} (${screen.worked_in} session${screen.worked_in === 1 ? "" : "s"}): ${[start, ...hops.map((h) => quote(h!))].join(" › ")}` })
  }
  return out
}

/** The app card, or undefined when memory has nothing to say about the app. */
export const renderCard = (index: AppIndex): string | undefined => {
  const rules = index.rules.map((r) => `${quote(r.text)} (${day(r.at)})`)
  const routes = shownRoutes(index).map((r) => r.line)
  // App tools' traps: the errors their calls answered with, by tool.
  const toolTraps = Object.values(index.screens)
    .filter((s) => s.key.startsWith("tool:"))
    .flatMap((s) => s.traps.map((t) => shown(index, t.fp)).filter((t): t is string => t !== undefined).map((t) => `${quote(t)} from ${s.key.slice(5)}`))
  if (rules.length === 0 && routes.length === 0 && toolTraps.length === 0) return undefined
  const n = index.sessions.length
  const head = [`singularity: ${index.app}, from ${n} past session${n === 1 ? "" : "s"}.`]
  const body: Array<string> = []
  if (rules.length > 0) body.push(`Your rules here: ${rules.join("; ")}.`)
  if (routes.length > 0) body.push("Screens past sessions worked on, and how they got there:", ...routes)
  if (toolTraps.length > 0) body.push(`Past sessions got ${toolTraps.join("; ")}.`)
  return fit(head, body, ["Read each screen as you go: the app may have changed since."], MAX_CARD)
}

const STATE_WORDS: Readonly<Record<string, string>> = { "ticked": "start ticked", "partly ticked": "start partly ticked", "selected": "start selected", "set": "start set" }

/**
 * The notes for a screen read now, or undefined: when the screen's stored
 * fields aren't all on it (the app changed: memory says nothing), or when
 * there is nothing to say.
 */
export const renderNotes = (index: AppIndex, screen: IndexScreen, live: ReadonlyArray<SnapNode>, salt: string): string | undefined => {
  const liveNames = new Map<string, string>()
  for (const n of live) if (n.name.trim() !== "") liveNames.set(`${n.role}:${fingerprint(salt, n.name)}`, n.name)
  const present = screen.fields.map((f) => ({ f, name: liveNames.get(`${f.role}:${f.fp}`) }))
  if (present.some((p) => p.name === undefined)) return undefined

  const label = screen.region === null ? undefined : (() => {
    const name = [...live].reverse().find((n) => n.role === screen.region!.role && fingerprint(salt, n.name) === screen.region!.fp)?.name
    const s = name === undefined ? undefined : showable(blankNumbers(name))
    return s === undefined ? undefined : `${quote(s)} ${regionWord(screen.region.role)}`
  })()
  const where = label === undefined ? "on this screen" : `on this screen (${label})`

  const lines: Array<string> = []
  // Fields some past session changed first, without saying so.
  const fields = present
    .map((p) => ({ ...p, s: showable(blankNumbers(p.name!)) }))
    .filter((p) => p.s !== undefined)
    .sort((a, b) => Number(b.f.changed_in > 0) - Number(a.f.changed_in > 0))
  if (fields.length > 0) {
    const byState = new Map<string, Array<string>>()
    for (const p of fields) byState.set(p.f.state, [...(byState.get(p.f.state) ?? []), quote(p.s!)])
    const said = [...byState].map(([state, names]) => `${names.join(", ")} ${STATE_WORDS[state] ?? "start set"}`).join("; ")
    lines.push(`singularity: ${where}, past sessions saw ${said}.`, "Decide from the task.")
  }
  const traps = screen.traps.map((t) => shown(index, t.fp)).filter((t): t is string => t !== undefined)
  if (traps.length > 0) lines.push(`${lines.length === 0 ? `singularity: ${where}, past` : "Past"} sessions saw ${traps.map(quote).join(", ")} here.`)
  const keys = screen.keys.filter((k) => k.sessions >= 2 && k.key === "Enter")
  if (keys.length > 0) lines.push(`${lines.length === 0 ? `singularity: ${where}, ` : ""}Enter in a field sent this form in ${keys[0].sessions} past sessions.`)
  const checks = screen.checked_at.map((c) => showAddress(c.address, known(index))).filter((c): c is string => c !== undefined)
  if (checks.length > 0) lines.push(`${lines.length === 0 ? `singularity: ${where}, a` : "A"}fter a change here, past sessions checked ${checks.slice(0, 2).join(" or ")}.`)
  // A hub: sessions went on from here to different screens. The ones two sessions went to, the most first.
  const row = Object.entries(index.next?.[screen.key] ?? {}).filter(([to]) => to !== screen.key)
  if (row.length >= 2) {
    const went = row
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([to, n]) => {
        const s = index.screens[to]
        const l = s === undefined ? undefined : screenLabel(index, s)
        return l === undefined ? undefined : `${l} (${n})`
      })
      .filter((x): x is string => x !== undefined)
      .slice(0, 3)
    if (went.length > 0) lines.push(`${lines.length === 0 ? `singularity: ${where}, p` : "P"}ast sessions went on to ${went.join(", ")}.`)
  }
  if (lines.length === 0) return undefined
  return fit([], lines, [], MAX_NOTES) ?? lines.slice(0, 2).join("\n").slice(0, MAX_NOTES)
}
