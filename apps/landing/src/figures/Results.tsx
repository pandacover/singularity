import { type PointerEvent, type ReactNode, useState } from "react"
import { fmtK } from "../lib.ts"
import { useTip } from "../Tip.tsx"

// Medians from the pre-registered measurements of memory v1: [tokens, dollars, turns] without and with memory, and the change.
type Row =
  | { readonly grp: string }
  | { readonly name: string; readonly sub: string; readonly n: number; readonly none: Triple; readonly mem: Triple; readonly pct: Triple }
type Triple = readonly [number, number, number]

const ROWS: ReadonlyArray<Row> = [
  { grp: "KINDS OF CHANGE MEMORY HAD LEARNED" },
  { name: "Long task, four changes", sub: "excalidraw · all four known", n: 4, none: [1902e3, 0.81, 28.5], mem: [423e3, 0.30, 9.5], pct: [-78, -63, -67] },
  { name: "Long task, two of four known", sub: "excalidraw · plus two unseen bugs", n: 4, none: [1287e3, 0.64, 21.5], mem: [788e3, 0.40, 15], pct: [-39, -38, -30] },
  { grp: "TASKS IT HADN’T LEARNED" },
  { name: "Add a ULID validator", sub: "validator.js · small task", n: 3, none: [185e3, 0.11, 6], mem: [203e3, 0.10, 7], pct: [9, -7, 17] },
  { name: "Postal codes for Pakistan", sub: "validator.js · small task", n: 3, none: [220e3, 0.09, 8], mem: [222e3, 0.09, 8], pct: [1, -2, 0] },
  { name: "Bug: save-as in the text editor", sub: "excalidraw · nothing matched", n: 3, none: [396e3, 0.21, 12], mem: [398e3, 0.17, 12], pct: [0, -15, 0] },
  { name: "Bug: dropdown outside click", sub: "excalidraw · a workflow that didn’t fit", n: 3, none: [374e3, 0.17, 12], mem: [302e3, 0.18, 9], pct: [-19, 5, -25] }
]
const METRICS = ["TOKENS", "DOLLARS", "TURNS"] as const
const fmt = [(v: number) => fmtK(v), (v: number) => `$${v.toFixed(2)}`, (v: number) => `${v}`]

const P0 = 300, PW = 220, PG = 40, MAX = 125
const x0 = (m: number) => P0 + m * (PW + PG)
const px = (m: number, pct: number) => x0(m) + ((100 + pct) / MAX) * PW

/** The chart's rows, laid out top to bottom; its height is where they end. */
const layout = (show: (row: Exclude<Row, { grp: string }>, m: number) => (e: PointerEvent) => void) => {
  const rows: Array<ReactNode> = []
  let y = 36
  const top = y
  ROWS.forEach((r, ri) => {
    if ("grp" in r) {
      y += 28
      rows.push(<text key={`g${ri}`} className="grp" x="0" y={y}>{r.grp}</text>, <line key={`s${ri}`} className="sep" x1="0" x2="1100" y1={y + 9} y2={y + 9} />)
      y += 10
      return
    }
    const cy = y + 28, rowTop = y
    rows.push(
      <g key={ri} className="hitrow">
        <rect className="rowband" x="0" y={rowTop + 6} width="1100" height="44" />
        <text className="rowlab" x="0" y={cy - 1}>{r.name}</text>
        <text className="rowsub" x="0" y={cy + 15}>{r.sub}</text>
        {METRICS.map((_, i) => {
          const base = px(i, 0), at = px(i, r.pct[i]), p = r.pct[i], left = p < 0
          const s = p === 0 ? "±0%" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`
          return (
            <g key={i}>
              <line className="stem" x1={base} x2={at} y1={cy} y2={cy} />
              <circle className="ref" cx={base} cy={cy} r="3" />
              <circle className="dot" cx={at} cy={cy} r="5" />
              <text className="v" x={left ? at - 10 : Math.max(at, base) + 10} y={cy + 4} textAnchor={left ? "end" : "start"}>{s}</text>
              <rect className="hit" x={x0(i) - 6} y={rowTop + 6} width={PW + 12} height="44" onPointerMove={show(r, i)} />
            </g>
          )
        })}
      </g>
    )
    y += 50
  })
  return { rows, top, bottom: y }
}

/** Figure 5: cost with memory, as a share of the cost without it. */
export const Results = () => {
  const tip = useTip()
  const [table, setTable] = useState(false)
  const { rows, top, bottom } = layout((r, i) => (e) =>
    tip.show(e, <>
      {r.name}, {METRICS[i]!.toLowerCase()}
      <div className="d">without memory {fmt[i]!(r.none[i]!)}, with {fmt[i]!(r.mem[i]!)}</div>
      <div className="d">median of {r.n} runs each</div>
    </>))

  return (
    <figure aria-labelledby="f5t">
      <div className="fig-head"><h3 id="f5t"><span className="label">Figure 5</span>Cost with memory, as a share of the cost without it</h3></div>
      <div className="scroll">
        <svg
          id="res"
          viewBox={`0 0 1100 ${bottom + 12}`}
          role="img"
          aria-labelledby="f5t"
          onPointerMove={(e) => { if (!(e.target as Element).closest(".hit")) tip.hide() }}
          onPointerLeave={tip.hide}
        >
          {METRICS.map((m, i) => (
            <g key={m}>
              <text className="ph" x={x0(i)} y="12">{m}</text>
              {[0, 50, 100].map((g) => <text key={g} className="ax" x={x0(i) + (g / MAX) * PW} y="30" textAnchor={g === 0 ? "start" : "middle"}>{g}%</text>)}
            </g>
          ))}
          {METRICS.map((m, i) => (
            <g key={m}>
              {[0, 50].map((g) => <line key={g} className="grid" x1={x0(i) + (g / MAX) * PW} x2={x0(i) + (g / MAX) * PW} y1={top} y2={bottom + 6} />)}
              <line className="base" x1={px(i, 0)} x2={px(i, 0)} y1={top} y2={bottom + 6} />
            </g>
          ))}
          {rows}
        </svg>
      </div>
      <figcaption>
        Medians of 3–4 runs per side. Left of 100% is cheaper.{" "}
        <button className="textbtn" type="button" onClick={() => setTable(!table)}>{table ? "Hide the numbers" : "Show the numbers"}</button>
      </figcaption>
      <div id="f5table" hidden={!table}>
        {table && (
          <table className="res">
            <thead><tr><th>Task</th><th>Runs</th>{METRICS.map((m) => [<th key={m}>{m[0] + m.slice(1).toLowerCase()} without</th>, <th key={`${m}w`}>with</th>])}</tr></thead>
            <tbody>
              {ROWS.flatMap((r) => ("grp" in r ? [] : [
                <tr key={r.name}><td>{r.name}</td><td>{r.n} + {r.n}</td>{METRICS.map((m, i) => [<td key={m}>{fmt[i]!(r.none[i])}</td>, <td key={`${m}w`}>{fmt[i]!(r.mem[i])}</td>])}</tr>
              ]))}
            </tbody>
          </table>
        )}
      </div>
    </figure>
  )
}
