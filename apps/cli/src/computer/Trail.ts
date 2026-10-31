/**
 * A trail: what one session did in one app (computer-use-memory.md, "What
 * memory keeps"), read from its tool calls in order (Calls.ts):
 *
 * - the hops: each control that opened a screen, and the screen it opened;
 * - the screens worked on: a field changed there, or a write sent from it;
 * - the fields that start set on a screen a write was sent from, by state
 *   only, and whether the session changed them;
 * - the traps: messages a form or dialog showed;
 * - keys that did something on a screen (Enter submitted a form);
 * - where the session checked its result: the next screen it read after a
 *   write;
 * - the routes to the screens worked on, from the last screen reached by
 *   address or through content (a list row), never past a write;
 * - your rules, from the prompts, given to the app of the next action.
 *
 * Page text is kept as fingerprints (Text.ts). A string goes into the trail
 * in plain text only when another session saw it on the same screen
 * (`seenElsewhere`, from the app's index): then two sessions have. Never
 * kept: screenshots, typed text, what was chosen, query values, content. A
 * screen with a password field is left out entirely.
 */
import type { Observation } from "./Calls.ts"
import type { Address, ControlRef, FieldState, Trail, TrailField, TrailRoute, TrailScreen } from "./Model.ts"
import { addressKey, addressOf, fingerprint, pathKey, promptWords, rulesIn } from "./Text.ts"
import {
  ancestors,
  byRef,
  fieldState,
  formMessages,
  hasPassword,
  isContent,
  isControl,
  isField,
  isTextField,
  isToggle,
  parseSnapshot,
  screenRegion,
  showsStatus,
  type SnapNode
} from "./Snapshot.ts"

export type { ControlRef, Trail, TrailField, TrailRoute, TrailScreen }

/** A step of the session: a call's observation, with when it happened and its snapshot read. */
export interface Step {
  readonly obs: Observation
  readonly at: string
  /** The snapshot text (inline, or read from Playwright's file). */
  readonly yaml: string | undefined
}

export interface PromptAt {
  readonly text: string
  readonly at: string
  /** The step it came before. */
  readonly before: number
}

export interface TrailContext {
  readonly salt: string
  readonly session: string
  readonly agent: string
  /** Whether another session of this app saw this string on this screen (the app's index). */
  readonly seenElsewhere: (app: string, screen: string, fp: string) => boolean
}

/** Words that name a write: a backstop to the rule that a write is what a status line follows. */
export const WRITE_WORDS = /\b(submit|send|pay|confirm|save|place order|purchase|check ?out|publish|delete|remove|approve|issue|post|apply|sign|transfer|book|archive|reply|forward)\b/i

const MAX_CONTROLS = 300
const MAX_SEEN = 600

interface ScreenAcc {
  key: string
  address: Address
  region: ControlRef | null
  controls: Set<string>
  seen: Set<string>
  worked: boolean
  wrote: boolean
  /** Fields as first read, by `role:fp`. */
  first: Map<string, { role: string; fp: string; state: FieldState }>
  changed: Set<string>
  traps: Set<string>
  keys: Set<string>
  checked: Set<string>
  readOnce: boolean
}

interface AppAcc {
  app: string
  screens: Map<string, ScreenAcc>
  routes: Array<TrailRoute>
  rules: Array<{ text: string; at: string }>
  texts: Map<string, string>
  leftOut: Map<string, number>
  started: string
  ended: string
  desktopCalls: number
  menus: Array<Array<string>>
  /** The step of its first action: the prompts before it may name the app. */
  firstStep: number
  /** Moves between its screens, `from` and `to` keys joined by a tab. */
  next: Set<string>
}

interface Current {
  app: string
  url: string
  address: Address
  key: string
  nodes: ReadonlyArray<SnapNode>
  /** The screen has a password field: nothing of it is kept. */
  skip: boolean
}

const fieldId = (c: ControlRef) => `${c.role}:${c.fp}`

/** Roles whose names are choices among the app's data: a patient picked from a list. */
const CHOICES = new Set(["option", "menuitemradio", "treeitem", "gridcell"])

/** A screen's key: its address, and the named dialog or form that tells it from others there. Page text only by fingerprint. */
export const screenKey = (salt: string, address: Address, nodes: ReadonlyArray<SnapNode>): string => {
  const region = screenRegion(nodes)
  return `${addressKey(address)}${region === undefined ? "" : `|${region.role}:${fingerprint(salt, region.name)}`}`
}

/**
 * The trails of a session's steps, one per app. Prompts give the rules: each
 * goes to the app of the session's next action after it.
 */
export const buildTrails = (steps: ReadonlyArray<Step>, prompts: ReadonlyArray<PromptAt>, ctx: TrailContext): Array<Trail> => {
  const apps = new Map<string, AppAcc>()
  let stepIndex = 0
  const appOf = (app: string, at: string): AppAcc => {
    let a = apps.get(app)
    if (a === undefined) {
      a = { app, screens: new Map(), routes: [], rules: [], texts: new Map(), leftOut: new Map(), started: at, ended: at, desktopCalls: 0, menus: [], firstStep: stepIndex, next: new Set() }
      apps.set(app, a)
    }
    a.ended = at
    return a
  }
  const leave = (a: AppAcc, why: string) => a.leftOut.set(why, (a.leftOut.get(why) ?? 0) + 1)

  /**
   * A string's fingerprint on a screen; kept in plain text when another
   * session saw it there too, unless it is content (`plain` false): a list
   * row's or a choice's words are the app's data, never written down.
   */
  const fpOn = (a: AppAcc, screen: string, s: string, plain = true): string => {
    const fp = fingerprint(ctx.salt, s)
    if (plain && ctx.seenElsewhere(a.app, screen, fp)) a.texts.set(fp, s.replace(/\s+/g, " ").trim().slice(0, 120))
    return fp
  }

  /** Whether a control's name is the app's own words, not content: not a choice among data, not in a list row or table. */
  const ownWords = (nodes: ReadonlyArray<SnapNode>, n: SnapNode) => !CHOICES.has(n.role) && !isContent(nodes, n)

  let cur: Current | undefined
  // The route being walked: where it started, the screen it is on, and its hops since.
  let chain: { start: string; at: string; hops: Array<ControlRef & { from: string }> } | undefined
  // A write sent from a screen, waiting for the next screen read: where the session checked its result.
  let lastWrite: { app: string; screen: string; address: string } | undefined
  let pendingRules: Array<{ text: string; at: string }> = []
  let promptIndex = 0
  const sortedPrompts = [...prompts].sort((x, y) => x.before - y.before)

  const screenOf = (a: AppAcc, c: Current): ScreenAcc => {
    let s = a.screens.get(c.key)
    if (s === undefined) {
      const region = screenRegion(c.nodes)
      s = {
        key: c.key,
        address: c.address,
        region: region === undefined ? null : { role: region.role, fp: fpOn(a, c.key, region.name) },
        controls: new Set(),
        seen: new Set(),
        worked: false,
        wrote: false,
        first: new Map(),
        changed: new Set(),
        traps: new Set(),
        keys: new Set(),
        checked: new Set(),
        readOnce: false
      }
      a.screens.set(c.key, s)
    }
    return s
  }

  /** Read a screen: its controls, fields as first seen, and messages. */
  const read = (a: AppAcc, c: Current, s: ScreenAcc) => {
    for (const n of c.nodes) {
      if (!isControl(n.role) || n.name.trim() === "") continue
      const fp = fpOn(a, c.key, n.name, ownWords(c.nodes, n))
      if (s.controls.size < MAX_CONTROLS) s.controls.add(`${n.role}:${fp}`)
      if (s.seen.size < MAX_SEEN) s.seen.add(fp)
      if (!s.readOnce && isField(n.role) && !isTextField(n.role)) {
        const state = fieldState(c.nodes, n)
        if (state !== undefined) s.first.set(`${n.role}:${fp}`, { role: n.role, fp, state })
      }
    }
    for (const m of formMessages(c.nodes)) {
      const fp = fpOn(a, c.key, m)
      s.traps.add(fp)
      if (s.seen.size < MAX_SEEN) s.seen.add(fp)
    }
    if (s.region !== null && s.seen.size < MAX_SEEN) s.seen.add(s.region.fp)
    s.readOnce = true
  }

  const controlOf = (a: AppAcc, c: Current, node: SnapNode): ControlRef => ({ role: node.role, fp: fpOn(a, c.key, node.name, ownWords(c.nodes, node)) })

  const startRoute = (screen: string) => {
    chain = { start: screen, at: screen, hops: [] }
  }

  const markWorked = (a: AppAcc, s: ScreenAcc) => {
    if (s.worked) return
    s.worked = true
    // The route to it: the hops walked since the route's start, when they ended on this screen.
    if (chain !== undefined && chain.at === s.key && chain.hops.length > 0) a.routes.push({ to: s.key, start: chain.start, hops: [...chain.hops] })
  }

  steps.forEach((step, i) => {
    stepIndex = i
    while (promptIndex < sortedPrompts.length && sortedPrompts[promptIndex].before <= i) {
      const p = sortedPrompts[promptIndex++]
      for (const text of rulesIn(p.text)) pendingRules.push({ text, at: p.at })
    }
    const o = step.obs
    if (o.family === "app") {
      if (o.app === undefined) return
      const a = appOf(`app:${o.app.toLowerCase()}`, step.at)
      if (pendingRules.length > 0) a.rules.push(...pendingRules), (pendingRules = [])
      // A failed call's error is the tool's trap, kept on a screen of the tool's own.
      if (o.failed && o.error !== undefined) {
        const key = `tool:${o.tool}`
        let s = a.screens.get(key)
        if (s === undefined) {
          s = { key, address: { app: a.app, path: [], query: [] }, region: null, controls: new Set(), seen: new Set(), worked: false, wrote: false, first: new Map(), changed: new Set(), traps: new Set(), keys: new Set(), checked: new Set(), readOnce: true }
          a.screens.set(key, s)
        }
        const fp = fpOn(a, key, o.error.slice(0, 200))
        s.traps.add(fp)
        s.seen.add(fp)
      }
      return
    }
    if (o.family === "desktop") {
      if (o.app === undefined) return
      const a = appOf(`desktop:${o.app.toLowerCase()}`, step.at)
      a.desktopCalls++
      if (pendingRules.length > 0) a.rules.push(...pendingRules), (pendingRules = [])
      if (o.menu !== undefined && o.menu.length > 0) a.menus.push(o.menu.map((m) => fingerprint(ctx.salt, m)))
      return
    }

    const before = cur
    const beforeApp = before === undefined ? undefined : appOf(before.app, step.at)
    const beforeScreen = before === undefined || before.skip || beforeApp === undefined ? undefined : screenOf(beforeApp, before)

    // What the call did, on the screen read before it.
    let hop: { control: ControlRef; node: SnapNode; content: boolean } | undefined
    let pressed: string | undefined
    if (o.act !== undefined && !o.failed && before !== undefined && beforeApp !== undefined) {
      if (pendingRules.length > 0) beforeApp.rules.push(...pendingRules), (pendingRules = [])
      const act = o.act
      if (act.kind === "click" && act.atPoint === true) leave(beforeApp, "click at a point")
      const nodes = act.refs.map((r) => byRef(before.nodes, r)).filter((n): n is SnapNode => n !== undefined)
      if (beforeScreen !== undefined) {
        if (act.kind === "fill" || act.kind === "select") {
          for (const n of nodes) if (isField(n.role)) beforeScreen.changed.add(fieldId(controlOf(beforeApp, before, n)))
          markWorked(beforeApp, beforeScreen)
          if (act.key === "Enter") pressed = "Enter"
        } else if (act.kind === "click" && nodes.length === 1) {
          const n = nodes[0]
          if (isToggle(n.role) || n.role === "radio" || n.role === "menuitemradio") {
            beforeScreen.changed.add(fieldId(controlOf(beforeApp, before, n)))
            markWorked(beforeApp, beforeScreen)
          } else if (!isField(n.role)) {
            hop = { control: controlOf(beforeApp, before, n), node: n, content: isContent(before.nodes, n) }
          }
        } else if (act.kind === "key" && act.key !== undefined) {
          pressed = act.key
        }
      }
    }

    // What the call showed after.
    const url = o.url ?? before?.url
    const fresh = step.yaml !== undefined
    if (url === undefined) return
    const parsed = addressOf(ctx.salt, url)
    if (parsed === undefined) return
    const nodes = fresh ? parseSnapshot(step.yaml!) : before !== undefined && before.url === url ? before.nodes : []
    const a = appOf(parsed.address.app, step.at)
    if (pendingRules.length > 0 && o.act !== undefined) a.rules.push(...pendingRules), (pendingRules = [])
    const key = screenKey(ctx.salt, parsed.address, nodes)
    const now: Current = { app: a.app, url, address: parsed.address, key, nodes, skip: hasPassword(nodes) }
    // Address segments are page text: kept in plain text once another session had them.
    for (const [fp, s] of parsed.texts) if (ctx.seenElsewhere(a.app, "", fp)) a.texts.set(fp, s)

    const moved = before === undefined || before.key !== key || before.app !== a.app
    if (o.act?.kind === "navigate" || o.act?.kind === "back" || before === undefined || before.app !== a.app) {
      startRoute(key)
    } else if (hop !== undefined && beforeScreen !== undefined && beforeApp !== undefined) {
      const write = WRITE_WORDS.test(hop.node.name) ||
        (hop.node.role === "button" && fresh && showsStatus(nodes) && !showsStatus(before!.nodes)) ||
        (hop.node.role === "button" && beforeScreen.changed.size > 0 && ancestors(before!.nodes, hop.node).some((x) => x.role === "form" || x.role === "dialog"))
      if (write) {
        beforeScreen.wrote = true
        markWorked(beforeApp, beforeScreen)
        lastWrite = { app: beforeApp.app, screen: beforeScreen.key, address: pathKey(beforeScreen.address) }
        chain = undefined
      } else if (moved) {
        if (hop.content) startRoute(key)
        else {
          // A chain that lost its way (the screen changed without a read) starts again where this hop did.
          if (chain === undefined || chain.at !== before!.key) startRoute(before!.key)
          chain!.hops.push({ ...hop.control, from: before!.key })
          chain!.at = key
        }
      }
    }
    if (pressed !== undefined && beforeScreen !== undefined && beforeApp !== undefined && (moved || (fresh && showsStatus(nodes) && !showsStatus(before!.nodes)))) {
      beforeScreen.keys.add(pressed)
      beforeScreen.wrote = true
      markWorked(beforeApp, beforeScreen)
      lastWrite = { app: beforeApp.app, screen: beforeScreen.key, address: pathKey(beforeScreen.address) }
    }

    if (moved && before !== undefined && before.app === a.app && !before.skip && !now.skip) a.next.add(`${before.key}\t${key}`)
    if (now.skip) {
      if (moved || fresh) leave(a, "password field")
    } else {
      const s = screenOf(a, now)
      if (fresh) read(a, now, s)
      if (lastWrite !== undefined && lastWrite.app === a.app && moved && pathKey(parsed.address) !== lastWrite.address && fresh) {
        a.screens.get(lastWrite.screen)?.checked.add(pathKey(parsed.address))
        lastWrite = undefined
      }
    }
    cur = now
  })

  const out: Array<Trail> = []
  for (const a of apps.values()) {
    const screens: Array<TrailScreen> = [...a.screens.values()].map((s) => ({
      key: s.key,
      address: s.address,
      region: s.region,
      controls: [...s.controls],
      seen: [...s.seen],
      worked: s.worked,
      wrote: s.wrote,
      fields: s.wrote ? [...s.first.entries()].map(([id, f]) => ({ ...f, changed: s.changed.has(id) })) : [],
      traps: [...s.traps],
      keys: [...s.keys],
      checked_at: [...s.checked]
    }))
    out.push({
      version: 1,
      app: a.app,
      session: ctx.session,
      agent: ctx.agent,
      started_at: a.started,
      ended_at: a.ended,
      screens,
      routes: a.routes,
      rules: a.rules,
      texts: Object.fromEntries(a.texts),
      left_out: Object.fromEntries(a.leftOut),
      ...(a.app.startsWith("desktop:") ? { desktop: { calls: a.desktopCalls, menus: a.menus } } : {}),
      words: [...new Set(prompts.filter((p) => p.before <= a.firstStep).flatMap((p) => promptWords(ctx.salt, p.text)))],
      next: [...a.next].map((x) => ({ from: x.split("\t")[0], to: x.split("\t")[1] }))
    })
  }
  return out
}
