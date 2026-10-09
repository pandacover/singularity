/**
 * The tool calls in a script Codex runs in its code mode, where the model
 * writes JavaScript that calls its tools (`await tools.shell_command({...})`)
 * instead of calling them one by one.
 *
 * Only arguments written as literals are read: objects, arrays, strings
 * (template strings without `${}` included), numbers, booleans and null, or a
 * name a `const`, `let` or `var` gave such a literal. The script is never run;
 * a call whose argument is anything else comes without it, so the calls still
 * line up with the results the script printed.
 */

export interface ScriptCall {
  readonly tool: string
  /** Undefined when the argument isn't a literal. */
  readonly args: unknown
}

type Parsed = { readonly value: unknown; readonly end: number } | undefined

const space = (src: string, at: number): number => {
  let i = at
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src.startsWith("//", i)) {
      const n = src.indexOf("\n", i)
      i = n === -1 ? src.length : n + 1
    } else if (src.startsWith("/*", i)) {
      const n = src.indexOf("*/", i + 2)
      i = n === -1 ? src.length : n + 2
    } else return i
  }
}

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" }

const string = (src: string, at: number): Parsed => {
  const quote = src[at]
  let out = ""
  let i = at + 1
  while (i < src.length) {
    const c = src[i]
    if (c === quote) return { value: out, end: i + 1 }
    if (quote === "`" && c === "$" && src[i + 1] === "{") return undefined
    if (quote !== "`" && c === "\n") return undefined
    if (c !== "\\") {
      out += c
      i++
      continue
    }
    const e = src[i + 1]
    if (e === undefined) return undefined
    if (e === "u" && src[i + 2] === "{") {
      const close = src.indexOf("}", i + 3)
      if (close === -1) return undefined
      out += String.fromCodePoint(parseInt(src.slice(i + 3, close), 16))
      i = close + 1
    } else if (e === "u" || e === "x") {
      const len = e === "u" ? 4 : 2
      const hex = src.slice(i + 2, i + 2 + len)
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return undefined
      out += String.fromCharCode(parseInt(hex, 16))
      i += 2 + len
    } else if (e === "\r" || e === "\n") {
      // A line continuation.
      i += e === "\r" && src[i + 2] === "\n" ? 3 : 2
    } else {
      out += ESCAPES[e] ?? e
      i += 2
    }
  }
  return undefined
}

const IDENT = /[A-Za-z_$][\w$]*/y
const NUMBER = /-?(?:0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y

const ident = (src: string, at: number): string | undefined => {
  IDENT.lastIndex = at
  return IDENT.exec(src)?.[0]
}

/** The literal starting at `at`, and where it ends. */
export const literal = (src: string, at: number): Parsed => {
  const i = space(src, at)
  const c = src[i]
  if (c === undefined) return undefined
  if (c === '"' || c === "'" || c === "`") return string(src, i)
  if (c === "[") {
    const items: Array<unknown> = []
    let j = space(src, i + 1)
    while (src[j] !== "]") {
      const item = literal(src, j)
      if (item === undefined) return undefined
      items.push(item.value)
      j = space(src, item.end)
      if (src[j] === ",") j = space(src, j + 1)
      else if (src[j] !== "]") return undefined
    }
    return { value: items, end: j + 1 }
  }
  if (c === "{") {
    const obj: Record<string, unknown> = {}
    let j = space(src, i + 1)
    while (src[j] !== "}") {
      let key: string | undefined
      if (src[j] === '"' || src[j] === "'") {
        const k = string(src, j)
        if (k === undefined) return undefined
        key = k.value as string
        j = k.end
      } else {
        key = ident(src, j)
        if (key === undefined) return undefined
        j += key.length
      }
      j = space(src, j)
      if (src[j] !== ":") return undefined
      const value = literal(src, j + 1)
      if (value === undefined) return undefined
      obj[key] = value.value
      j = space(src, value.end)
      if (src[j] === ",") j = space(src, j + 1)
      else if (src[j] !== "}") return undefined
    }
    return { value: obj, end: j + 1 }
  }
  NUMBER.lastIndex = i
  const n = NUMBER.exec(src)
  if (n !== null) return { value: Number(n[0].replace(/_/g, "")), end: i + n[0].length }
  const word = ident(src, i)
  if (word === "true" || word === "false") return { value: word === "true", end: i + word.length }
  if (word === "null" || word === "undefined") return { value: null, end: i + word.length }
  return undefined
}

/** The script's `tools.<name>(...)` calls, in order. */
export const scriptCalls = (script: string): Array<ScriptCall> => {
  const bound = new Map<string, unknown>()
  for (const m of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const value = literal(script, m.index + m[0].length)
    if (value !== undefined) bound.set(m[1], value.value)
  }
  const out: Array<ScriptCall> = []
  for (const m of script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const at = space(script, m.index + m[0].length)
    const value = literal(script, at)
    if (value !== undefined && script[space(script, value.end)] === ")") {
      out.push({ tool: m[1], args: value.value })
      continue
    }
    const name = ident(script, at)
    if (name !== undefined && bound.has(name) && script[space(script, at + name.length)] === ")") out.push({ tool: m[1], args: bound.get(name) })
    else out.push({ tool: m[1], args: script[at] === ")" ? {} : undefined })
  }
  return out
}
