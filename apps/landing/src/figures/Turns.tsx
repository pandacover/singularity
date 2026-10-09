import { useLayoutEffect, useRef, useState } from "react"
import { type Run, RUNS } from "../data/runs.ts"
import { fmtK, med, reduced, useOnceVisible } from "../lib.ts"
import { useTip } from "../Tip.tsx"

const none = RUNS.filter((r) => r.setup === "none").sort((a, b) => a.turns - b.turns)
const mem = RUNS.filter((r) => r.setup === "mem").sort((a, b) => a.turns - b.turns)
const looking = (rs: ReadonlyArray<Run>) => med(rs.map((r) => r.cells.filter((c) => c[0] === "r").length))
const memDone = Math.max(...mem.map((r) => r.turns))
const sum = (rs: ReadonlyArray<Run>) => `median ${med(rs.map((r) => r.turns))} turns · ${fmtK(med(rs.map((r) => r.tokens)))} tokens`
const KIND = { r: "", w: " w", x: " x", o: " o" }

/** Figure 2: each run is a column of its turns, side by side. */
export const Turns = () => {
  const tip = useTip()
  const host = useRef<HTMLDivElement>(null)
  const memGroup = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(!reduced)
  const [lineBottom, setLineBottom] = useState(0)

  useOnceVisible(host, () => setHidden(false))

  useLayoutEffect(() => {
    const place = () => {
      const cols = [...(memGroup.current?.querySelectorAll<HTMLElement>(".col") ?? [])]
      setLineBottom(Math.max(...cols.map((c) => c.offsetHeight)) + 1)
    }
    place()
    addEventListener("resize", place)
    return () => removeEventListener("resize", place)
  }, [])

  const col = (r: Run, isMem: boolean) => (
    <div className="col" key={RUNS.indexOf(r)}>
      {isMem ? <span className="hand" title="memory’s hand-over" /> : <span className="nohand" />}
      {r.cells.map((c, i) => (
        <span
          key={i}
          className={`c${KIND[c[0]]}${c[1] ? " f" : ""}`}
          style={{ transitionDelay: `${i * 40}ms` }}
          onPointerMove={(e) =>
            tip.show(e, <>
              <div className="d">{r.setup === "mem" ? "with memory" : "without memory"} · turn {i + 1} of {r.turns}</div>
              {c[2]}
              {c[3] && <div className="e">failed: {c[3]}</div>}
            </>)}
        />
      ))}
    </div>
  )

  return (
    <figure className="fig-turns" aria-labelledby="f2t">
      <div className="fig-head">
        <h3 id="f2t"><span className="label">Figure 2</span>Where the turns went</h3>
        <div className="legend" aria-hidden="true">
          <span><i className="lg" />reading, searching</span>
          <span><i className="lg w" />editing</span>
          <span><i className="lg x" />running checks</span>
          <span><i className="lg o" />final reply</span>
          <span>× failed</span>
          <span><i className="lg h" />memory’s hand-over</span>
        </div>
      </div>
      <div className="f1">
        <div className="pull">
          <div className="big">{looking(none)}<span className="to">→</span><span className="m">{looking(mem)}</span></div>
          <p>turns spent just reading and searching, without memory and with it</p>
        </div>
        <div
          className={hidden ? "towers hide" : "towers"}
          ref={host}
          onPointerMove={(e) => { if (!(e.target as Element).closest(".c")) tip.hide() }}
          onPointerLeave={tip.hide}
        >
          <div className="trow plot">
            <div className="grp">{none.map((r) => col(r, false))}</div>
            <div className="grp" ref={memGroup}>{mem.map((r) => col(r, true))}</div>
            <div className="done-line" style={{ bottom: `${lineBottom}px` }}><span>turn {memDone}: all memory runs done</span></div>
          </div>
          <div className="trow nums">
            <div className="grp">{none.map((r, i) => <span key={i}>{r.turns}</span>)}</div>
            <div className="grp mem">{mem.map((r, i) => <span key={i}>{r.turns}</span>)}</div>
          </div>
          <div className="trow names">
            <div className="grp"><b>Without memory</b><small>{sum(none)}</small></div>
            <div className="grp mem"><b>With singularity</b><small>{sum(mem)}</small></div>
          </div>
        </div>
      </div>
      <figcaption>Eight real runs of the same task: four changes to <a href="https://github.com/excalidraw/excalidraw">excalidraw</a> in one prompt. All passed. Each block is one turn, the first at the bottom; hover one to see what the agent did.</figcaption>
    </figure>
  )
}
