import { type PointerEvent, type ReactNode, useState } from "react"
import { useTip } from "../Tip.tsx"

// Dollars without and with memory. chat-v2: the bench of 2026-10-22 on fresh clones with Claude Code's auto memory
// off, each pair's share taken from its two runs' records. markdownlint: daily use on an earlier hand-over that
// included the diff, three passes on 2026-10-16 and three more on 2026-10-17 that added notes on git show
// (apps/cli/examples/scripts/RESULTS.md). Their intervals are a bootstrap over the 36 task pairs.
interface Measure {
  readonly name: string
  readonly sub: string
  readonly runs: string
  readonly none: number
  readonly mem: number
  readonly change: string
  readonly pairs?: ReadonlyArray<number>
  readonly interval?: readonly [number, number]
}
type Row = { readonly grp: string } | Measure

const ROWS: ReadonlyArray<Row> = [
  { grp: "CHAT-V2 · FRESH CLONES, AUTO MEMORY OFF" },
  {
    name: "Opus", sub: "12 pairs · every run passed", runs: "Two tasks, 6 pairs each. 10 of 12 pairs cheaper with memory.",
    none: 20.58, mem: 15.31, change: "−26%",
    pairs: [0.586, 0.735, 1.069, 0.801, 0.679, 0.878, 0.694, 0.65, 0.533, 1.089, 0.561, 0.872]
  },
  {
    name: "Sonnet", sub: "12 pairs · passed 12 with, 10 without", runs: "Two tasks, 6 pairs each. 6 of 12 pairs cheaper with memory.",
    none: 3.51, mem: 3.5, change: "−0.3%",
    pairs: [0.729, 1.067, 1.147, 0.862, 1.263, 1.29, 0.948, 0.949, 0.696, 0.928, 1.189, 1.014]
  },
  { grp: "MARKDOWNLINT · DAILY USE, AN EARLIER HAND-OVER WITH THE DIFF" },
  { name: "Three passes", sub: "12 tasks each · Sonnet", runs: "36 task pairs, 2026-10-16.", none: 10.86, mem: 10.19, change: "−6%", interval: [0.87, 1.01] },
  { name: "Three more, notes on git show", sub: "12 tasks each · Sonnet", runs: "36 task pairs, 2026-10-17.", none: 10.74, mem: 10.53, change: "−1.9%", interval: [0.883, 1.077] }
]
const dollars = (v: number) => `$${v.toFixed(2)}`
const pct = (share: number) => `${share < 1 ? "−" : "+"}${Math.abs(Math.round((share - 1) * 100))}%`

const P0 = 360, PW = 620, MAX = 1.4, V = 1030
const px = (share: number) => P0 + (share / MAX) * PW

/** The chart's rows, laid out top to bottom. Its height is where they end. */
const layout = (tip: (row: Measure) => (e: PointerEvent) => void) => {
  const rows: Array<ReactNode> = []
  let y = 30
  const top = y
  ROWS.forEach((r, ri) => {
    if ("grp" in r) {
      y += 28
      rows.push(<text key={`g${ri}`} className="grp" x="0" y={y}>{r.grp}</text>, <line key={`s${ri}`} className="sep" x1="0" x2="1100" y1={y + 9} y2={y + 9} />)
      y += 10
      return
    }
    const cy = y + 30, at = px(r.mem / r.none), base = px(1)
    rows.push(
      <g key={ri} className="hitrow">
        <rect className="rowband" x="0" y={y + 6} width="1100" height="48" />
        <text className="rowlab" x="0" y={cy - 1}>{r.name}</text>
        <text className="rowsub" x="0" y={cy + 15}>{r.sub}</text>
        {r.interval && <>
          <line className="ci" x1={px(r.interval[0])} x2={px(r.interval[1])} y1={cy} y2={cy} />
          {r.interval.map((v) => <line key={v} className="ci" x1={px(v)} x2={px(v)} y1={cy - 5} y2={cy + 5} />)}
        </>}
        {r.pairs?.map((v, k) => <circle key={k} className="pair" cx={px(v)} cy={cy + (k % 2 ? 7 : -7)} r="3.5" />)}
        <line className="stem" x1={base} x2={at} y1={cy} y2={cy} />
        <circle className="dot" cx={at} cy={cy} r="6" />
        <text className="v" x={V} y={cy + 4}>{r.change}</text>
        <rect className="hit" x="0" y={y + 6} width="1100" height="48" onPointerMove={tip(r)} />
      </g>
    )
    y += 54
  })
  return { rows, top, bottom: y }
}

/** Figure 4: cost with memory, as a share of the cost without it. */
export const Results = () => {
  const tip = useTip()
  const [table, setTable] = useState(false)
  const { rows, top, bottom } = layout((r) => (e) =>
    tip.show(e, <>
      {r.name}
      <div className="d">without memory {dollars(r.none)}, with {dollars(r.mem)}</div>
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
          <text className="ph" x={P0} y="12">DOLLARS</text>
          <text className="ph" x={V} y="12">CHANGE</text>
          {[0, 0.5, 1].map((g) => <text key={g} className="ax" x={px(g)} y="30" textAnchor={g === 0 ? "start" : "middle"}>{g * 100}%</text>)}
          {[0, 0.5].map((g) => <line key={g} className="grid" x1={px(g)} x2={px(g)} y1={top} y2={bottom + 6} />)}
          <line className="base" x1={px(1)} x2={px(1)} y1={top} y2={bottom + 6} />
          {rows}
        </svg>
      </div>
      <figcaption>
        Left of 100% is cheaper with memory. The red dot is all the runs together, and each hollow dot is one pair of
        runs. For markdownlint, the line is a 95% interval from a bootstrap over the 36 task pairs.{" "}
        <button className="textbtn" type="button" onClick={() => setTable(!table)}>{table ? "Hide the numbers" : "Show the numbers"}</button>
      </figcaption>
      <div id="f4table" hidden={!table}>
        {table && (
          <table className="res">
            <thead><tr><th>Measure</th><th>Runs</th><th>Without memory</th><th>With memory</th><th>Change</th></tr></thead>
            <tbody>
              {ROWS.flatMap((r) => ("grp" in r ? [] : [
                <tr key={r.name}>
                  <td>{r.name}<small>{r.sub}</small></td><td>{r.runs}</td><td>{dollars(r.none)}</td><td>{dollars(r.mem)}</td>
                  <td>{r.change}{r.interval && ` (${pct(r.interval[0])} to ${pct(r.interval[1])})`}</td>
                </tr>
              ]))}
            </tbody>
          </table>
        )}
      </div>
    </figure>
  )
}
