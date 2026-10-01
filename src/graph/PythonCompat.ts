/**
 * How the Python version sorted and formatted things, so that stores, results
 * and error messages stay identical across the two implementations.
 */

/**
 * Python's string order: by code point. JavaScript's `<` compares UTF-16 code
 * units, which puts astral characters before U+E000..U+FFFF.
 */
export const compareCodePoints = (a: string, b: string): number => {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const x = a.codePointAt(i) ?? 0
    const y = b.codePointAt(i) ?? 0
    if (x !== y) return x < y ? -1 : 1
    if (x > 0xffff) i++
  }
  return a.length - b.length
}

const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0")

/** Python's `repr()` of a string, as in `f"{value!r}"`. */
export const repr = (value: string): string => {
  const quote = value.includes("'") && !value.includes("\"") ? "\"" : "'"
  let out = quote
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === quote || char === "\\") out += `\\${char}`
    else if (char === "\t") out += "\\t"
    else if (char === "\n") out += "\\n"
    else if (char === "\r") out += "\\r"
    else if (char !== " " && NON_PRINTABLE.test(char)) {
      out += code < 0x100 ? `\\x${hex(code, 2)}` : code < 0x10000 ? `\\u${hex(code, 4)}` : `\\U${hex(code, 8)}`
    } else out += char
  }
  return out + quote
}

/**
 * How Python's `json` module writes a float: the shortest digits that round
 * trip (as in JavaScript), in `repr()` notation (`1.0`, `1e-05`, `1e+16`).
 */
export const floatJson = (value: number): string => {
  if (Number.isNaN(value)) return "NaN"
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity"
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"
  const [digits, exponent] = value.toExponential().split("e")
  const e = Number(exponent)
  if (e < -4 || e >= 16) return `${digits}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`
  const fixed = String(value)
  return fixed.includes(".") ? fixed : `${fixed}.0`
}

/** Which fields need Python's types, which plain JSON values can't express. */
export interface JsonFields {
  /** Numbers Python stored as floats, written as `1.0` rather than `1`. */
  readonly floats: ReadonlySet<string>
  /** Dicts Python wrote sorted by key. Their keys are data, not field names. */
  readonly sorted: ReadonlySet<string>
}

/**
 * JSON text as `json.dump(value, file, indent=2, ensure_ascii=False)` and a
 * final newline write it. Array items inherit their field's rules.
 */
export const formatJson = (value: unknown, fields: JsonFields): string => {
  const write = (value: unknown, indent: string, field: string | undefined): string => {
    if (value === null) return "null"
    switch (typeof value) {
      case "boolean":
        return value ? "true" : "false"
      case "string":
        return JSON.stringify(value)
      case "number":
        return Number.isInteger(value) && !(field !== undefined && fields.floats.has(field))
          ? String(value)
          : floatJson(value)
      case "object": {
        const inner = `${indent}  `
        if (Array.isArray(value)) {
          if (value.length === 0) return "[]"
          return `[\n${value.map((item) => inner + write(item, inner, field)).join(",\n")}\n${indent}]`
        }
        const sorted = field !== undefined && fields.sorted.has(field)
        const entries = Object.entries(value)
        if (sorted) entries.sort(([a], [b]) => compareCodePoints(a, b))
        if (entries.length === 0) return "{}"
        const lines = entries.map(([key, item]) =>
          `${inner}${JSON.stringify(key)}: ${write(item, inner, sorted ? undefined : key)}`
        )
        return `{\n${lines.join(",\n")}\n${indent}}`
      }
    }
    throw new TypeError(`can't write a ${typeof value} as JSON`)
  }
  return `${write(value, "", undefined)}\n`
}

/**
 * Python's `datetime.now(UTC).isoformat()` for a time formatted by
 * `DateTime.formatIso` (`2026-10-01T12:00:01.250Z`): microseconds, `+00:00`,
 * and no fraction when it is zero.
 */
export const isoformat = (iso: string): string => {
  const millis = iso.slice(20, 23)
  return `${iso.slice(0, 19)}${millis === "000" ? "" : `.${millis}000`}+00:00`
}

/** Python's `f"{n:06d}"`, used in file names. */
export const zeroPad6 = (n: number): string => n < 0 ? `-${String(-n).padStart(5, "0")}` : String(n).padStart(6, "0")
