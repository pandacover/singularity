import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { cueChoice, cueMatch, fillsFor, NEGATED, positiveText } from "../cues.ts"
import { MEMORY } from "../data/memory.ts"
import { reduced, sleep, useOnceVisible } from "../lib.ts"

const EXAMPLES = [
  ["Presenter mode", "Add a \"Presenter mode\" toggle setting. Store it in a new appState field `presenterModeEnabled` (default false). Users should be able to toggle it with Alt+J, from the canvas right-click menu (but not in view mode), and from Preferences in the main menu, and the help dialog should list the shortcut. Make sure the tests pass."],
  ["Page breaks", "Add a \"Show page breaks\" setting in a new appState field `pageBreaksEnabled` (default false). Users should be able to toggle it from Preferences in the main menu. Don't add a keyboard shortcut or a right-click menu entry for it. Make sure the tests pass."],
  ["Zen mode shortcut", "Change the zen mode keyboard shortcut from Alt+Z to Alt+M. Update everything that shows or tests the shortcut."],
  ["Something unrelated", "Fix the typo in the README's installation section."]
] as const
const LONGEST = EXAMPLES.reduce((a, [, t]) => (t.length > a.length ? t : a), "")

/** The task with each workflow's words marked, and what is negated struck through. The marks stay put as
 * workflows arrive or are hovered; only their classes change, so the text under them never moves. */
const marked = (text: string, words: ReadonlyArray<ReadonlyArray<string>>, shown: number, hot: number): ReactNode => {
  const tags = new Int16Array(text.length).fill(-1)  // -1 plain, -2 negated, else the workflow whose words these are
  for (const m of text.matchAll(NEGATED)) for (let i = m.index; i < m.index + m[0].length; i++) tags[i] = -2
  const low = text.toLowerCase()
  words.forEach((list, p) => {
    for (const w of list) {
      const q = w.trim().toLowerCase()
      if (!q) continue
      for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + 1)) {
        let free = true
        for (let k = i; k < i + q.length; k++) if (tags[k] !== -1) free = false
        if (free) for (let k = i; k < i + q.length; k++) tags[k] = p
      }
    }
  })
  const out: Array<ReactNode> = []
  let cur = -1, buf = ""
  const flush = () => {
    if (!buf) return
    const k = out.length
    out.push(cur === -2 ? <del key={k}>{buf}</del> : cur >= 0 ? <mark key={k} className={cur < shown ? (cur === hot ? "on hot" : "on") : undefined}>{buf}</mark> : buf)
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

/** Figure 4: a prompt box, and what memory attaches to it, each workflow beside the words that called for it. */
export const TryIt = () => {
  const [task, setTask] = useState<string>(EXAMPLES[0][1])
  const [pressed, setPressed] = useState(0)
  const [open, setOpen] = useState(-1)
  const [hot, setHot] = useState(-1)
  // how many attachments are shown: the first time the figure is seen they arrive one by one, each with its words
  const [shown, setShown] = useState(reduced ? Infinity : 0)
  const demo = useRef(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const cp = useRef<HTMLDivElement>(null)
  const sizer = useRef<HTMLDivElement>(null)

  // timed once per task, so hovering and the arrivals don't redraw the number; in the list's order, so they light up top down
  const { picks, ms } = useMemo(() => {
    const t0 = performance.now()
    let picks = cueChoice(MEMORY, task)
    for (let i = 1; i < 20; i++) picks = cueChoice(MEMORY, task)
    const ms = (performance.now() - t0) / 20
    return { picks: picks.sort((a, b) => MEMORY.workflows.indexOf(a.workflow) - MEMORY.workflows.indexOf(b.workflow)), ms }
  }, [task])
  const pickOf = new Map(picks.map((c, p) => [c.workflow.id, p]))

  // the words each workflow was called by: its own, and those of the steps it keeps
  const pos = positiveText(task)
  const words = picks.map((c) => [c.hit, ...c.workflow.cues!.steps.flatMap((s) => cueMatch(pos, s.any, s.none) ?? [])])
  const empty = task.trim() === ""

  // never shorter than the longest example, so switching examples keeps the box's height
  const fit = () => {
    const t = ta.current
    if (!t) return
    t.style.height = "auto"
    t.style.height = `${Math.max(t.scrollHeight, sizer.current?.offsetHeight ?? 0)}px`
  }
  useLayoutEffect(fit, [task])
  useEffect(() => {
    addEventListener("resize", fit)
    void document.fonts?.ready.then(fit)
    return () => removeEventListener("resize", fit)
  }, [])

  // an open list of steps closes on a click anywhere else
  useEffect(() => {
    if (open < 0) return
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".row.open")) setOpen(-1) }
    addEventListener("pointerdown", away)
    return () => removeEventListener("pointerdown", away)
  }, [open])

  const take = () => { demo.current++; setShown(Infinity) }
  useOnceVisible(cp, async () => {
    const id = ++demo.current
    for (let i = 1; i <= picks.length; i++) {
      await sleep(i === 1 ? 300 : 520)
      if (id !== demo.current) return
      setShown(i)
    }
  }, 0.5)
  useEffect(() => () => { demo.current++ }, [])

  return (
    <div className="cp" ref={cp} aria-label="Figure 4: type a task, see what memory attaches">
      <div className="starters">
        <span>Try</span>
        {EXAMPLES.map(([name, text], i) => (
          <button key={name} type="button" aria-pressed={pressed === i} onClick={() => { take(); setPressed(i); setTask(text); setOpen(-1) }}>{name}</button>
        ))}
      </div>
      <div className="box">
        <div className="top">
          <span className="gt" aria-hidden="true">&gt;</span>
          <div className="editor">
            <div className="sizer" ref={sizer} aria-hidden="true">{LONGEST}</div>
            {/* keyed by the task: a new task gets new text, rather than the old text moved about */}
            <div className="hl" key={task} aria-hidden="true">{marked(task, words, shown, hot)}</div>
            <textarea
              ref={ta}
              value={task}
              spellCheck={false}
              aria-label="Task"
              placeholder="Describe a change to excalidraw…"
              onChange={(e) => { take(); setPressed(-1); setTask(e.target.value) }}
              onFocus={take}
            />
          </div>
        </div>
        <div className="foot">
          <span><u>underlined</u> called for a workflow · <s>struck</s> is negated, so ignored</span>
          <span>matched in <span className="num">{ms.toFixed(3)}</span> ms · no model call</span>
        </div>
      </div>
      {/* every workflow in memory, always, one line each: a task only lights some up, so nothing below ever moves */}
      <div className="attach">
        <div className="attach-h">
          <span>Your words</span>
          <span key={empty ? "e" : "a"}>{empty
            ? "Waiting for a task"
            : <>Attached: <b className="num">{Math.min(shown, picks.length)}</b> of {MEMORY.workflows.length} workflows</>}</span>
        </div>
        {MEMORY.workflows.map((w, i) => {
          const p = pickOf.get(w.id) ?? -1, c = p >= 0 && p < shown ? picks[p] : undefined
          const fills = c ? fillsFor(task, w) : new Map<string, string>(), isOpen = i === open
          return (
            <div key={w.id} className={`row${c ? " lit" : ""}${isOpen ? " open" : ""}`} onMouseEnter={() => setHot(c ? p : -1)} onMouseLeave={() => setHot(-1)}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => { take(); setOpen(isOpen ? -1 : i) }}
                onFocus={() => setHot(c ? p : -1)}
                onBlur={(e) => { setHot(-1); if (e.relatedTarget && !e.currentTarget.parentElement!.contains(e.relatedTarget)) setOpen(-1) }}
                onKeyDown={(e) => { if (e.key === "Escape") setOpen(-1) }}
              >
                <span className="why">{c ? `“${c.hit}”` : " "}</span>
                <span className="arrow" aria-hidden="true">→</span>
                <span className="nm"><span className="t">{w.name}</span><span className="fills" key={[...fills.values()].join("|")}>{[...fills].map(([k, v]) => <Pill key={k} value={v} filled />)}</span></span>
                <span className="n">{w.steps.length - (c?.skip.length ?? 0)} steps {isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && <ol className="pop">{w.steps.map((s, j) => <li key={j} className={c?.skip.includes(j + 1) ? "skip" : undefined}>{stepText(s.text, fills)}</li>)}</ol>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
