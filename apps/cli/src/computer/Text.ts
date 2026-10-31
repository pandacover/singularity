/**
 * Page text, as memory may keep and show it (computer-use-memory.md, "Seen
 * twice before written down" and "Prompt injection").
 *
 * - **Fingerprints.** Memory writes a string down only once two sessions saw
 *   it on the same screen. Until then it keeps a salted fingerprint, taken
 *   after numbers are blanked to `{n}`, so "Orders (3)" and "Orders (5)" are
 *   one label. The salt is a file in the memory home (Store.ts).
 * - **What may be shown.** A string is cut to 40 characters and shown in
 *   quotes. One that reads as an instruction is dropped: it addresses the
 *   assistant or the user, holds an email address or a link, or opens with
 *   an order to the reader.
 * - **Screen addresses.** The path with ids as `{n}`, a hash route's path, and
 *   the query's keys without their values. A path segment that isn't a
 *   number is page text, so it is a fingerprint until seen twice.
 */
import { createHash } from "node:crypto"
import type { Address, Segment } from "./Model.ts"

export type { Address, Segment }

/** Numbers, amounts and dates as `{n}`; spaces collapsed. */
export const blankNumbers = (s: string): string =>
  s.replace(/\s+/g, " ").trim().replace(/[$€£¥]?\d[\d,.:/-]*%?/g, "{n}").replace(/(\{n\}\s*){2,}/g, "{n} ").trim()

/** A string's fingerprint under a salt: the same for the same words, whatever their numbers or case. */
export const fingerprint = (salt: string, s: string): string =>
  createHash("sha256").update(`${salt}\u0000${blankNumbers(s).toLowerCase()}`).digest("hex").slice(0, 16)

/** Words too common to name an app. */
const COMMON = new Set(
  ("the and for with this that from into onto your you our their them they there then than what when where which who whom whose why how " +
    "can could would should will shall may might must have has had are was were been being not but all any each every some its it's " +
    "please thanks thank just also only very more most less same other another new old get got make made let need needs want wants " +
    "use using open opens go goes see look find show tell give take put set check done do does did one two three first last next")
    .split(" ")
)

/**
 * The words of a prompt that may name an app, as fingerprints, never in
 * plain text: a word that came before two sessions in one app and in no
 * other's brings that app's card at a task's start (computer-use-memory.md).
 * Addresses are left out: the hand-over reads them itself.
 */
export const promptWords = (salt: string, text: string): Array<string> => {
  const words = new Set<string>()
  for (const m of text.replace(/\bhttps?:\/\/\S+/g, " ").toLowerCase().matchAll(/[a-z][a-z0-9'-]{2,}/g)) {
    if (!COMMON.has(m[0])) words.add(fingerprint(salt, `word:${m[0]}`))
  }
  return [...words]
}

export const MAX_SHOWN = 40

/** Words that open an order to the reader, whatever follows. */
const ORDERS = /^(please|ignore|disregard|forget|always|never|you must|you should|make sure|remember|note:|important:|attention|system|assistant|claude|ai\b)/i
/**
 * Verbs that open an order when a sentence follows them. A control's label is
 * a verb too ("Edit address", "Open order"), so these count only from four
 * words on, or with a sentence's punctuation.
 */
const VERBS = /^(do|don't|dont|click|press|type|enter|send|go to|open|call|run|execute|reply|respond|tell|copy|delete|transfer|pay|visit|download|install|follow|use)\b/i
const sentence = (t: string) => t.split(" ").length >= 4 || /[.!:;]/.test(t)
/** Words that address the assistant or the user. */
const ADDRESSES = /\b(assistant|claude|chatgpt|gpt|ai agent|the agent|the model|language model|llm|you|your|user)\b/i
const LINKS = /https?:\/\/|www\.|\b[\w-]+\.(com|net|org|io|dev|app|ai|co|example)\b|[\w.+-]+@[\w-]+\.[\w.-]+/i

/** A string as memory may show it, cut to 40 characters; undefined when it reads as an instruction or holds a link. */
export const showable = (s: string): string | undefined => {
  const t = s.replace(/\s+/g, " ").trim()
  if (t === "") return undefined
  if (ORDERS.test(t) || (VERBS.test(t) && sentence(t)) || ADDRESSES.test(t) || LINKS.test(t)) return undefined
  return t.length > MAX_SHOWN ? `${t.slice(0, MAX_SHOWN - 1).trimEnd()}…` : t
}

/** A segment that is an id: a number, or a code with two or more digits, a uuid, a long hex. */
const isId = (s: string): boolean =>
  /^\d+$/.test(s) || (/^[\w.-]+$/.test(s) && s.replace(/[^\d]/g, "").length >= 2) || /^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i.test(s)

const segmentsOf = (salt: string, path: string, texts: Map<string, string>): Array<Segment> =>
  path.split("/").filter((s) => s !== "").map((raw) => {
    let s = raw
    try {
      s = decodeURIComponent(raw)
    } catch {
      // Left as written.
    }
    if (isId(s)) return { n: true } as const
    // Apart from labels: a link "Orders" and the path's "orders" are written down as each was seen.
    const fp = fingerprint(salt, `path:${s}`)
    texts.set(fp, s)
    return { fp }
  })

/**
 * A page's address as memory keeps it, and the page text it holds by
 * fingerprint (to write down once seen twice). Undefined for what isn't a
 * web address.
 */
export const addressOf = (salt: string, url: string): { readonly address: Address; readonly texts: Map<string, string> } | undefined => {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
  const texts = new Map<string, string>()
  const hashPath = /^#!?(\/[^?]*)/.exec(u.hash)?.[1]
  const query = [...new Set(u.searchParams.keys())].filter((k) => /^[\w.-]{1,30}$/.test(k)).sort()
  return {
    // The app is the address's host and port; a hash route's path counts when there is one.
    address: { app: u.host.toLowerCase(), path: segmentsOf(salt, u.pathname, texts), ...(hashPath === undefined ? {} : { hash: segmentsOf(salt, hashPath, texts) }), query },
    texts
  }
}

const keyOfSegments = (segs: ReadonlyArray<Segment>) => `/${segs.map((s) => ("n" in s ? "{n}" : s.fp)).join("/")}`

/** The address as a key: page text by fingerprint, so the key itself holds none. */
export const addressKey = (a: Address): string =>
  `${keyOfSegments(a.path)}${a.hash === undefined ? "" : `#${keyOfSegments(a.hash)}`}${a.query.length === 0 ? "" : `?${a.query.join("&")}`}`

/** The address without its query: where a result was checked is named by its path alone. */
export const pathKey = (a: Address): string => addressKey({ ...a, query: [] })

/** The address as it may be shown (`/orders/{n}?tab={}`), or undefined while a segment isn't known in plain text. */
export const showAddress = (a: Address, known: (fp: string) => string | undefined): string | undefined => {
  const show = (segs: ReadonlyArray<Segment>) => {
    const parts: Array<string> = []
    for (const s of segs) {
      if ("n" in s) parts.push("{n}")
      else {
        const t = known(s.fp)
        if (t === undefined || showable(t) === undefined || /[\s/]/.test(t) || t.length > MAX_SHOWN) return undefined
        parts.push(t)
      }
    }
    return `/${parts.join("/")}`
  }
  const path = show(a.path)
  const hash = a.hash === undefined ? "" : show(a.hash)
  if (path === undefined || hash === undefined) return undefined
  return `${path}${a.hash === undefined ? "" : `#${hash}`}${a.query.length === 0 ? "" : `?${a.query.map((k) => `${k}={}`).join("&")}`}`
}

/** Sentences of a prompt that open as an instruction (computer-use-memory.md, "Your rules"). */
const RULE_OPENERS = /^(always|never|from now on|remember that|make sure to always|don't ever|do not ever)\b/i
/** A rule whose object is only "that", "it" or "this" can't stand alone. */
const VAGUE = /^(always|never|from now on|remember that|make sure to always|don't ever|do not ever)\b[\s,]*(\w+\s+){0,2}(that|it|this)[\s.!]*$/i

export const MAX_RULE = 160

/** The person's rules in a prompt, in their own words. */
export const rulesIn = (prompt: string): Array<string> => {
  const out: Array<string> = []
  for (const raw of prompt.replace(/\r\n?/g, "\n").split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim().replace(/^[-*•]\s*/, "")
    if (!RULE_OPENERS.test(s) || VAGUE.test(s)) continue
    if (s.length < 12 || s.length > MAX_RULE) continue
    if (!out.includes(s)) out.push(s)
  }
  return out
}
