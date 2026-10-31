/**
 * The hand-over's decisions, as plain functions over what was read: the card
 * the first time a session acts in an app memory knows, a screen's notes the
 * first time it reads that screen with its stored fields on it, and the card
 * at a task's start when the prompt names a known app's address.
 *
 * Plain TypeScript with no Effect, so the hook (HookRun.ts) can use it on
 * every browser call: importing Effect alone takes about 0.4 s, four times a
 * call's budget. The Claude desktop proxy and the replay use it through
 * Handover.ts.
 */
import type { Observation } from "./Calls.ts"
import type { Address, AppIndex, Given } from "./Model.ts"
import { renderCard, renderNotes } from "./Render.ts"
import { parseSnapshot } from "./Snapshot.ts"
import { addressOf, promptWords } from "./Text.ts"
import { screenKey } from "./Trail.ts"

/** `SINGULARITY_HANDOVER=off`: capture only, nothing handed over (an eval's no-memory arm). */
export const handoverOff = () => process.env.SINGULARITY_HANDOVER === "off"

export const hostOf = (url: string): string | undefined => {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

export interface AfterCall {
  readonly given: Given
  /** The app the session is in now: the call's page's, or the last one it read. */
  readonly host: string | undefined
  /** That page's address as memory keeps it; undefined before memory has a salt. */
  readonly address: Address | undefined
  /** Whether the call acted or read a screen: the card waits for that. */
  readonly acted: boolean
}

/** The page a call leaves the session on, and whether it acted or read. */
export const afterCall = (given: Given, observations: ReadonlyArray<Observation>, yaml: string | undefined, salt: string | undefined): AfterCall => {
  const acted = observations.some((o) => o.act !== undefined || o.yaml !== undefined) || yaml !== undefined
  const url = [...observations].reverse().find((o) => o.url !== undefined)?.url
  if (url === undefined) return { given, host: given.host, address: given.address, acted }
  const host = hostOf(url)
  const address = host === undefined || salt === undefined ? undefined : addressOf(salt, url)?.address
  const { host: _host, address: _address, ...rest } = given
  return { given: { ...rest, ...(host === undefined ? {} : { host }), ...(address === undefined ? {} : { address }) }, host, address, acted }
}

/**
 * What to hand over after a call, with the app's index and the salt read:
 * the texts, and what the session has been given now.
 */
export const handOverWith = (call: AfterCall, index: AppIndex | undefined, salt: string | undefined, yaml: string | undefined): { readonly given: Given; readonly texts: ReadonlyArray<string> } => {
  let given = call.given
  const texts: Array<string> = []
  const host = call.host
  if (host === undefined || index === undefined || !call.acted || handoverOff()) return { given, texts }
  if (!given.cards.includes(host)) {
    given = { ...given, cards: [...given.cards, host] }
    const card = renderCard(index)
    if (card !== undefined) texts.push(card)
  }
  if (yaml !== undefined && salt !== undefined && call.address !== undefined) {
    const nodes = parseSnapshot(yaml)
    if (nodes.length > 0) {
      const key = screenKey(salt, call.address, nodes)
      const screen = index.screens[key]
      if (screen !== undefined && !given.screens.includes(key)) {
        const notes = renderNotes(index, screen, nodes, salt)
        // Notes not given (the screen changed) may be given at a later read of it.
        if (notes !== undefined) {
          given = { ...given, screens: [...given.screens, key] }
          texts.push(notes)
        }
      }
    }
  }
  return { given, texts }
}

/** The apps a prompt names by address. */
export const hostsIn = (prompt: string): Array<string> => {
  const hosts = new Set<string>()
  for (const m of prompt.matchAll(/\bhttps?:\/\/[^\s"'<>)\]]+/g)) {
    const h = hostOf(m[0])
    if (h !== undefined) hosts.add(h)
  }
  return [...hosts]
}

/**
 * The apps a prompt names: by address, or by a word memory has learned names
 * one app (`words`, from words.json), matched by fingerprint.
 */
export const appsNamedIn = (prompt: string, salt: string | undefined, words: Readonly<Record<string, string>>): Array<string> => {
  const apps = new Set(hostsIn(prompt))
  if (salt !== undefined) for (const w of promptWords(salt, prompt)) if (words[w] !== undefined) apps.add(words[w])
  return [...apps]
}

/** The cards due at a task's start, for the known apps its prompt names. */
export const cardsAtStart = (given: Given, indexes: ReadonlyArray<AppIndex>): { readonly given: Given; readonly texts: ReadonlyArray<string> } => {
  if (handoverOff()) return { given, texts: [] }
  const cards = [...given.cards]
  const texts: Array<string> = []
  for (const index of indexes) {
    if (cards.includes(index.app)) continue
    cards.push(index.app)
    const card = renderCard(index)
    if (card !== undefined) texts.push(card)
  }
  return { given: cards.length === given.cards.length ? given : { ...given, cards }, texts }
}
