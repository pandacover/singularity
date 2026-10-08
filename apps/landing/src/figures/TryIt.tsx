import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { cueChoice, cueMatch, fillsFor, NEGATED, positiveText } from "../cues.ts"
import { MEMORY } from "../data/memory.ts"
import { reduced, sleep, useOnceVisible } from "../lib.ts"

const EXAMPLES = [
  ["Presenter mode", "Add a \"Presenter mode\" toggle setting. Store it in a new appState field `presenterModeEnabled` (default false). Users should be able to toggle it with Alt+J, from the canvas right-click menu (but not in view mode), and from Preferences in the main menu, and the help dialog should list the shortcut. Make sure the tests pass."],
  ["Page breaks", "Add a \"Show page breaks\" setting in a new appState field `pageBreaksEnabled` (default false). Users should be able to toggle it from Preferences in the main menu. Don't add a keyboard shortcut or a right-click menu entry for it. Make sure the tests pass."],
  ["Zen mode shortcut", "Change the zen mode keyboard shortcut from Alt+Z to Alt+M. Update everything that shows or tests the shortcut."],
  ["Something unrelated", "Fix the typo in the README's installation section."]
] as const

/** The task with what called for a workflow underlined and what is negated struck through. */
const marked = (text: string, phrases: ReadonlyArray<string>): ReactNode => {
  const tags = new Uint8Array(text.length)
  for (const m of text.matchAll(NEGATED)) for (let i = m.index; i < m.index + m[0].length; i++) tags[i] = 1
  const low = text.toLowerCase()
  for (const p of phrases) {
    const q = p.trim().toLowerCase()
    if (!q) continue
    for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + 1)) {
      let neg = false
      for (let k = i; k < i + q.length; k++) if (tags[k] === 1) neg = true
      if (!neg) for (let k = i; k < i + q.length; k++) tags[k] = 2
    }
  }
  const out: Array<ReactNode> = []
  let cur = -1, buf = ""
  const flush = () => {
    if (!buf) return
    const k = out.length
    out.push(cur === 1 ? <del key={k}>{buf}</del> : cur === 2 ? <mark key={k}>{buf}</mark> : buf)
    buf = ""
  }
  for (let i = 0; i < text.length; i++) {
    if (tags[i] !== cur) { flush(); cur = tags[i]! }
    buf += text[i]
  }
  flush()
  return <>{out}{"\n"}</>
}

const Pill = ({ value, filled }: { readonly value: string; readonly filled: boolean }) =>
  <span className={filled ? "pill f" : "pill"}>{value}</span>

/** A step's text with its code marks dropped and its blanks shown as pills, filled where the task said. */
const stepText = (text: string, fills: ReadonlyMap<string, string>) =>
  text.replace(/`([^`]+)`/g, "$1").split(/(\{[A-Za-z ]+\})/g).map((part, i) =>
    i % 2 === 0 ? part : fills.has(part) ? <Pill key={i} value={fills.get(part)!} filled /> : <Pill key={i} value={part.slice(1, -1)} filled={false} />)

/** Figure 3: a prompt box, and what memory attaches to it. */
export const TryIt = () => {
  const [task, setTask] = useState(() => (reduced ? EXAMPLES[0][1] : ""))
  const [pressed, setPressed] = useState(reduced ? 0 : -1)
  const [open, setOpen] = useState(-1)
  const demo = useRef(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const cp = useRef<HTMLDivElement>(null)

  const t0 = performance.now()
  let picks = cueChoice(MEMORY, task)
  for (let i = 1; i < 20; i++) picks = cueChoice(MEMORY, task)
  const ms = (performance.now() - t0) / 20

  const pos = positiveText(task)
  const hits = picks.map((c) => c.hit)
  for (const c of picks) for (const s of c.workflow.cues!.steps) { const h = cueMatch(pos, s.any, s.none); if (h) hits.push(h) }
  const empty = task.trim() === ""

  const fit = () => {
    const t = ta.current
    if (!t) return
    t.style.height = "auto"
    t.style.height = `${t.scrollHeight}px`
  }
  useLayoutEffect(fit, [task])
  useEffect(() => {
    addEventListener("resize", fit)
    void document.fonts?.ready.then(fit)
    return () => removeEventListener("resize", fit)
  }, [])

  // The first time it is seen, the first example types itself, so the cards can be seen arriving.
  useOnceVisible(cp, async () => {
    if (reduced) return
    const id = ++demo.current, text = EXAMPLES[0][1]
    setPressed(0)
    for (let i = 1; i <= text.length; i += 2) {
      if (id !== demo.current) return
      setTask(text.slice(0, i))
      await sleep(16)
    }
    if (id === demo.current) setTask(text)
  }, 0.4)
  useEffect(() => () => { demo.current++ }, [])

  return (
    <div className="cp" ref={cp} aria-label="Figure 3: type a task, see what memory attaches">
      <div className="starters">
        <span>Try</span>
        {EXAMPLES.map(([name, text], i) => (
          <button key={name} type="button" aria-pressed={pressed === i} onClick={() => { demo.current++; setPressed(i); setTask(text); setOpen(-1) }}>{name}</button>
        ))}
      </div>
      <div className="box">
        <div className="top">
          <span className="gt" aria-hidden="true">&gt;</span>
          <div className="editor">
            <div className="hl" aria-hidden="true">{marked(task, hits)}</div>
            <textarea
              ref={ta}
              value={task}
              spellCheck={false}
              aria-label="Task"
              placeholder="Describe a change to excalidraw…"
              onChange={(e) => { demo.current++; setPressed(-1); setTask(e.target.value) }}
              onFocus={() => { demo.current++ }}
            />
          </div>
        </div>
        <div className="foot">
          <span><u>underlined</u> called for a workflow · <s>struck</s> is negated, so ignored</span>
          <span>matched in {ms < 0.1 ? ms.toFixed(3) : ms.toFixed(2)} ms · no model call</span>
        </div>
      </div>
      <div className="hookline">
        <i aria-hidden="true" />
        <span>
          {empty
            ? "singularity is waiting for a task"
            : picks.length
            ? <>singularity attached <b>{picks.length}</b> of {MEMORY.workflows.length} workflows <span className="k">· click one to see its steps</span></>
            : "singularity found nothing it knows, so it adds nothing"}
        </span>
      </div>
      <div className="attach">
        {picks.length === 0
          ? <div className="empty">{empty ? "Attachments appear here as you type." : "Nothing attached. Your agent starts as it would without memory."}</div>
          : picks.map((c, i) => {
            const w = c.workflow, fills = fillsFor(task, w), isOpen = i === open
            return (
              // a card pops in when it is first picked, and stays put while it remains picked
              <button
                key={w.id}
                type="button"
                className={`card new${isOpen ? " open" : ""}`}
                aria-expanded={isOpen}
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => setOpen(isOpen ? -1 : i)}
              >
                <span className="ch"><span><b>{i + 1}</b> workflow</span><span>{w.steps.length} steps {isOpen ? "−" : "+"}</span></span>
                <span className="nm">{w.name}</span>
                {fills.size > 0 && <span className="fills">{[...fills].map(([k, v]) => <Pill key={k} value={v} filled />)}</span>}
                {isOpen && <ol>{w.steps.map((s, j) => <li key={j} className={c.skip.includes(j + 1) ? "skip" : undefined}>{stepText(s.text, fills)}</li>)}</ol>}
              </button>
            )
          })}
      </div>
    </div>
  )
}
