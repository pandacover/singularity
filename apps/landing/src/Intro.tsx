import { type RefObject, useEffect, useRef } from "react"
import { RUNS } from "./data/runs.ts"
import { reduced, sleep } from "./lib.ts"

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!)

// real moments from Figure 1's runs: what a turn did, and the errors
const pickTraces = () => {
  const TOOL: Record<string, string> = { read: "Read", searched: "Grep", edited: "Edit" }
  const calls = new Set<string>(), errs = new Set<string>()
  for (const r of RUNS) for (const c of r.cells) {
    const em = c[3] && /(Found 2 matches of the string|String to replace not found|No changes to make|Expected a single value|Search failed)[^.:]*/.exec(c[3])
    if (em) errs.add(em[0].replace(/\s+/g, " ").slice(0, 40))
    for (const part of c[2].split("; ")) {
      const m = /^(read|searched|edited) (.*)$/i.exec(part)
      if (m) for (const f of m[2]!.replace(/ and \d+ more$/, "").split(", ")) calls.add(TOOL[m[1]!.toLowerCase()] + "|" + f)
      else if (/ran tests/i.test(part)) calls.add("Bash|yarn test")
    }
  }
  const shuffle = <A,>(xs: ReadonlyArray<A>) => xs.map((x) => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1])
  return [...shuffle([...calls]).slice(0, 40).map((c) => ({ c })), ...shuffle([...errs]).slice(0, 7).map((e) => ({ e }))] as Array<{ c?: string; e?: string }>
}

type Ease = (x: number) => number
const ease = {
  out: (x: number) => 1 - (1 - x) ** 3,
  inOut: (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  back: (x: number) => 1 + 1.9 * (x - 1) ** 3 + 0.9 * (x - 1) ** 2,
  soft: (x: number) => 1 - (1 - x) ** 2
}
const smooth = (x: number, lo: number, hi: number) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t) }
const lerp = (p: number, q: number, t: number) => p + (q - p) * t

// the scene: light pulled into a core, crushed, then a quasar: a tilted disk with jets out of its poles.
// Lengths of the quasar are in the logo's units (its disc is 100 across); u is pixels per unit.
const COLS = ["255,244,230", "236,222,200", "236,96,52"]

type Num = "R" | "base" | "boost" | "flash" | "shake" | "spread" | "tilt" | "rot" | "shadow" | "jet" | "jetLen" | "u" | "cx" | "cy" | "iris" | "irisOpen" | "dk" | "last" | "dt"
interface Mover { el: HTMLElement; x: number; y: number; r0: number; a0: number; rn: number; start: number; dur: number; base: string; done?: boolean }
interface Part { r0: number; a0: number; a: number; start: number; dur: number; rn: number; rd: number; w: number; c: number }
interface Jet { s: number; v: number; side: number; ph: number }
interface Ring { t0: number; r: number; to: number; dur: number; alpha: number }
interface Tween { to: number; dur: number; e: Ease; t0: number; from: number | null }
type Scene = Record<Num, number> & { movers: Array<Mover>; parts: Array<Part>; jets: Array<Jet>; rings: Array<Ring>; tweens: Partial<Record<Num, Tween>> }

const freshScene = (): Scene => ({
  movers: [], parts: [], jets: [], rings: [], tweens: {}, R: 80, base: 0, boost: 0, flash: 0, shake: 0,
  spread: 0, tilt: 0, rot: 0, shadow: 0, jet: 0, jetLen: 150, u: 4.2, cx: 0, cy: 0, iris: 0, irisOpen: 0, dk: 0, last: 0, dt: 16
})

/** "What if your agents could remember everything?": light pulled into a black hole that becomes the logo. */
export const Intro = ({ replay }: { readonly replay: RefObject<(() => void) | null> }) => {
  const introRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const darkRef = useRef<HTMLDivElement>(null)
  const cvRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const aRef = useRef<HTMLSpanElement>(null)
  const bRef = useRef<HTMLSpanElement>(null)
  const wordRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = document.documentElement
    const intro = introRef.current!, stage = stageRef.current!, scene = sceneRef.current!, dark = darkRef.current!
    const text = textRef.current!, a = aRef.current!, b = bRef.current!, word = wordRef.current!, cv = cvRef.current!, g = cv.getContext("2d")!
    const traces = pickTraces()
    let skipped = false, disposed = false, raf = 0, dpr = 1, W = 0, H = 0
    const S = freshScene()
    const anim = (el: Element, frames: Array<Keyframe>, opts: KeyframeAnimationOptions) => el.animate(frames, { fill: "forwards", ...opts }).finished.catch(() => {})
    const clearScene = () => Object.assign(S, freshScene())
    const tween = (key: Num, to: number, dur: number, e: Ease = ease.inOut, delay = 0) => { S.tweens[key] = { to, dur, e, t0: performance.now() + delay, from: null } }
    const size = () => {
      dpr = devicePixelRatio || 1; W = innerWidth; H = innerHeight
      cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"
    }
    // a point on the disk, r pixels out at angle an, seen with the disk's tilt and turn
    const project = (r: number, an: number): [number, number] => {
      const X = r * Math.cos(an), Y = r * Math.sin(an) * Math.cos(S.tilt), c = Math.cos(S.rot), sn = Math.sin(S.rot)
      return [S.cx + X * c - Y * sn, S.cy + X * sn + Y * c]
    }
    const pull = (p: { r0: number; rn: number; a0: number }, q: number, R: number): [number, number] => { const e = q ** 2.2; return [p.r0 * (1 - e) + p.rn * R * e, p.a0 + 5.4 * q ** 1.7] }
    // streaks are drawn in buckets of colour and brightness, a few strokes a frame
    const buckets = () => Array.from({ length: COLS.length * 4 }, () => new Path2D())
    const put = (P: Array<Path2D>, c: number, alpha: number, at: (j: number) => [number, number], n: number) => {
      if (alpha <= 0.03) return
      const path = P[c * 4 + Math.min(3, Math.floor(alpha * 4))]!
      let [x, y] = at(0); path.moveTo(x, y)
      for (let j = 1; j < n; j++) { [x, y] = at(j); path.lineTo(x, y) }
    }
    const flush = (P: Array<Path2D>, alpha: number, lw: number) => P.forEach((path, i) => { g.strokeStyle = "rgba(" + COLS[i >> 2] + "," + (((i & 3) + 0.7) / 4) * alpha + ")"; g.lineWidth = lw; g.stroke(path) })
    const ink = (k: number) => "rgb(" + Math.round(lerp(12, 26, k)) + "," + Math.round(lerp(11, 24, k)) + "," + Math.round(lerp(10, 21, k)) + ")"
    const jetGlow = (side: number, k: number) => {
      const len = S.jetLen * S.u * Math.sin(S.tilt)
      if (S.jet < 0.01 || len < 1) return
      g.save(); g.translate(S.cx, S.cy); g.rotate(S.rot)
      // nested wedges, wide and faint to narrow and bright, so the beam has a soft edge
      for (const [w, al] of [[3.2, 0.1], [2, 0.16], [1.1, 0.24], [0.45, 0.5]] as const) {
        const gr = g.createLinearGradient(0, 0, 0, -side * len)
        gr.addColorStop(0, "rgba(255,246,236," + k * al * S.jet + ")"); gr.addColorStop(0.35, "rgba(255,246,236," + k * al * S.jet * 0.5 + ")"); gr.addColorStop(1, "rgba(255,246,236,0)")
        g.fillStyle = gr; g.beginPath(); g.moveTo(-w * S.u, 0); g.lineTo(0, -side * len); g.lineTo(w * S.u, 0); g.closePath(); g.fill()
      }
      g.restore()
    }

    // the jets' strands, streaming out of the poles
    const jetStreams = () => {
      if (S.jet <= 0.01) return
      for (let i = 0; i < 7; i++) S.jets.push({ s: Math.random() * 2, v: 50 + Math.random() * 60, side: i % 2 ? 1 : -1, ph: Math.random() * 7 })
      const P = buckets(), len = S.jetLen, c = Math.cos(S.rot), sn = Math.sin(S.rot), st = Math.sin(S.tilt), u = S.u
      S.jets = S.jets.filter((p) => {
        p.s += (p.v * S.dt) / 1000
        if (p.s > len) return false
        put(P, 0, S.jet * (1 - p.s / len) * (p.side > 0 ? 0.8 : 0.5), (j) => {
          const sj = Math.max(0, p.s - j * 1.6), lat = (0.3 + sj * 0.025) * Math.sin(p.ph + sj * 0.2), ax = -p.side * (sj + 3) * st
          return [S.cx + (lat * c - ax * sn) * u, S.cy + (lat * sn + ax * c) * u]
        }, 5)
        return true
      })
      flush(P, 0.55, Math.max(0.3, Math.min(0.9, u / 4.2)))
    }
    const frame = (now: number) => {
      const dt = S.last ? Math.min(50, now - S.last) : 16; S.last = now; S.dt = dt
      for (const [k, tw] of Object.entries(S.tweens) as Array<[Num, Tween]>) {
        if (now < tw.t0) continue
        if (tw.from === null) tw.from = S[k]
        const x = Math.min(1, (now - tw.t0) / tw.dur)
        S[k] = tw.from + (tw.to - tw.from) * tw.e(x)
        if (x === 1) delete S.tweens[k]
      }
      S.boost *= Math.exp(-dt / 380); S.flash *= Math.exp(-dt / 220); S.shake *= Math.exp(-dt / 170)
      stage.style.transform = S.shake > 0.3 ? "translate(" + (Math.random() - 0.5) * S.shake + "px, " + (Math.random() - 0.5) * S.shake + "px)" : ""
      if (S.irisOpen || S.iris) { S.iris = Math.max(50 * S.u, S.irisOpen); scene.style.clipPath = "circle(" + S.iris + "px at " + S.cx + "px " + S.cy + "px)" }
      if (S.dk) dark.style.background = ink(S.dk)
      const R = S.R * (1 + 0.03 * Math.sin(now / 150)), u = S.u, lw = Math.max(0.3, Math.min(1, u / 4.2))
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      g.globalCompositeOperation = "lighter"; g.lineCap = "round"

      // the traces themselves, moving off along the paths their light will take
      for (const m of S.movers) {
        const q = (now - m.start) / m.dur
        if (q <= 0 || m.done) continue
        if (q >= 0.5) { m.el.style.opacity = "0"; m.done = true; continue }
        const [r, an] = pull(m, q, R), [px, py] = project(r, an)
        m.el.style.transform = m.base + "translate(" + (px - S.cx - m.x) + "px, " + (py - S.cy - m.y) + "px) rotate(" + (an - m.a0) * 34 + "deg) scale(" + (1 - 0.7 * q) + ")"
        m.el.style.opacity = String(1 - smooth(q, 0.03, 0.36))
      }
      jetGlow(-1, 0.55)
      jetGlow(1, 1)
      jetStreams()
      // the light: pulled in, whirling in the core, then spread into the disk
      if (S.parts.length) {
        const P = buckets()
        let home = 0
        for (const p of S.parts) {
          const q = (now - p.start) / p.dur
          if (q <= 0) continue
          if (q < 1) {
            p.a = p.a0 + 5.4 * q ** 1.7
            put(P, p.c, smooth(q, 0.02, 0.3), (j) => { const [r, an] = pull(p, Math.max(0, q - j * 0.016), R); return project(r, an) }, 9)
            continue
          }
          home++
          const r = lerp(p.rn * R, p.rd * u, S.spread)
          const spin = Math.min(9, lerp(p.w * Math.sqrt(80 / Math.max(R, 5)), p.w * 1.5 * (30 / p.rd) ** 1.5, S.spread))
          p.a += dt * 0.001 * spin
          put(P, S.spread > 0.4 ? (p.rd < 22 ? 0 : 1) : p.c, p.rd < 22 ? 1 : lerp(1, 0.32 * (1 - 0.75 * smooth(p.rd, 31, 42)), S.spread), (j) => project(r, p.a - j * spin * 0.014), 9)
        }
        S.base = 0.6 * (home / S.parts.length)
        flush(P, 0.75, 1.2 * lw)
      }
      // the disk's body: hot inside, dimmer out to its edge
      if (S.spread > 0.01) {
        g.save(); g.translate(S.cx, S.cy); g.rotate(S.rot); g.scale(1, Math.max(0.01, Math.cos(S.tilt)))
        const rr = 41 * u, gr = g.createRadialGradient(0, 0, 0, 0, 0, rr), k = S.spread * lerp(0.3, 1, smooth(S.tilt, 0.2, 1.3))
        gr.addColorStop(0, "rgba(255,246,236," + k + ")"); gr.addColorStop(0.5, "rgba(255,240,222," + 0.8 * k + ")")
        gr.addColorStop(0.56, "rgba(236,222,200," + 0.34 * k + ")"); gr.addColorStop(0.9, "rgba(236,222,200," + 0.24 * k + ")"); gr.addColorStop(1, "rgba(236,222,200,0)")
        g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rr, 0, 7); g.fill(); g.restore()
      }
      const lum = (S.base + S.boost) * (1 - 0.85 * S.spread)
      if (lum > 0.01) {
        const rr = R * 1.9 + 40, gr = g.createRadialGradient(S.cx, S.cy, 0, S.cx, S.cy, rr)
        gr.addColorStop(0, "rgba(255,246,234," + Math.min(1, lum) + ")"); gr.addColorStop(0.18, "rgba(255,172,112," + Math.min(1, lum * 0.5) + ")")
        gr.addColorStop(0.5, "rgba(211,60,29," + lum * 0.14 + ")"); gr.addColorStop(1, "rgba(211,60,29,0)")
        g.fillStyle = gr; g.fillRect(S.cx - rr, S.cy - rr, rr * 2, rr * 2)
      }
      // the black hole, sitting on the disk
      if (S.shadow > 0.01) {
        g.globalCompositeOperation = "source-over"
        g.save(); g.translate(S.cx, S.cy); g.rotate(S.rot)
        g.fillStyle = ink(S.dk); g.beginPath(); g.ellipse(0, -1.2 * u, 5 * u * S.shadow, 4.4 * u * S.shadow, 0, 0, 7); g.fill()
        g.restore()
        g.globalCompositeOperation = "lighter"
      }
      S.rings = S.rings.filter((r) => {
        const k = (now - r.t0) / r.dur; if (k >= 1) return false
        g.strokeStyle = "rgba(255,196,156," + (1 - k) * r.alpha + ")"; g.lineWidth = 2.4 * (1 - k) + 0.3
        g.beginPath(); g.arc(S.cx, S.cy, r.r + ease.out(k) * r.to, 0, 7); g.stroke()
        return true
      })
      if (S.flash > 0.01) { g.fillStyle = "rgba(255,240,226," + S.flash + ")"; g.fillRect(0, 0, W, H) }
    }
    const loop = (now: number) => { frame(now); raf = requestAnimationFrame(loop) }

    // back to the first frame: no animations, no leftover styles, no traces, an empty scene
    const reset = () => {
      cancelAnimationFrame(raf)
      for (const el of [intro, dark, stage, a, b, text, word]) el.getAnimations().forEach((x) => x.cancel())
      for (const el of [text, stage, word, scene, dark, intro]) el.removeAttribute("style")
      intro.querySelectorAll(".i-trace").forEach((t) => t.remove())
      clearScene()
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height)
    }
    const done = () => {
      try { sessionStorage.setItem("sg-intro", "1") } catch {}
      root.classList.remove("intro")
      reset()
      // let the figures that were waiting on the intro start
      dispatchEvent(new Event("introdone"))
    }
    const finish = async () => {
      if (!root.classList.contains("intro")) return
      try { sessionStorage.setItem("sg-intro", "1") } catch {}
      void anim(word, [{ opacity: getComputedStyle(word).opacity }, { opacity: 0 }], { duration: 400, easing: "ease" })
      await anim(intro, [{ opacity: 1 }, { opacity: 0 }], { duration: 650, easing: "ease" })
      if (!disposed) done()
    }
    const skip = () => { if (skipped) return; skipped = true; void finish() }
    const stop = () => skipped || disposed

    const play = async () => {
      skipped = false
      root.classList.add("intro")
      reset()
      b.innerHTML = "your agents could remember everything?".split(" ").map((w) => "<span>&nbsp;" + esc(w) + "</span>").join("")
      const words = [...b.children]
      b.style.opacity = "1"
      await sleep(500); if (stop()) return
      await anim(a, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)" })
      await sleep(1100); if (stop()) return // the dramatic gap
      for (const w of words) {
        if (stop()) return
        void anim(w, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 500, easing: "cubic-bezier(.2,.8,.2,1)" })
        await sleep(120)
      }
      await sleep(1500); if (stop()) return // the silence
      // traces pop up everywhere, avoiding the sentence
      const vw = innerWidth, vh = innerHeight, box = text.getBoundingClientRect(), els: Array<HTMLElement> = []
      const cols = Math.max(2, Math.floor(vw / 250)), rows = Math.max(4, Math.floor(vh / 52))
      const cells: Array<[number, number]> = []
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = c * (vw / cols) + Math.random() * Math.max(0, vw / cols - 210), y = r * (vh / rows) + 8 + Math.random() * Math.max(0, vh / rows - 40)
        if (x + 230 > box.left - 16 && x < box.right + 16 && y + 34 > box.top - 18 && y < box.bottom + 18) continue
        cells.push([Math.max(8, x), Math.max(8, y)])
      }
      cells.sort(() => Math.random() - 0.5)
      traces.slice(0, cells.length).forEach((t, k) => {
        const el = document.createElement("div")
        el.className = "i-trace" + (t.e ? " err" : "")
        if (t.e) el.innerHTML = "<span class=\"d\">✗</span>" + esc(t.e)
        else { const [tool, arg] = t.c!.split("|"); el.innerHTML = "<span class=\"d\">●</span><b>" + tool + "</b>(" + esc(arg!) + ")" }
        el.style.left = cells[k]![0] + "px"; el.style.top = cells[k]![1] + "px"
        stage.appendChild(el); els.push(el)
      })
      els.sort(() => Math.random() - 0.5)
      for (const el of els) {
        if (stop()) return
        void anim(el, [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1.06)", offset: 0.7 }, { opacity: 1, transform: "scale(1)" }], { duration: 380, easing: "ease-out" })
        await sleep(30)
      }
      await sleep(500); if (stop()) return

      // the lights go down as everything starts to turn; each trace sheds its light along the path it takes
      size()
      Object.assign(S, { cx: W / 2, cy: H / 2, u: Math.min(4.6, Math.min(W, H) / 175) })
      void anim(dark, [{ opacity: 0 }, { opacity: 1 }], { duration: 2000, easing: "ease-in-out" })
      void anim(a, [{ color: "#1a1815" }, { color: "#efe9dd" }], { duration: 2000, easing: "ease-in-out" })
      raf = requestAnimationFrame(loop)
      const t0 = performance.now() + 300, maxR = Math.hypot(S.cx, S.cy)
      let end = 0
      for (const el of [...els, text]) {
        const isText = el === text, r = el.getBoundingClientRect()
        el.getAnimations().forEach((x) => x.cancel()); el.style.opacity = "1"
        const x = r.left + r.width / 2 - S.cx, y = r.top + r.height / 2 - S.cy, r0 = Math.hypot(x, y)
        const start = t0 + (isText ? 1100 : Math.random() * 1100), dur = 1800 + (r0 / maxR) * 1100
        S.movers.push({ el, x, y, r0, a0: Math.atan2(y, x), rn: 0.5, start, dur, base: isText ? "translate(-50%, -50%) " : "" })
        const n = isText ? 160 : el.classList.contains("err") ? 30 : 24
        for (let i = 0; i < n; i++) {
          const px = r.left + Math.random() * r.width - S.cx, py = r.top + Math.random() * r.height - S.cy, rn = 0.06 + 0.94 * Math.sqrt(Math.random())
          const p: Part = {
            r0: Math.hypot(px, py), a0: Math.atan2(py, px), a: 0, start: start + Math.random() * 160, dur: dur * (0.94 + Math.random() * 0.12), rn, rd: 6 + 34 * rn ** 1.15 + Math.random() * 3, w: 2 + Math.random() * 1.4,
            c: el.classList.contains("err") ? 2 : Math.random() < 0.5 ? 0 : Math.random() < 0.6 ? 1 : 2
          }
          S.parts.push(p); end = Math.max(end, p.start + p.dur)
        }
      }
      await sleep(end - performance.now() + 400); if (stop()) return

      // three beats, each crushing the core smaller
      for (const [k, to] of [44, 21, 8].entries()) {
        await sleep(k ? 760 : 200); if (stop()) return
        tween("R", S.R * 1.14, 280, ease.soft) // it draws breath
        await sleep(280); if (stop()) return
        tween("R", to, 360, ease.back)
        await sleep(150)
        S.boost += 0.8 + k * 0.35; S.shake = 7 + k * 5
        S.rings.push({ t0: performance.now(), r: to, to: 240 + k * 140, dur: 1200, alpha: 0.45 + k * 0.1 })
        await sleep(210)
      }
      await sleep(700); if (stop()) return

      // it ignites: the core flattens into a disk as it tips over, and jets fire out of its poles
      S.boost += 1.4; S.flash = 0.3; S.shake = 12
      S.rings.push({ t0: performance.now(), r: 8, to: Math.max(W, H) * 0.6, dur: 1500, alpha: 0.6 })
      const u0 = S.u
      S.u = u0 * 1.12
      tween("u", u0, 5200, ease.out)
      tween("spread", 1, 2400, ease.out)
      tween("tilt", 1.4, 2600, ease.inOut)
      tween("rot", (27 * Math.PI) / 180, 2600, ease.inOut)
      tween("shadow", 1, 1600, ease.out, 300)
      tween("jet", 1, 900, ease.out, 900)
      await sleep(2300); if (stop()) return
      await anim(word, [{ opacity: 0, letterSpacing: "0.7em" }, { opacity: 1, letterSpacing: "0.34em" }], { duration: 1800, easing: "cubic-bezier(.2,.7,.2,1)" })
      await sleep(700); if (stop()) return

      // the dark closes in around it like an iris, and carries it into the masthead as the logo
      const lg = document.querySelector(".wordmark .logo")!.getBoundingClientRect(), nm = document.querySelector(".wordmark .wm-name")!.getBoundingClientRect()
      intro.style.background = "transparent"
      S.irisOpen = Math.hypot(W, H) / 2 + 20
      tween("irisOpen", 0, 1200, (x) => x * x)
      tween("dk", 1, 1600, ease.inOut)
      tween("u", lg.width / 100, 1300, ease.inOut, 650)
      tween("cx", lg.left + lg.width / 2, 1300, ease.inOut, 650)
      tween("cy", lg.top + lg.height / 2, 1300, ease.inOut, 650)
      tween("jetLen", 60, 1300, ease.inOut, 650)
      // and the title goes to the wordmark beside it
      const wr = word.getBoundingClientRect(), fs = parseFloat(getComputedStyle(word).fontSize)
      Object.assign(word.style, { left: wr.left + "px", top: wr.top + "px", transform: "none", letterSpacing: 0.34 * fs + "px" })
      word.getAnimations().forEach((x) => x.cancel()); word.style.opacity = "1"
      await sleep(650); if (stop()) return
      await anim(word, [
        { left: wr.left + "px", top: wr.top + "px", fontSize: fs + "px", letterSpacing: 0.34 * fs + "px" },
        { left: nm.left + "px", top: nm.top + (nm.height - 13) / 2 + "px", fontSize: "13px", letterSpacing: "0px" }
      ], { duration: 1300, easing: "cubic-bezier(.65,0,.35,1)" })
      if (stop()) return
      done()
    }

    const onKey = (e: KeyboardEvent) => { if (root.classList.contains("intro") && (e.key === "Escape" || e.key === " " || e.key === "Enter")) skip() }
    const onWheel = () => { if (root.classList.contains("intro")) skip() }
    const onResize = () => { if (root.classList.contains("intro") && S.last) size() }
    const skipButton = intro.querySelector(".i-skip")!
    skipButton.addEventListener("click", skip)
    addEventListener("keydown", onKey)
    addEventListener("wheel", onWheel, { passive: true })
    addEventListener("resize", onResize)
    replay.current = () => { if (reduced) return; scrollTo(0, 0); void play() }
    if (root.classList.contains("intro")) void play()
    return () => {
      disposed = true
      skipButton.removeEventListener("click", skip)
      removeEventListener("keydown", onKey)
      removeEventListener("wheel", onWheel)
      removeEventListener("resize", onResize)
      replay.current = null
      reset()
    }
  }, [replay])

  return (
    <>
      <div id="intro" ref={introRef} aria-hidden="true">
        <div className="i-stage" ref={stageRef}>
          <div className="i-scene" ref={sceneRef}><div className="i-dark" ref={darkRef} /><canvas className="i-cv" ref={cvRef} /></div>
          <div className="i-text" ref={textRef}><span className="i-a" ref={aRef}>What if</span><span className="i-b" ref={bRef} /></div>
        </div>
        <button className="i-skip" type="button">Skip intro</button>
      </div>
      {/* outside the intro, so it inverts against the page as well: light on the dark, ink on paper */}
      <div className="i-word" ref={wordRef} aria-hidden="true">singularity</div>
    </>
  )
}
