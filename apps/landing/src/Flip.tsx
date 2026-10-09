import { type ReactNode, useLayoutEffect, useRef, useState } from "react"

// Switching who the page is for: a grid draws itself over the window, then its boxes turn, in a ripple from the
// top left corner, to the other page in the other theme. The other page is drawn whole above this one and shown through
// the boxes turned so far (a clip path of them, redrawn each frame), so when the last box turns, it is simply there.
const BOX = 40, LINES_MS = 380, WAVE_MS = 560, BOX_MS = 280, FADE_MS = 260

const ease = (t: number) => 1 - (1 - t) ** 3

/** The transition, over the whole window; `page` is the page being switched to, drawn in `theme`. */
export const Flip = ({ theme, page, onSwap, onEnd }: {
  readonly theme: string
  readonly page: ReactNode
  readonly onSwap: () => void
  readonly onEnd: () => void
}) => {
  const [{ cols, rows, cell }] = useState(() => {
    const cols = Math.max(5, Math.round(innerWidth / BOX)), cell = innerWidth / cols
    return { cols, rows: Math.ceil(innerHeight / cell), cell }
  })
  const top = useRef<HTMLDivElement>(null)
  const grid = useRef<SVGSVGElement>(null)
  const swapped = useRef(false)

  useLayoutEffect(() => {
    const el = top.current!, svg = grid.current!
    // the lines, top to bottom and left to right, each drawn from its start
    const lines = [...svg.querySelectorAll("line")]
    const anims = lines.map((l, i) => l.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 300, delay: i * (LINES_MS - 300) / lines.length, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" }))
    // each box turns at a time set by its distance from the top left corner
    const far = Math.hypot(innerWidth, innerHeight)
    const boxes: Array<{ x: number; y: number; at: number }> = []
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cell, y = r * cell
      boxes.push({ x, y, at: LINES_MS * 0.7 + (Math.hypot(x + cell / 2, y + cell / 2) / far) * WAVE_MS })
    }
    const end = Math.max(...boxes.map((b) => b.at)) + BOX_MS
    const t0 = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const t = now - t0
      if (t < end) {
        let d = "M0 0"
        for (const b of boxes) {
          const p = Math.min(1, Math.max(0, (t - b.at) / BOX_MS))
          if (p === 0) continue
          const s = cell * ease(p), o = (cell - s) / 2
          d += `M${b.x + o} ${b.y + o}h${s}v${s}h${-s}z`
        }
        el.style.clipPath = `path("${d}")`
        raf = requestAnimationFrame(frame)
        return
      }
      if (!swapped.current) {
        // every box has turned: the page underneath becomes the new one, and the grid fades
        swapped.current = true
        el.style.clipPath = "none"
        onSwap()
        svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "forwards" }).finished.then(onEnd, onEnd)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); anims.forEach((a) => a.cancel()) }
  }, [])

  return (
    <div className="flip" aria-hidden="true">
      <div className="flip-page" ref={top} data-view={theme} style={{ clipPath: 'path("M0 0")' }}>{page}</div>
      <svg className="flip-grid" ref={grid} width="100%" height="100%">
        {Array.from({ length: rows - 1 }, (_, r) => <line key={`r${r}`} x1={0} x2={innerWidth} y1={(r + 1) * cell} y2={(r + 1) * cell} pathLength={1} strokeDasharray={1} />)}
        {Array.from({ length: cols - 1 }, (_, c) => <line key={`c${c}`} x1={(c + 1) * cell} x2={(c + 1) * cell} y1={0} y2={innerHeight} pathLength={1} strokeDasharray={1} />)}
      </svg>
    </div>
  )
}
