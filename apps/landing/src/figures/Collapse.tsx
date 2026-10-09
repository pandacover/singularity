import { useLayoutEffect, useRef, useState } from "react"
import { RUNS } from "../data/runs.ts"
import { MEMORY } from "../data/memory.ts"
import { reduced } from "../lib.ts"

// The runs without memory from Figure 2, turn by turn, bending into one point: the way through that
// memory keeps, as a workflow. Drawn in a fixed box, so it holds its space before it plays.
const runs = RUNS.filter((r) => r.setup === "none")
const turns = runs.reduce((n, r) => n + r.turns, 0)
const workflow = MEMORY.workflows.find((w) => w.id === "add-app-state-field")!
// the runs meet at the middle of the svg's right edge, which is the card's left edge: the point grows into the card
const W = 772, H = 214, ROW = 48, X0 = 128, STEP = 12, FX = W, FY = H / 2
const TOP = FY - 7 - (ROW * (runs.length - 1)) / 2
const KIND = { r: "", w: " w", x: " x", o: " o" }
const FILL = { field: "presenterModeEnabled", default: "false" }

/** Figure 1: four runs without memory, and the workflow memory keeps from that kind of task. */
export const Collapse = () => {
  const svg = useRef<SVGSVGElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [filled, setFilled] = useState(reduced)
  const [round, setRound] = useState(0)

  // about 4 s, opacity and transforms only; started before the first paint, so nothing flashes
  useLayoutEffect(() => {
    if (reduced) return
    const s = svg.current!, c = card.current!, all: Array<Animation> = []
    const ease = "cubic-bezier(.2,.8,.2,1)", f = { fill: "both" as const }
    const go = (el: Element, frames: Array<Keyframe>, opts: KeyframeAnimationOptions) => all.push(el.animate(frames, { ...f, ...opts }))
    setFilled(false)
    s.querySelectorAll<SVGElement>("[data-j]").forEach((b) =>
      go(b, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 100 + Number(b.dataset.i) * 90 + Number(b.dataset.j) * 22 }))
    s.querySelectorAll(".lead").forEach((l, i) => go(l, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 650, delay: 1250 + i * 70, easing: ease }))
    s.querySelectorAll(".blocks").forEach((g, i) => go(g, [{ opacity: 1 }, { opacity: 0.4 }], { duration: 700, delay: 1750 + i * 60, easing: ease }))
    if (matchMedia("(min-width: 861px)").matches) {
      // a red dot where the runs meet, held a beat, then opened out into the card, its red fading to paper
      const dot = "inset(calc(50% - 7px) calc(100% - 14px) calc(50% - 7px) 0 round 7px)"
      go(c, [
        { clipPath: "inset(50% 100% 50% 0 round 0px)" },
        { clipPath: "inset(calc(50% - 10px) calc(100% - 20px) calc(50% - 10px) 0 round 10px)", offset: 0.22, easing: ease },
        { clipPath: dot, offset: 0.36 },
        { clipPath: dot, offset: 0.48, easing: ease },
        { clipPath: "inset(0 0 0 0 round 0px)" }
      ], { duration: 1250, delay: 1850 })
      go(c.querySelector(".wf-dot")!, [{ opacity: 1 }, { opacity: 0 }], { duration: 500, delay: 2450, easing: ease })
    } else {
      go(s.querySelector(".pt")!, [{ transform: "scale(0)" }, { transform: "scale(1.6)", offset: 0.6 }, { transform: "scale(1)" }], { duration: 700, delay: 1850, easing: ease })
      go(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 520, delay: 2350, easing: ease })
    }
    c.querySelectorAll(".wf-h, h4, li, .wf-f").forEach((el, i) => go(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 2750 + i * 90 }))
    const fill = setTimeout(() => setFilled(true), 3500)
    return () => { clearTimeout(fill); all.forEach((a) => a.cancel()) }
  }, [round])

  // the blank and its value share one box, as wide as the longer, so filling it moves nothing
  const pill = (k: keyof typeof FILL) => (
    <span className={filled ? "pill swap f" : "pill swap"}>
      <span aria-hidden={filled}>{k}</span>
      <span aria-hidden={!filled}>{FILL[k]}</span>
    </span>
  )

  return (
    <figure className="fig-collapse" aria-labelledby="f1t">
      <div className="fig-head">
        <h3 id="f1t"><span className="label">Figure 1</span>{turns} turns, one way through</h3>
        {!reduced && <button className="replay" type="button" onClick={() => setRound((n) => n + 1)}>↻ Replay</button>}
      </div>
      <div className="collapse">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {runs.map((r, i) => {
            const y = TOP + i * ROW, end = X0 + r.turns * STEP + 4
            return (
              <g key={i}>
                <text className="lbl" x={0} y={y + 11}>run {i + 1} · {r.turns} turns</text>
                <g className="blocks">
                  {r.cells.map(([kind, failed], j) => {
                    const x = X0 + j * STEP
                    return (
                      <g key={j} data-i={i} data-j={j}>
                        <rect className={`t${KIND[kind]}`} x={x} y={y} width={9} height={14} rx={1} />
                        {failed ? <path className={kind === "r" || kind === "o" ? "fx" : "fx light"} d={`M${x + 1.5} ${y + 4}l6 6m0 -6l-6 6`} /> : null}
                      </g>
                    )
                  })}
                </g>
                <path className="lead" pathLength={1} strokeDasharray={1} d={`M${end} ${y + 7}C${end + 120} ${y + 7} ${FX - 90} ${FY} ${FX} ${FY}`} />
              </g>
            )
          })}
          <circle className="pt" cx={FX - 7} cy={FY} r={7} style={{ transformOrigin: `${FX - 7}px ${FY}px` }} />
        </svg>
        <div className="wf" ref={card}>
          <span className="wf-dot" aria-hidden="true" />
          <div className="wf-h"><i />Workflow · in memory</div>
          <h4>{workflow.name}</h4>
          <ol>
            <li>Add {pill("field")} to AppState</li>
            <li>Default it to {pill("default")}</li>
            <li>Store it as the task says</li>
            <li>Regenerate the test snapshots</li>
          </ol>
          <div className="wf-f">picked when a task says “new setting”</div>
        </div>
      </div>
      <figcaption>Four real runs of one <a href="https://github.com/excalidraw/excalidraw">excalidraw</a> task without memory: {turns} turns between them, most spent reading and searching. Memory keeps the way through as workflows like this one, and hands it to the next run filled in from its task.</figcaption>
    </figure>
  )
}
