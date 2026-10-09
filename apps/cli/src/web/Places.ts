/**
 * Places on web pages, for the web reader of the memory layer.
 *
 * A place in code is the chain of blocks around an edit (src/workflows/Places.ts);
 * a place on a page is the chain of named regions around the control an
 * action used, from the page's top inward, ending with the control itself:
 *
 *     /orders/{n} › region "Actions" › group "More actions" › button "Refund"
 *
 * The page is its address as a pattern (ids as `{n}`, the task's own values
 * as `{value}`), and names lose the task's values the same way. Memory keeps
 * the pattern, never a page; at use the place is looked for in the page the
 * agent has open, and left out when it isn't there.
 */
import { createHash } from "node:crypto"
import type { Place } from "../workflows/Models.ts"
import { ancestors, byRef, isRegion, type SnapNode } from "./Snapshot.ts"

export interface Region {
  readonly role: string
  readonly name: string
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const STOP = new Set(["The", "A", "An", "Please", "Then", "And", "For", "In", "On", "At", "To", "Of", "With", "From", "By", "Use", "Open", "Go", "If", "When", "It", "This", "That", "Make", "Set", "Add", "Mark", "Find", "Create", "Update", "Change", "Send", "Move", "Refund", "Cancel", "Export", "Delete", "Remove", "Give", "Put", "Record", "Log", "Note", "Our", "We", "You", "I", "Can", "Could", "Should", "Thanks", "Hi", "Hello"])

/**
 * The task's own values, which memory must never carry: numbers and codes,
 * quoted text, e-mail addresses, dates, and names (runs of capitalized words
 * that don't start a sentence).
 */
export const taskValues = (prompt: string): Array<string> => {
  const out = new Set<string>()
  const text = prompt.replace(/https?:\/\/\S+/g, " ")
  for (const m of text.matchAll(/"([^"\n]{2,80})"|“([^”\n]{2,80})”|'([^'\n]{3,80})'/g)) out.add((m[1] ?? m[2] ?? m[3]).trim())
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) out.add(m[0])
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)) out.add(m[0])
  for (const m of text.matchAll(/\b[A-Z]{1,6}-?\d[\w-]*\b|\b\d[\w-]*[A-Za-z][\w-]*\b/g)) out.add(m[0])
  for (const m of text.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)) if (m[0].replace(/[^\d]/g, "").length >= 2) out.add(m[0])
  // Names: capitalized words after the first word of a sentence.
  for (const sentence of text.split(/(?<=[.!?:;\n])\s+/)) {
    const words = sentence.split(/\s+/)
    let run: Array<string> = []
    const flush = () => {
      if (run.length > 0) out.add(run.join(" "))
      run = []
    }
    words.forEach((w, i) => {
      const clean = w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "")
      const cap = /^[A-Z][a-zA-Z'’-]+$/.test(clean) && !STOP.has(clean)
      if (i > 0 && cap) run.push(clean)
      else flush()
      if (/[,;)]$/.test(w)) flush()
    })
    flush()
  }
  return [...out].filter((v) => v.length >= 2).sort((a, b) => b.length - a.length)
}

/** A text with the task's values and anything like an id, a date, an e-mail or an amount left as blanks. */
export const blankText = (s: string, values: ReadonlyArray<string>): string => {
  // Numbers first, so an id is {n} whether or not the task named it.
  let t = s
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "{email}")
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "{date}")
    .replace(/\$?\d[\d,]*(?:\.\d+)?%?/g, "{n}")
  for (const v of values) {
    if (v.length < 2 || /\d/.test(v)) continue
    t = t.replace(new RegExp(`(^|[^A-Za-z0-9])${escape(v)}(?=$|[^A-Za-z0-9])`, "gi"), (_m, pre: string) => `${pre}{value}`)
  }
  return t
    .replace(/(\{(?:value|n)\}[\s,./-]*){2,}/g, (m) => (m.includes("{value}") ? "{value} " : "{n} ").trimEnd() + (/\s$/.test(m) ? " " : ""))
}

/** A page's address as a pattern: its path and query keys, with ids and the task's values as blanks. */
export const pagePattern = (url: string, values: ReadonlyArray<string>): string => {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return blankText(url, values)
  }
  const path = u.pathname.split("/").map((seg) => {
    const s = decodeURIComponent(seg)
    if (s === "") return s
    if (/\d/.test(s) && /^[\w.-]+$/.test(s) && (/^\d+$/.test(s) || s.replace(/[^\d]/g, "").length >= 2)) return "{n}"
    const b = blankText(s, values)
    return b
  }).join("/")
  const keys = [...u.searchParams.keys()].sort()
  const query = keys.map((k) => `${k}=${blankText(u.searchParams.get(k) ?? "", values) || "{}"}`).join("&")
  return query === "" ? path || "/" : `${path || "/"}?${query}`
}

export const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** The subject a web app is: one per origin. */
export const webSubjectId = (origin: string): string =>
  `web-${origin.replace(/^https?:\/\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`

export const firstUrl = (text: string): string | undefined => /https?:\/\/[^\s)>"'\]]+/.exec(text)?.[0]?.replace(/[.,;]+$/, "")

export const regionHead = (r: Region): string => (r.name === "" ? r.role : `${r.role} ${JSON.stringify(r.name)}`)

export const parseHead = (head: string): Region => {
  const m = /^([A-Za-z][A-Za-z0-9-]*)(?: (".*"))?$/.exec(head)
  if (m === null) return { role: head, name: "" }
  let name = ""
  if (m[2] !== undefined) {
    try {
      name = JSON.parse(m[2]) as string
    } catch {
      name = m[2].slice(1, -1)
    }
  }
  return { role: m[1], name }
}

/** The chain of named regions around an element, ending with the element: names with the task's values as blanks. */
export const chainOf = (nodes: ReadonlyArray<SnapNode>, ref: string, values: ReadonlyArray<string>): Array<Region> | undefined => {
  const node = byRef(nodes, ref)
  if (node === undefined) return undefined
  const around = ancestors(nodes, node).filter(isRegion)
  return [...around, node].map((n) => ({ role: n.role, name: blankText(n.name.trim(), values).slice(0, 120) }))
}

export const webPlaceKey = (page: string, chain: ReadonlyArray<Region>): string => JSON.stringify(["web", page, chain.map(regionHead)])

export const webPlaceId = (subject: string, page: string, chain: ReadonlyArray<Region>): string =>
  `w-${createHash("sha256").update(`${subject}\u0000${webPlaceKey(page, chain)}`).digest("hex").slice(0, 8)}`

export const webPlace = (subject: string, page: string, chain: ReadonlyArray<Region>, evidence: ReadonlyArray<string>, tasks: ReadonlyArray<string>, uses: number): Place => ({
  id: webPlaceId(subject, page, chain),
  subject,
  file: page,
  chain: chain.map((r) => ({ head: regionHead(r), open: null, opener: null, close: null })),
  group: null,
  new_file: null,
  evidence: [...evidence],
  tasks: [...tasks],
  edits: { add: 0, change: uses, create: 0 },
  kind: "web"
})

export const isWebPlace = (p: Place): boolean => p.kind === "web"

export const chainOfPlace = (p: Place): Array<Region> => p.chain.map((b) => parseHead(b.head))

export const describeWebPlace = (p: Place): string => `${p.file} › ${p.chain.map((b) => b.head).join(" › ")}`

/** A blanked name as a pattern: blanks match any text. */
const namePattern = (name: string): RegExp => {
  const parts = name.split(/\{[a-z]+\}/i).map(escape)
  return new RegExp(`^${parts.join(".+?")}$`, "i")
}

const sameRegion = (want: Region, n: SnapNode): boolean => want.role === n.role && namePattern(want.name).test(n.name.trim())

const GLOBAL = new Set(["navigation", "banner", "menubar", "contentinfo"])

export interface Found {
  readonly place: Place
  readonly node: SnapNode
}

/**
 * The element a place points at in this page, if the page has it: an element
 * of the same role and name whose regions include the place's, in order.
 * Only on the place's own page, unless the place is in the page's navigation.
 */
export const findPlace = (place: Place, nodes: ReadonlyArray<SnapNode>, page: string | undefined): Found | undefined => {
  const chain = chainOfPlace(place)
  const target = chain[chain.length - 1]
  if (target === undefined) return undefined
  const regions = chain.slice(0, -1)
  const global = regions.some((r) => GLOBAL.has(r.role))
  if (page !== undefined && !global && !namePattern(place.file).test(page) && place.file !== page) return undefined
  for (const n of nodes) {
    if (!sameRegion(target, n) || n.ref === undefined) continue
    const around = ancestors(nodes, n).filter(isRegion)
    let k = 0
    for (const a of around) if (k < regions.length && sameRegion(regions[k], a)) k++
    if (k === regions.length) return { place, node: n }
  }
  return undefined
}
