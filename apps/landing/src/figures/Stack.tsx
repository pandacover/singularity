import { type ReactNode, useRef, useState } from "react"
import { reduced, useOnceVisible } from "../lib.ts"

// top to bottom
const LAYERS = [
  { name: "Your agent", note: ["Gets steps, places and warnings.", "Still writes every line itself."], side: "r" },
  { name: "Hooks", note: ["Never break a session.", "Errors go to a log; ~0.1–0.4 s a call."], side: "l" },
  { name: "Memory", note: ["Keeps where to look,", "never the code itself."], side: "r" },
  { name: "Your sessions", note: ["Learning is opt-in,", "at most $1 a day."], side: "l" },
  { name: "Your machine", note: ["Picking runs here,", "with no model call."], side: "r", base: true }
] as const

const CX = 550, W = 200, H = 108, GAP = 64, TOP = 120, T = 26
const cyOf = (i: number) => TOP + i * GAP
const P = (cy: number, u: number, v: number) => [CX + (u - v) * W, cy - H + (u + v) * H] as const
const quad = (cy: number, u0: number, v0: number, u1: number, v1: number) => {
  const a = P(cy, u0, v0), b = P(cy, u1, v0), c = P(cy, u1, v1), d = P(cy, u0, v1)
  return `M${a} L${b} L${c} L${d} Z`
}

const MOTIF: Record<string, (cy: number) => ReactNode> = {
  "Your agent": (cy) => <>
    <path d={quad(cy, 0.36, 0.36, 0.64, 0.64)} fill="#1a1815" />
    <path d={quad(cy, 0.43, 0.43, 0.57, 0.57)} fill="none" stroke="#f2eee5" strokeWidth="1" />
    <ellipse cx={CX} cy={cy} rx="5" ry="3" fill="#d33c1d" />
  </>,
  "Hooks": (cy) => {
    const a = P(cy, 0.5, 0.28), b = P(cy, 0.5, 0.72), c = P(cy, 0.28, 0.5), d = P(cy, 0.72, 0.5)
    return <>
      <path d={`M${a} L${b} M${c} L${d}`} stroke="#d33c1d" strokeWidth="1.2" strokeDasharray="3 3" />
      {[a, b, c, d].map((p, k) => <ellipse key={k} cx={p[0]} cy={p[1]} rx="6" ry="3.5" fill="#f8f5ee" stroke="#d33c1d" strokeWidth="1.4" />)}
    </>
  },
  "Memory": (cy) => {
    const g: Array<ReactNode> = []
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const u = 0.3 + i * 0.1, v = 0.3 + j * 0.1
      g.push(<path key={`${i}${j}`} d={quad(cy, u, v, u + 0.075, v + 0.075)} fill={i === 2 && j === 1 ? "#d33c1d" : (i + j) % 3 === 0 ? "#1a1815" : "#cfc7b6"} />)
    }
    return g
  },
  "Your sessions": (cy) => [0.32, 0.44, 0.56].map((v, k) => <path key={k} d={quad(cy, 0.26, v, 0.74 - k * 0.1, v + 0.06)} fill={k === 0 ? "#8f877a" : "#cfc7b6"} />)
}

const rhomb = (cy: number) => `M${CX},${cy - H} L${CX + W},${cy} L${CX},${cy + H} L${CX - W},${cy} Z`

// faint lines across a face, parallel to its edges
const gridLines = (cy: number, n: number) => {
  let d = ""
  for (let k = 1; k < n; k++) {
    const f = k / n
    d += `M${CX - W + W * f},${cy - H * f} L${CX + W * f},${cy + H - H * f} `
    d += `M${CX + W - W * f},${cy - H * f} L${CX - W * f},${cy + H - H * f} `
  }
  return d
}

/** Rules it keeps: an isometric stack, from your machine up to your agent. */
export const Stack = () => {
  const svg = useRef<SVGSVGElement>(null)
  const [hidden, setHidden] = useState(!reduced)
  const [hot, setHot] = useState<number | null>(null)
  useOnceVisible(svg, () => setHidden(false), 0.3)

  // hover a layer or its label to light both
  const layerOf = (e: { target: EventTarget }) => (e.target as Element).closest("[data-i]")?.getAttribute("data-i")
  const hotClass = (i: number) => (hot === i ? " hot" : "")
  const last = LAYERS.length - 1

  return (
    <>
      <svg
        id="stack"
        ref={svg}
        className={hidden ? "hide" : undefined}
        viewBox="0 0 1100 540"
        role="img"
        aria-label="singularity as a stack of five layers, each with the rule it keeps"
        onPointerOver={(e) => { const i = layerOf(e); if (i != null) setHot(+i) }}
        onPointerOut={(e) => { const i = layerOf(e); if (i != null) setHot((h) => (h === +i ? null : h)) }}
      >
        <defs>
          <linearGradient id="gL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d84a2b" /><stop offset="1" stopColor="#a92c13" /></linearGradient>
          <linearGradient id="gR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b8341a" /><stop offset="1" stopColor="#7e200e" /></linearGradient>
          <radialGradient id="gGlow"><stop offset="0" stopColor="#d33c1d" stopOpacity="0.35" /><stop offset="1" stopColor="#d33c1d" stopOpacity="0" /></radialGradient>
        </defs>
        {/* drawn bottom up, so higher layers sit over lower ones */}
        {LAYERS.map((L, i) => ({ L, i })).reverse().map(({ L, i }) => {
          const cy = cyOf(i)
          return (
            <g key={L.name} className={`lay${hotClass(i)}`} data-i={i} style={{ transitionDelay: `${(last - i) * 140}ms` }}>
              {"base" in L ? <>
                <path fill="url(#gL)" d={`M${CX - W},${cy} L${CX},${cy + H} L${CX},${cy + H + T} L${CX - W},${cy + T} Z`} />
                <path fill="url(#gR)" d={`M${CX + W},${cy} L${CX},${cy + H} L${CX},${cy + H + T} L${CX + W},${cy + T} Z`} />
                <path d={rhomb(cy)} fill="#f8f5ee" stroke="#d33c1d" strokeWidth="1.2" />
                <path className="grid" d={gridLines(cy, 8)} style={{ opacity: 0.1 }} />
                <ellipse cx={CX} cy={cy} rx={W * 0.55} ry={H * 0.55} fill="url(#gGlow)" />
                <ellipse cx={CX} cy={cy} rx="46" ry="25" fill="none" stroke="#d33c1d" strokeWidth="1" strokeDasharray="3 4" />
                <ellipse cx={CX} cy={cy} rx="11" ry="6" fill="#d33c1d" />
              </> : <>
                <path className="face" d={rhomb(cy)} />
                <path className="grid" d={gridLines(cy, 4)} />
                {MOTIF[L.name] && <g className="motif">{MOTIF[L.name]!(cy)}</g>}
              </>}
            </g>
          )
        })}
        {LAYERS.map((L, i) => {
          const cy = cyOf(i), right = L.side === "r"
          const vx = right ? CX + W : CX - W
          const text = L.name.toUpperCase(), pw = text.length * 7.6 + 40
          const px = right ? 820 : 280 - pw
          const lx1 = right ? vx + 8 : vx - 8, lx2 = right ? px - 6 : px + pw + 6
          return (
            <g key={L.name} className={`lbl${hotClass(i)}`} data-i={i} style={{ transitionDelay: `${900 + (last - i) * 140}ms` }}>
              <path className="lead" d={`M${lx1},${cy} L${lx2},${cy}`} />
              <circle cx={vx} cy={cy} r="2.5" fill={"base" in L ? "#d33c1d" : "#4b463e"} />
              <rect className="pillbg" x={px} y={cy - 14} width={pw} height="28" rx="14" />
              <circle className="pd" cx={px + 16} cy={cy} r="3.5" />
              <text className="pt" x={px + 28} y={cy + 4}>{text}</text>
              {L.note.map((ln, k) => <text key={k} className="note" x={right ? px + 4 : px + pw - 4} y={cy + 38 + k * 19} textAnchor={right ? "start" : "end"}>{ln}</text>)}
            </g>
          )
        })}
      </svg>
      <ol className="stack-list">
        {LAYERS.map((L) => <li key={L.name}><b>{L.name}</b>{L.note.join(" ")}</li>)}
      </ol>
    </>
  )
}
