/**
 * Python's float formatting for the few specs the reports use, so tables are
 * identical to the ones the Python version printed.
 *
 * Python rounds the exact binary value half to even ("{:.0f}" of 6.5 is "6"),
 * where `Number.prototype.toFixed` rounds ties up ("7"), and the medians of an
 * even number of runs hit those ties.
 */

/** `format(x, ".{digits}f")`, with `,` grouping of the integer part when `grouping` is set. */
export const pyFixed = (x: number, digits: number, grouping = false): string => {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
  const negative = x < 0 || Object.is(x, -0)
  // Exact decimal expansion of the double (enough digits for any value a report shows).
  const [intPart, fracPart = ""] = Math.abs(x).toFixed(100).split(".")
  const kept = fracPart.slice(0, digits)
  const rest = fracPart.slice(digits)
  let scaled = BigInt(intPart + kept)
  const firstRest = rest[0] ?? "0"
  const tie = firstRest === "5" && /^0*$/.test(rest.slice(1))
  if (firstRest > "5" || (firstRest === "5" && !tie) || (tie && scaled % 2n === 1n)) scaled += 1n
  let text = scaled.toString().padStart(digits + 1, "0")
  let whole = digits > 0 ? text.slice(0, -digits) : text
  const frac = digits > 0 ? text.slice(-digits) : ""
  if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  text = digits > 0 ? `${whole}.${frac}` : whole
  return negative ? `-${text}` : text
}

/** `format(x, "+.{digits}%")`: the value times 100, always signed. */
export const pyPercentSigned = (x: number, digits = 0): string => {
  const text = pyFixed(x * 100, digits)
  return (text.startsWith("-") ? text : `+${text}`) + "%"
}

/** `statistics.median`: the middle value, or the mean of the middle two. */
export const median = (xs: ReadonlyArray<number>): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
