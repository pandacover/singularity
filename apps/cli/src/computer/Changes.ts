/**
 * `singularity changes --app`: what computer-use memory stored, as `changes`
 * shows commits (computer-use-memory.md, "What memory keeps"). Without an
 * app, the apps it knows; with one, its sessions newest first (when, which
 * agent, the screens worked on, what was left out and why), then the card
 * an agent opening the app would read now.
 */
import { Console, Effect } from "effect"
import { makeStyle, plural } from "../setup/Ui.ts"
import type { AppIndex, Trail } from "./Model.ts"
import { renderCard, screenLabel } from "./Render.ts"
import { listApps, readIndex, readTrails } from "./Store.ts"

export interface AppSession {
  readonly session: string
  readonly agent: string
  readonly started_at: string
  /** The screens it worked on, named as the card names them; null for one whose words weren't seen twice yet. */
  readonly worked_on: ReadonlyArray<string | null>
  readonly routes: number
  readonly rules: number
  readonly left_out: Readonly<Record<string, number>>
}

const sessionOf = (index: AppIndex, t: Trail): AppSession => ({
  session: t.session,
  agent: t.agent,
  started_at: t.started_at,
  worked_on: t.screens.filter((s) => s.worked).map((s) => {
    const screen = index.screens[s.key]
    return screen === undefined ? null : screenLabel(index, screen) ?? null
  }),
  routes: t.routes.length,
  rules: t.rules.length,
  left_out: t.left_out
})

const day = (iso: string) => iso.slice(0, 10)

export const runAppChanges = Effect.fn("computer.runAppChanges")(function*(o: {
  readonly tenantDir: string
  readonly app: string | undefined
  readonly color: boolean
  readonly json: boolean
}) {
  const s = makeStyle(o.color)
  if (o.app === undefined || o.app === "") {
    const apps: Array<{ app: string; sessions: number }> = []
    for (const app of yield* listApps(o.tenantDir)) {
      const index = yield* readIndex(o.tenantDir, app)
      if (index !== undefined) apps.push({ app, sessions: index.sessions.length })
    }
    if (o.json) return yield* Console.log(JSON.stringify({ apps }, null, 2))
    const out = ["", `  ${s.magenta("◆")} ${s.bold("singularity")}  ${apps.length === 0 ? s.dim("no apps stored yet: memory starts with a browser session") : `${plural(apps.length, "app")} stored`}`]
    if (apps.length > 0) {
      out.push("")
      const width = Math.max(...apps.map((a) => a.app.length)) + 2
      for (const a of apps) out.push(`    ${a.app.padEnd(width)}${plural(a.sessions, "session")}`)
      out.push("", `  ${s.dim("one app, as an agent would read it:")} ${s.cyan("singularity changes --app <app>")}`)
    }
    return yield* Console.log([...out, ""].join("\n"))
  }
  const index = yield* readIndex(o.tenantDir, o.app)
  if (index === undefined) {
    if (o.json) return yield* Console.log(JSON.stringify({ app: o.app, sessions: [], card: null }, null, 2))
    return yield* Console.log(["", `  ${s.magenta("◆")} ${s.bold("singularity")}  ${s.dim(`nothing stored for ${o.app}`)}`, ""].join("\n"))
  }
  const sessions = (yield* readTrails(o.tenantDir, o.app)).map((t) => sessionOf(index, t)).sort((a, b) => b.started_at.localeCompare(a.started_at))
  const card = renderCard(index)
  if (o.json) return yield* Console.log(JSON.stringify({ app: o.app, sessions, retired: index.retired, card: card ?? null }, null, 2))
  const out = ["", `  ${s.magenta("◆")} ${s.bold("singularity")}  ${plural(sessions.length, "session")} stored for ${o.app}`, ""]
  for (const x of sessions) {
    const worked = x.worked_on.length === 0 ? "worked on no screen" : `worked on ${x.worked_on.map((w) => w ?? "a screen not seen twice yet").join(", ")}`
    const left = Object.entries(x.left_out).map(([why, n]) => `${n} ${why}`)
    out.push(`    ${day(x.started_at)}  ${x.agent.padEnd(15)}${worked}${left.length === 0 ? "" : s.dim(`  (left out: ${left.join("; ")})`)}`)
  }
  for (const r of index.retired) out.push(`    ${s.dim(`a route retired: ${r.why}`)}`)
  out.push("", `  ${s.dim("the card an agent opening it gets now:")}`, "")
  out.push(card ?? s.dim("  none yet: routes and names show once two sessions saw them"), "")
  return yield* Console.log(out.join("\n"))
})
