import { type PointerEvent, type ReactNode, useState } from "react"
import { fmtK } from "../lib.ts"
import { useTip } from "../Tip.tsx"

// From apps/cli/examples/scripts/RESULTS.md: [tokens, dollars] without and with memory, and the change. A null is a
// number the runs didn't report.
type Row =
  | { readonly grp: string }
  | { readonly name: string; readonly sub: string; readonly runs: string; readonly none: Pair; readonly mem: Pair; readonly pct: Pair }
type Pair = readonly [number | null, number | null]

const ROWS: ReadonlyArray<Row> = [
  { grp: "MARKDOWNLINT · 12 TASKS IN ORDER" },
  { name: "Tasks with a hand-over", sub: "7 tasks · average per pass", runs: "5 passes with memory, 3 without", none: [4.21e6, 2.09], mem: [3.22e6, 1.75], pct: [-24, -16] },
  { name: "Tasks with nothing handed over", sub: "5 tasks · average per pass", runs: "5 passes with memory, 3 without", none: [null, 0.94], mem: [null, 0.94], pct: [null, 0] },
  { grp: "EXCALIDRAW · LONG TASKS" },
  { name: "Mixed changes, first batch", sub: "median of 4 runs", runs: "median of 4 runs each", none: [1051e3, null], mem: [489e3, null], pct: [-53, null] },
  { name: "Mixed changes, second batch", sub: "median of 4 runs", runs: "median of 4 runs each", none: [1051e3, null], mem: [604e3, null], pct: [-43, null] },
  { name: "Four changes, first batch", sub: "median of 8 runs", runs: "median of 8 runs each", none: [1180e3, null], mem: [1079e3, null], pct: [-8, null] },
  { name: "Four changes, second batch", sub: "median of 8 runs", runs: "median of 8 runs each", none: [1180e3, null], mem: [1247e3, null], pct: [6, null] }
]
const METRICS = ["TOKENS", "DOLLARS"] as const
const fmt = [(v: number) => fmtK(v), (v: number) => `$${v.toFixed(2)}`]
const show = (v: number | null, i: number) => (v === null ? "not reported" : fmt[i]!(v))

const P0 = 340, PW = 300, PG = 60, MAX = 125
const x0 = (m: number) => P0 + m * (PW + PG)
const px = (m: number, pct: number) => x0(m) + ((100 + pct) / MAX) * PW

/** The chart's rows, laid out top to bottom; its height is where they end. */
const layout = (tip: (row: Exclude<Row, { grp: string }>, m: number) => (e: PointerEvent) => void) => {
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
          const p = r.pct[i] ?? null, base = px(i, 0)
          if (p === null) return <text key={i} className="ax" x={base + 10} y={cy + 4}>not reported</text>
          const at = px(i, p), left = p < 0
          const s = p === 0 ? "±0%" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`
          return (
            <g key={i}>
              <line className="stem" x1={base} x2={at} y1={cy} y2={cy} />
              <circle className="ref" cx={base} cy={cy} r="3" />
              <circle className="dot" cx={at} cy={cy} r="5" />
              <text className="v" x={left ? at - 10 : Math.max(at, base) + 10} y={cy + 4} textAnchor={left ? "end" : "start"}>{s}</text>
              <rect className="hit" x={x0(i) - 6} y={rowTop + 6} width={PW + 12} height="44" onPointerMove={tip(r, i)} />
            </g>
          )
        })}
      </g>
    )
    y += 50
  })
  return { rows, top, bottom: y }
}

/** Figure 4: cost with memory, as a share of the cost without it. */
export const Results = () => {
  const tip = useTip()
  const [table, setTable] = useState(false)
  const { rows, top, bottom } = layout((r, i) => (e) =>
    tip.show(e, <>
      {r.name}, {METRICS[i]!.toLowerCase()}
      <div className="d">without memory {show(r.none[i] ?? null, i)}, with {show(r.mem[i] ?? null, i)}</div>
      <div className="d">{r.runs}</div>
    </>))

  return (
    <figure aria-labelledby="f4t">
      <div className="fig-head"><h3 id="f4t"><span className="label">Figure 4</span>Cost with memory, as a share of the cost without it</h3></div>
      <div className="scroll">
        <svg
          id="res"
          viewBox={`0 0 1100 ${bottom + 12}`}
          role="img"
          aria-labelledby="f4t"
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
        Left of 100% is cheaper. The excalidraw runs without memory are one batch, compared with each batch with memory.{" "}
        <button className="textbtn" type="button" onClick={() => setTable(!table)}>{table ? "Hide the numbers" : "Show the numbers"}</button>
      </figcaption>
      <div id="f4table" hidden={!table}>
        {table && (
          <table className="res">
            <thead><tr><th>Task</th><th>Runs</th>{METRICS.map((m) => [<th key={m}>{m[0] + m.slice(1).toLowerCase()} without</th>, <th key={`${m}w`}>with</th>])}</tr></thead>
            <tbody>
              {ROWS.flatMap((r) => ("grp" in r ? [] : [
                <tr key={r.name}><td>{r.name}</td><td>{r.runs}</td>{METRICS.map((m, i) => [<td key={m}>{show(r.none[i] ?? null, i)}</td>, <td key={`${m}w`}>{show(r.mem[i] ?? null, i)}</td>])}</tr>
              ]))}
            </tbody>
          </table>
        )}
      </div>
    </figure>
  )
}
