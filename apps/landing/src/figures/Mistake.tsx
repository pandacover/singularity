import { type ReactNode, useEffect, useRef, useState } from "react"
import { reduced, sleep, useOnceVisible } from "../lib.ts"

// The moment from the bug-fix session, drawn as Claude Code shows tool calls. The error is the one
// Figure 2's runs got; the note is memory's pitfall, shortened; its count is the pitfall's "runs".
type Line =
  | { readonly id: number; readonly kind: "call"; readonly status: "" | "err" | "ok"; readonly cmd: string; readonly n: number; readonly typing: boolean }
  | { readonly id: number; readonly kind: "res"; readonly ok: boolean }
  | { readonly id: number; readonly kind: "slip" }

/** Fades and slides in once it's on the page. */
const Anim = ({ className, children }: { readonly className: string; readonly children: ReactNode }) => {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => setOn(true)) })
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div className={`${className} anim${on ? " on" : ""}`}>{children}</div>
}

/** The command and its closing parenthesis, laid out whole from the start, one character to a box:
 * typing only shows them and moves the cursor over them, so nothing on the line ever moves. */
const typed = ({ cmd, n, typing }: { readonly cmd: string; readonly n: number; readonly typing: boolean }) =>
  [...cmd, ")"].map((ch, i) => <span key={i} className={i < n ? undefined : typing && i === n ? "tm-cur" : "tm-ghost"}>{ch}</span>)

const render = (l: Line) => {
  switch (l.kind) {
    case "call":
      return (
        <Anim key={l.id} className={`tm-call ${l.status}`}>
          <span className="d">●</span><span className="fn">Bash</span>({typed(l)}
        </Anim>
      )
    case "res":
      return (
        <Anim key={l.id} className="tm-res">
          └ {l.ok ? <span className="g">✓ passed</span> : <span className="r">Error: Expected a single value for option "-w, --watch"</span>}
        </Anim>
      )
    case "slip":
      return (
        <Anim key={l.id} className="slip">
          <span className="d">●</span><span className="who">singularity</span><span className="meta">  seen in 4 earlier runs</span>
          <span className="body">└ The script already passes --watch, so this fails. Run plain <code>yarn test:update</code>.</span>
        </Anim>
      )
  }
}

/** Figure 3: a mistake, caught as it repeats. */
export const Mistake = () => {
  const [lines, setLines] = useState<ReadonlyArray<Line>>([])
  const run = useRef(0)
  const win = useRef<HTMLDivElement>(null)

  async function play() {
    const id = ++run.current
    let next = 0
    // a replay started meanwhile owns the lines; this one stops writing
    const add = (l: Line) => { if (id === run.current) setLines((ls) => [...ls, l]) }
    const call = (cmd: string, n = 0) => { const at = next++; add({ id: at, kind: "call", status: "", cmd, n, typing: n === 0 }); return at }
    const patch = (at: number, p: Partial<{ status: "" | "err" | "ok"; n: number; typing: boolean }>) => {
      if (id === run.current) setLines((ls) => ls.map((l) => (l.id === at && l.kind === "call" ? { ...l, ...p } : l)))
    }
    const type = async (at: number, text: string) => {
      for (let i = 1; i <= text.length; i++) {
        if (id !== run.current) return
        patch(at, { n: i })
        await sleep(36)
      }
      await sleep(220)
      patch(at, { n: text.length + 1, typing: false })
    }
    setLines([])
    if (reduced) {
      patch(call("yarn test:update --watch=false", 99), { status: "err" })
      add({ id: next++, kind: "res", ok: false })
      add({ id: next++, kind: "slip" })
      patch(call("yarn test:update", 99), { status: "ok" })
      add({ id: next++, kind: "res", ok: true })
      return
    }
    await sleep(300)
    const A = "yarn test:update --watch=false", a = call(A)
    await type(a, A); if (id !== run.current) return
    await sleep(500); patch(a, { status: "err" })
    add({ id: next++, kind: "res", ok: false })
    await sleep(900); if (id !== run.current) return
    add({ id: next++, kind: "slip" })
    await sleep(2200); if (id !== run.current) return
    const B = "yarn test:update", b = call(B)
    await type(b, B); if (id !== run.current) return
    await sleep(700); patch(b, { status: "ok" })
    add({ id: next++, kind: "res", ok: true })
  }

  useOnceVisible(win, play, 0.5)
  // a figure that unmounts stops typing
  useEffect(() => () => { run.current++ }, [])

  return (
    <figure className="fig-mistake" aria-labelledby="f3t">
      <div className="fig-head">
        <h3 id="f3t"><span className="label">Figure 3</span>A mistake, caught as it repeats</h3>
        <button className="replay" type="button" onClick={play}>↻ Replay</button>
      </div>
      <div className="win" ref={win}>
        <div className="tb"><div className="dots"><i /><i /><i /></div><div className="ttl">claude — excalidraw</div><div /></div>
        <div className="bd" aria-live="polite">{lines.map(render)}</div>
      </div>
      <figcaption style={{ marginLeft: "auto", marginRight: "auto", maxWidth: 860 }}>From a bug-fix session on excalidraw. Earlier runs had made this mistake four times; this time the fix arrived with the error.</figcaption>
    </figure>
  )
}
