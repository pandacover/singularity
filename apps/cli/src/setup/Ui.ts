/**
 * How setup, update, status and learn look in a terminal: a little color
 * where the output is a terminal that wants it (not under NO_COLOR or
 * TERM=dumb), plain text everywhere else; a spinner while something works.
 *
 * One layout for all of them, the installers' too: the title, then
 * sections, each a tree of items (a mark, then the text) with notes under
 * them, and the end, a section of its own.
 *
 *       singularity  installing
 *
 *       Your agents
 *       ├─ ✓ Claude Code  memory at task start, learns from its sessions
 *       ├─ ✓ Codex        memory at task start, learns from its sessions
 *       │  └─ ! a note under it
 *       └─ ✓ Cursor       memory when you ask for it
 *
 *       ✓ Ready  agents running now get memory from their next start
 *       └─ open a new terminal for the singularity command
 *
 * Ctrl+C quits at any point: in a question as anywhere else (Effect's prompts
 * read it as a key and fail; that becomes an interruption, exit code 130).
 */
import { Console, Duration, Effect, Fiber, Terminal } from "effect"
import { Prompt } from "effect/cli"

export interface Style {
  readonly bold: (s: string) => string
  readonly dim: (s: string) => string
  readonly green: (s: string) => string
  readonly yellow: (s: string) => string
  readonly red: (s: string) => string
  readonly cyan: (s: string) => string
  readonly magenta: (s: string) => string
}

const wrap = (on: boolean, open: number, close: number) => (s: string) => (on ? `\u001b[${open}m${s}\u001b[${close}m` : s)

export const makeStyle = (color: boolean): Style => ({
  bold: wrap(color, 1, 22),
  dim: wrap(color, 2, 22),
  green: wrap(color, 32, 39),
  yellow: wrap(color, 33, 39),
  red: wrap(color, 31, 39),
  cyan: wrap(color, 36, 39),
  magenta: wrap(color, 35, 39)
})

/** Whether stdout is a terminal that takes colors. */
export const wantsColor = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  process.stdout.isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb"

/** The title: the name, and what is happening ("installing", "setup", "updating"). */
export const title = (s: Style, what: string): string => `\n  ${s.bold("singularity")}  ${s.dim(what)}`

/** Lines that go in a tree, as an item's or a note's text. */
export const marks = (s: Style) => ({
  ok: (text: string, detail = "") => `${s.green("✓")} ${text}${detail === "" ? "" : `  ${s.dim(detail)}`}`,
  /** Something left out on purpose. */
  skip: (text: string) => s.dim(`· ${text}`),
  /** Something the user should do or know. */
  warn: (text: string) => `${s.yellow("!")} ${text}`,
  fail: (text: string) => `${s.red("✗")} ${text}`
})

/**
 * Sections printed as trees. An item is held until the next one, or the end
 * of its section, says whether it is the last of its siblings; notes go
 * under it. `pause` lets the held item out before a question or a spinner,
 * which take the next branch.
 */
export interface Tree {
  readonly section: (name: string) => Effect.Effect<void>
  /** A section's own line, with a mark: the end, say. Items after it are its children. */
  readonly head: (line: string) => Effect.Effect<void>
  readonly item: (line: string) => Effect.Effect<void>
  readonly note: (line: string) => Effect.Effect<void>
  /** A description at the top of a section, before its items. */
  readonly text: (line: string) => Effect.Effect<void>
  readonly pause: Effect.Effect<void>
  /** The end of the last section: its last item goes out as the last. */
  readonly close: Effect.Effect<void>
}

export const makeTree = (s: Style): Tree => {
  let held: { readonly line: string; readonly notes: Array<string> } | undefined
  const say = (line: string) => Console.log(line)
  const flush = (last: boolean) =>
    Effect.suspend(() => {
      const item = held
      held = undefined
      if (item === undefined) return Effect.void
      const under = last ? "   " : `${s.dim("│")}  `
      return Effect.forEach([
        `  ${s.dim(last ? "└─" : "├─")} ${item.line}`,
        ...item.notes.map((n, i) => `  ${under}${s.dim(i === item.notes.length - 1 ? "└─" : "├─")} ${n}`)
      ], say, { discard: true })
    })
  return {
    section: (name) => flush(true).pipe(Effect.andThen(say(`\n  ${s.bold(name)}`))),
    head: (line) => flush(true).pipe(Effect.andThen(say(`\n  ${line}`))),
    item: (line) => flush(false).pipe(Effect.andThen(Effect.sync(() => (held = { line, notes: [] })))),
    note: (line) => Effect.suspend(() => (held === undefined ? say(`  ${s.dim("│")}  ${line}`) : Effect.sync(() => held?.notes.push(line)))),
    text: (line) => flush(false).pipe(Effect.andThen(say(`  ${s.dim("│")}  ${s.dim(line)}`))),
    pause: flush(false),
    close: flush(true)
  }
}

/**
 * Set where the title is on screen already, by the installer or by the
 * `update` that started this one, so the output goes on below it.
 */
export const TITLED_ENV = "SINGULARITY_TITLED"

/** A path for people: the home directory as `~`, forward slashes. */
export const tilde = (p: string, home: string): string => {
  const s = p.replace(/\\/g, "/")
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "")
  return s.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${s.slice(h.length)}` : s
}

/** `$0.31` */
export const usd = (x: number): string => `$${x.toFixed(2)}`

/** "1 session", "3 sessions" */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A list in words: "a", "a and b", "a, b and c". */
export const listWords = (xs: ReadonlyArray<string>): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * Run `effect` with a spinner and `label` on a tree's next branch (a terminal
 * only; elsewhere the label is printed once), cleared when it ends.
 */
export const withSpinner = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>, interactive: boolean): Effect.Effect<A, E, R> => {
  const s = makeStyle(interactive && wantsColor())
  if (!interactive) return Console.log(`  ├─ ${label}`).pipe(Effect.andThen(effect))
  let frame = 0
  const draw = Effect.sync(() => {
    process.stdout.write(`\r  ${s.dim("├─")} ${s.magenta(FRAMES[frame++ % FRAMES.length])} ${label}`)
  })
  const clear = Effect.sync(() => {
    process.stdout.write(`\r${" ".repeat(label.length + 8)}\r`)
  })
  return Effect.gen(function*() {
    const spinner = yield* Effect.forkChild(Effect.forever(draw.pipe(Effect.andThen(Effect.sleep(Duration.millis(90))))))
    return yield* effect.pipe(Effect.ensuring(Fiber.interrupt(spinner).pipe(Effect.andThen(clear))))
  })
}

/** Questions on a tree's next branch; an answered one is marked like an item. */
// Choices sit under the question's text: their indent is the width of the paging arrows.
const theme = () => {
  const branch = makeStyle(wantsColor()).dim("├─")
  return {
    prefix: `  ${branch} ?`,
    tick: `  ${branch} ✓`,
    pointerSmall: "›",
    ellipsis: "·",
    arrowUp: "     ↑",
    arrowDown: "     ↓",
    checkboxOn: "[x]",
    checkboxOff: "[ ]"
  }
}

/** Ctrl+C in a question quits, as it does anywhere else: an interruption, not the question's default. */
const quitting = <A, R>(prompt: Effect.Effect<A, Terminal.QuitError, R>): Effect.Effect<A, never, R> =>
  prompt.pipe(Effect.catchIf(Terminal.isQuitError, () => Console.log("").pipe(Effect.andThen(Effect.interrupt))))

/** A yes/no question; the default when there is no terminal to ask in. */
export const confirm = (message: string, initial: boolean, interactive: boolean) =>
  interactive ? quitting(Prompt.run(Prompt.Confirm({ message, initial, theme: theme() }))) : Effect.succeed(initial)

/** One of a few choices, `initial` picked to begin with; `initial` when there is no terminal to ask in. */
export const askChoice = <const A>(
  message: string,
  choices: ReadonlyArray<{ readonly title: string; readonly description?: string; readonly value: A }>,
  initial: A,
  interactive: boolean
) =>
  interactive
    ? quitting(Prompt.run(Prompt.Select({ message, choices: choices.map((c) => ({ ...c, selected: c.value === initial })), theme: theme() })))
    : Effect.succeed(initial)

/** A line of text, trimmed; the default when there is no terminal to ask in. */
export const askText = (message: string, initial: string, interactive: boolean) =>
  interactive
    ? quitting(Prompt.run(Prompt.String({ message, default: initial, theme: theme() }))).pipe(Effect.map((s) => s.trim()))
    : Effect.succeed(initial)

/** An amount of dollars, none below zero; the default when there is no terminal to ask in. */
export const askDollars = (message: string, initial: number, interactive: boolean) =>
  interactive
    ? quitting(Prompt.run(Prompt.Number({ message, default: initial, min: 0, precision: 2, incrementBy: 0.5, decrementBy: 0.5, theme: theme() })))
    : Effect.succeed(initial)

/**
 * Several of a few choices at once, ticked or not to begin with (space ticks,
 * enter goes on); those ticked to begin with when there is no terminal to ask in.
 */
export const askMany = <const A>(
  message: string,
  choices: ReadonlyArray<{ readonly title: string; readonly description?: string; readonly value: A; readonly selected: boolean }>,
  interactive: boolean
) =>
  interactive
    ? quitting(Prompt.run(Prompt.MultiSelect({ message, choices, selectAll: "all", selectNone: "none", inverseSelection: "invert", maxPerPage: 12, theme: theme() })))
    : Effect.succeed(choices.filter((c) => c.selected).map((c) => c.value))
