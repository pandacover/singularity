/**
 * How setup, status and learn look in a terminal: a little color where the
 * output is a terminal that wants it (not under NO_COLOR or TERM=dumb),
 * plain text everywhere else; a spinner while a model works.
 */
import { Console, Duration, Effect, Fiber } from "effect"
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
 * Run `effect` with a spinner and `label` on one line (a terminal only;
 * elsewhere the label is printed once), cleared when it ends.
 */
export const withSpinner = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>, interactive: boolean): Effect.Effect<A, E, R> => {
  if (!interactive) return Console.log(`      ${label}`).pipe(Effect.andThen(effect))
  let frame = 0
  const draw = Effect.sync(() => {
    process.stdout.write(`\r      ${FRAMES[frame++ % FRAMES.length]} ${label}`)
  })
  const clear = Effect.sync(() => {
    process.stdout.write(`\r${" ".repeat(label.length + 10)}\r`)
  })
  return Effect.gen(function*() {
    const spinner = yield* Effect.forkChild(Effect.forever(draw.pipe(Effect.andThen(Effect.sleep(Duration.millis(90))))))
    return yield* effect.pipe(Effect.ensuring(Fiber.interrupt(spinner).pipe(Effect.andThen(clear))))
  })
}

/** A yes/no question; the default when there is no terminal to ask in. */
export const confirm = (message: string, initial: boolean, interactive: boolean) =>
  interactive ? Prompt.run(Prompt.Confirm({ message, initial })) : Effect.succeed(initial)
