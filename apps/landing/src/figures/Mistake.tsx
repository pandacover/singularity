import { type ReactNode, useEffect, useRef, useState } from "react"
import { reduced, sleep, useOnceVisible } from "../lib.ts"

// The moment from the bug-fix session, drawn as Claude Code shows tool calls. The error is the one
// Figure 1's runs got; the note is memory's pitfall, shortened; its count is the pitfall's "runs".
type Line =
  | { readonly id: number; readonly kind: "call"; readonly status: "" | "err" | "ok"; readonly cmd: string; readonly typing: boolean }
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

const render = (l: Line) => {
  switch (l.kind) {
    case "call":
      return (
        <Anim key={l.id} className={`tm-call ${l.status}`}>
          <span className="d">●</span><span className="fn">Bash</span>(<span className="cmd">{l.cmd}{l.typing && <span className="tm-cur" />}</span>)
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
          <div className="who"><i />singularity<span>· seen in 4 earlier runs</span></div>
          The script already passes --watch, so this fails. Run plain <code>yarn test:update</code>.
        </Anim>
      )
  }
}

/** Figure 2: a mistake, caught as it repeats. */
export const Mistake = () => {
  const [lines, setLines] = useState<ReadonlyArray<Line>>([])
  const run = useRef(0)
  const win = useRef<HTMLDivElement>(null)

  async function play() {
    const id = ++run.current
    let next = 0
    const add = (l: Line) => setLines((ls) => [...ls, l])
    const call = (cmd = "") => { const at = next++; add({ id: at, kind: "call", status: "", cmd, typing: false }); return at }
    const patch = (at: number, p: Partial<{ status: "" | "err" | "ok"; cmd: string; typing: boolean }>) =>
      setLines((ls) => ls.map((l) => (l.id === at && l.kind === "call" ? { ...l, ...p } : l)))
    const type = async (at: number, text: string) => {
      for (let i = 1; i <= text.length; i++) {
        if (id !== run.current) return
        patch(at, { cmd: text.slice(0, i), typing: true })
        await sleep(36)
      }
      await sleep(220)
      patch(at, { typing: false })
    }
    setLines([])
    if (reduced) {
      patch(call("yarn test:update --watch=false"), { status: "err" })
      add({ id: next++, kind: "res", ok: false })
      add({ id: next++, kind: "slip" })
      patch(call("yarn test:update"), { status: "ok" })
      add({ id: next++, kind: "res", ok: true })
      return
    }
    await sleep(300)
    const a = call()
    await type(a, "yarn test:update --watch=false"); if (id !== run.current) return
    await sleep(500); patch(a, { status: "err" })
    add({ id: next++, kind: "res", ok: false })
    await sleep(900); if (id !== run.current) return
    add({ id: next++, kind: "slip" })
    await sleep(2200); if (id !== run.current) return
    const b = call()
    await type(b, "yarn test:update"); if (id !== run.current) return
    await sleep(700); patch(b, { status: "ok" })
    add({ id: next++, kind: "res", ok: true })
  }

  useOnceVisible(win, play, 0.5)
  // a figure that unmounts stops typing
  useEffect(() => () => { run.current++ }, [])

  return (
    <figure className="fig-mistake" aria-labelledby="f2t">
      <div className="fig-head">
        <h3 id="f2t"><span className="label">Figure 2</span>A mistake, caught as it repeats</h3>
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
