import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import AGENTS_MD from "./agents.md?raw"
import { Collapse } from "./figures/Collapse.tsx"
import { Flip } from "./Flip.tsx"
import { Mistake } from "./figures/Mistake.tsx"
import { Results } from "./figures/Results.tsx"
import { Stack } from "./figures/Stack.tsx"
import { TryIt } from "./figures/TryIt.tsx"
import { Turns } from "./figures/Turns.tsx"
import { defaultOs, Install, type Os } from "./Install.tsx"
import { Logo } from "./Logo.tsx"
import { Steps } from "./Steps.tsx"
import { reduced } from "./lib.ts"
import { TipProvider } from "./Tip.tsx"

// The landing page, written as a research article: a centred column of prose, figures wider than it on both
// sides, and the contents down the left, following the reader.
const TOC: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: "problem", title: "The same task, from zero" },
  { id: "turns", title: "Where the turns go" },
  { id: "method", title: "Workflows, not transcripts" },
  { id: "picking", title: "Picking without a model" },
  { id: "results", title: "Results" },
  { id: "limits", title: "Limitations" },
  { id: "rules", title: "Rules it keeps" },
  { id: "use", title: "Use it" },
  { id: "refs", title: "References" }
]
const IDS = TOC.map((s) => s.id)

/** The section being read: the last one whose heading has passed a line near the top, or the last of all once the
 * page can't scroll further; and how far through the page the reader is. */
const useReading = (still: boolean) => {
  const [at, setAt] = useState("")
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (still) return
    let raf = 0
    const read = () => {
      raf = 0
      const line = Math.min(innerHeight / 4, 160)
      let cur = ""
      for (const id of IDS) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top < line) cur = id
      }
      const max = document.documentElement.scrollHeight - innerHeight
      setAt(max > 0 && scrollY >= max - 2 ? IDS[IDS.length - 1]! : cur)
      setProgress(max > 0 ? Math.min(1, scrollY / max) : 0)
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(read) }
    read()
    addEventListener("scroll", on, { passive: true })
    addEventListener("resize", on)
    return () => { removeEventListener("scroll", on); removeEventListener("resize", on); cancelAnimationFrame(raf) }
  }, [])
  return { at, progress }
}

/** Who the page is written for: people, or coding agents, which get it as plain markdown (also at /llms.txt), in
 * the inverted theme. Kept in the address as ?for=agents, so a link can open either. */
type View = "human" | "agents"
type Go = (v: View) => void
const viewOf = (): View => (new URLSearchParams(location.search).get("for") === "agents" ? "agents" : "human")
const keepView = (v: View) => {
  const url = new URL(location.href)
  if (v === "agents") url.searchParams.set("for", "agents")
  else url.searchParams.delete("for")
  url.hash = ""
  history.replaceState(null, "", url)
}

const ViewToggle = ({ view, go }: { readonly view: View; readonly go: Go }) => (
  <div className="vt" role="group" aria-label="Read as">
    <button type="button" aria-pressed={view === "human"} onClick={() => go("human")}>Human</button>
    <button type="button" aria-pressed={view === "agents"} onClick={() => go("agents")}>Agents</button>
  </div>
)

/** The markdown, shown as it is, with its headings and code set apart so a person can follow it too. */
const Markdown = ({ text }: { readonly text: string }) => {
  let code = false
  return (
    <pre className="md">
      {text.split(/\r?\n/).map((line, i) => {
        const fence = line.startsWith("```")
        const cls = fence ? "f" : code ? "c" : line.startsWith("#") ? "h" : line.startsWith(">") ? "q" : undefined
        if (fence) code = !code
        return <span key={i} className={cls}>{line}{"\n"}</span>
      })}
    </pre>
  )
}

const ForAgents = () => {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(AGENTS_MD) } catch { return }
    setDone(true)
    setTimeout(() => setDone(false), 1600)
  }
  return (
    <article className="ar-main ag">
      <header className="ag-head">
        <div className="kicker"><span>For agents</span><span>Plain markdown</span></div>
        <p>This page for a coding agent to read: what singularity does, how to install it without questions, what it changes, and its results. The same text is at <a href="/llms.txt">/llms.txt</a>.</p>
        <div className="ag-actions">
          <button className="copy" type="button" onClick={copy} data-done={done ? "" : undefined}>{done ? "Copied" : "Copy all"}</button>
          <a href="/llms.txt">Open as text</a>
        </div>
      </header>
      <Markdown text={AGENTS_MD} />
    </article>
  )
}

/** The page's Product Hunt badge, at its own size so it holds its space before it loads. */
const ProductHunt = () => (
  <a className="ph" href="https://www.producthunt.com/products/singularity-3?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-singularity-3" target="_blank" rel="noopener noreferrer">
    <img alt="Singularity - Memory that makes your coding agent cheaper on repeat work | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1274095&theme=neutral&t=1791560343560" />
  </a>
)

const H2 = ({ id, children }: { readonly id: string; readonly children: ReactNode }) => {
  const n = TOC.findIndex((s) => s.id === id) + 1
  return <h2 id={id}><a href={`#${id}`}><span className="num">{n}</span>{children}</a></h2>
}

const Dot = ({ yes }: { readonly yes: boolean }) => <span className={yes ? "dot-y" : "dot-n"} role="img" aria-label={yes ? "yes" : "no"} />
const AGENTS: ReadonlyArray<[name: string, handsOver: boolean, warns: boolean, learns: boolean, note?: string]> = [
  ["Claude Code", true, true, true],
  ["Codex", true, true, true],
  ["Gemini CLI", true, true, false],
  ["Droid", true, true, false],
  ["Hermes Agent", true, true, true, "through a plugin"],
  ["Cursor, OpenCode", false, false, false, "through a skill, when asked"]
]

const Contents = ({ at, progress, view, go }: { readonly at: string; readonly progress: number; readonly view: View; readonly go: Go }) => {
  const [open, setOpen] = useState(false)
  const top = TOC.find((s) => s.id === at)
  return (
    <nav className={`toc${open ? " open" : ""}`} aria-label="Contents">
      {/* on narrow screens: a bar with the section being read, which opens the contents, and the toggle */}
      <div className="toc-top">
        {view === "human"
          ? (
            <button className="toc-bar" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="label">Contents</span>
              <span className="cur">{top ? `${TOC.indexOf(top) + 1}  ${top.title}` : "Abstract"}</span>
              <span className="chev" aria-hidden="true">{open ? "−" : "+"}</span>
            </button>
          )
          : <a className="toc-bar" href="#top"><Logo className="logo" /></a>}
        <ViewToggle view={view} go={(v) => { setOpen(false); go(v) }} />
      </div>
      <div className="toc-body">
        <a className="toc-home" href="#top"><Logo className="logo" /></a>
        <ViewToggle view={view} go={go} />
        {view === "human" && <>
        <div className="label toc-h">Contents</div>
        <ol>
          {TOC.map((s, i) => {
            const on = s === top
            return (
              <li key={s.id} className={on ? "on" : undefined}>
                <a href={`#${s.id}`} onClick={() => setOpen(false)}><span className="num">{i + 1}</span>{s.title}</a>
              </li>
            )
          })}
        </ol>
        </>}
        <div className="toc-foot">
          {view === "human" && <a href="#use">Install</a>}
          <a href="https://github.com/pandacover/singularity">GitHub</a>
        </div>
      </div>
      <div className="toc-progress" aria-hidden="true" hidden={view === "agents"}><i style={{ transform: `scaleX(${progress})` }} /></div>
    </nav>
  )
}

/** The page for one reader; `still` for the copy drawn during a switch, which doesn't follow the scroll. */
const Page = ({ view, go, still = false }: { readonly view: View; readonly go: Go; readonly still?: boolean }) => {
  const [os, setOs] = useState<Os>(defaultOs)
  const { at, progress } = useReading(still)

  return (
    <TipProvider>
      <div className="ar" id={still ? undefined : "top"}>
        <Contents at={at} progress={progress} view={view} go={go} />

        {view === "agents" ? <ForAgents /> : <article className="ar-main">
          <header className="ar-head">
            <div className="kicker"><span>Research note</span><span>October 2026</span></div>
            <h1>Procedural memory for coding agents</h1>
            <p className="dek">Coding agents forget your codebase between sessions. singularity keeps the way around it: workflows learned from past runs, picked from the words of the next task, and handed to the agent before it starts looking.</p>
            <div className="byline">
              <span><a href="https://github.com/pandacover/singularity">pandacover/singularity</a></span>
              <span>Code on GitHub · runs on your machine</span>
            </div>
          </header>

          <section className="abstract" aria-labelledby="abs">
            <h2 id="abs" className="label">Abstract</h2>
            <p>
              An agent asked for the same kind of change twice starts from zero both times, and most of its turns go to
              finding places it has found before. We keep, from past sessions in Claude Code, Codex and Hermes Agent, the way through a kind of task
              as a <em>workflow</em>: steps with blanks, and the phrases that call for it. At the next task, workflows are
              picked by plain text matching, with no model call, filled in from the task, and pointed at today’s code. On a
              four-change task in excalidraw whose kinds memory had learned, the median run took 9.5 turns instead of 28.5
              and 423k tokens instead of 1.90M. On tasks it hadn’t learned, turns moved between 25% fewer and 17% more.
            </p>
            <dl className="glance">
              <div><dt>−67%</dt><dd>turns, four learned changes</dd></div>
              <div><dt>−78%</dt><dd>tokens, same task</dd></div>
              <div><dt>40 / 40</dt><dd>runs passed hidden tests</dd></div>
            </dl>
          </section>

          <div className="ar-install">
            <Install os={os} setOs={setOs} requirement={<>
              <a href="#use">Works with</a> Claude Code, Codex, Gemini CLI, Droid and Hermes Agent.<br />
              Needs Node.js 24 and git. Setup asks before it changes anything.
            </>} />
            <ProductHunt />
          </div>

          <section>
            <H2 id="problem">The same task, from zero</H2>
            <p>
              Ask a coding agent to add a setting to <a href="https://github.com/excalidraw/excalidraw">excalidraw</a> and
              it will find its way: read the app state, search for how other settings are stored, find the menu, run the
              tests, fail once on a flag, run them again. Ask it for a second setting the next day and it does all of that
              again. Nothing it learned about the codebase survives the session.
            </p>
            <p>
              Figure 1 shows four real runs of one such task without memory. They spent 110 turns between them, most of
              them reading and searching. Yet all four end up making much the same change, in the same
              places. That shared way through is what memory keeps.
            </p>
            <div className="wide"><Collapse /></div>
          </section>

          <section>
            <H2 id="turns">Where the turns go</H2>
            <p>
              The cost of forgetting is not in the edits. An agent with or without memory makes about the same edits;
              what differs is how long it looks before making them. In eight runs of a task asking for four changes at
              once, runs without memory spent a median of 16.5 turns just reading and searching. With memory, 4.5.
            </p>
            <div className="wide"><Turns /></div>
            <p>
              Fewer turns is not only faster. Every turn rereads the conversation so far, so a run that is a third as long
              costs well under a third as much: 423k tokens instead of 1.90M. Rereads are billed at a fraction of new text,
              so dollars fall a little less: $0.30 against $0.81.
            </p>
          </section>

          <section>
            <H2 id="method">Workflows, not transcripts</H2>
            <p>
              Memory could keep whole sessions and hand them back, but a transcript of one task is a poor guide to the next:
              it is long, and most of it is the searching we want to skip. Instead memory keeps <em>procedures</em>, in the
              spirit of Agent Workflow Memory [1] and procedural graphs [2]: the steps runs of one kind of task shared, with
              blanks where they differed, and the phrases in a task that call for them.
            </p>
            <div className="wide"><Steps /></div>
            <p>
              Records stay on your machine. Learning a workflow uses a model, a few cents a call, and runs on its own only
              if you said yes at setup, within a daily limit. Picking and handing over never call one. The agent gets steps,
              places and warnings, and still writes every line itself: we also tried drafting the change at task start,
              measured it, and dropped it.
            </p>
            <p>
              The last step needs no task at all. Some mistakes recur across sessions, like a flag a script already passes.
              Memory keeps them with their fixes, and when one happens again, the fix arrives with the error.
            </p>
            <div className="wide"><Mistake /></div>
          </section>

          <section>
            <H2 id="picking">Picking without a model</H2>
            <p>
              Picking happens before the agent’s first turn, so it has to be fast and it has to be cheap. Memory picks with
              plain text: each workflow carries the phrases written for it when it was learned, and a task picks the
              workflows whose phrases it contains. Words under a negation (“not in view mode”, “don’t add a shortcut”)
              don’t count. It takes a fraction of a millisecond.
            </p>
            <p>
              Try it below. The task is yours to edit; the list is every workflow in memory, and your words light up the
              ones they attach. It is the memory the measured runs used.
            </p>
            <figure className="wide fig-try" aria-labelledby="f4t">
              <div className="fig-head"><h3 id="f4t"><span className="label">Figure 4</span>Type a task; memory attaches what it knows</h3></div>
              <TryIt />
            </figure>
          </section>

          <section>
            <H2 id="results">Results</H2>
            <p>
              Each measurement was pre-registered, run on one pinned Claude Code version, and checked by hidden tests the
              agent never saw. All 40 runs passed. Figure 5 shows the cost of each task with memory as a share of its cost
              without.
            </p>
            <div className="wide"><Results /></div>
            <p>
              Where memory had learned every kind of change in the task, it cut turns by two thirds. Where it knew two of
              the four, by about a third. On tasks it hadn’t learned, it mostly cost what no memory costs.
            </p>
          </section>

          <section>
            <H2 id="limits">Limitations</H2>
            <ul className="limits">
              <li><b>It helps with what it has seen.</b> The savings come from kinds of change memory has learned. On a new kind, a small task cost up to 17% more turns.</li>
              <li><b>Small samples.</b> Three to four runs per side, on two repositories, excalidraw and validator.js. The medians are honest; their spread is wide.</li>
              <li><b>Learning costs a little.</b> Building workflows calls a model. It is opt-in and capped per day; picking and handing over never call one.</li>
              <li><b>Agents change.</b> Claude Code updates itself, and each version behaves a little differently. Runs are only compared within one version.</li>
            </ul>
          </section>

          <section>
            <H2 id="rules">Rules it keeps</H2>
            <p>Memory sits between your machine and your agent. Each layer keeps one rule.</p>
            <figure className="wide" aria-labelledby="f6t">
              <div className="fig-head"><h3 id="f6t"><span className="label">Figure 6</span>Layer by layer, from your machine up to your agent</h3></div>
              <Stack />
            </figure>
          </section>

          <section>
            <H2 id="use">Use it</H2>
            <p>One command installs it; a short setup asks before it changes anything.</p>
            <div className="use-install"><Install os={os} setOs={setOs} /></div>
            <div className="use-grid">
              <div>
                <span className="label">Works with</span>
                <table className="agents">
                  <thead><tr><th>Agent</th><th>Hands over</th><th>Warns</th><th>Learns</th></tr></thead>
                  <tbody>
                    {AGENTS.map(([name, handsOver, warns, learns, note]) => (
                      <tr key={name}>
                        <td>{name}{note && <small>{note}</small>}</td>
                        <td><Dot yes={handsOver} /></td><td><Dot yes={warns} /></td><td><Dot yes={learns} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <span className="label">Then, if you’re curious</span>
                <dl className="cmds">
                  <dt>singularity status</dt><dd>What memory knows, per repo.</dd>
                  <dt>singularity recall "…"</dt><dd>What a task would be handed.</dd>
                  <dt>singularity learn</dt><dd>Learn now.</dd>
                  <dt>singularity uninstall</dt><dd>Take it out again.</dd>
                </dl>
              </div>
            </div>
          </section>

          <section>
            <H2 id="refs">References</H2>
            <ol className="refs">
              <li><span>Agent Workflow Memory. <a href="https://arxiv.org/abs/2409.07429">arXiv:2409.07429</a>, 2024.</span></li>
              <li><span>Procedural Graphs: Self-Evolving Execution Structures for LLM Agents. <a href="https://arxiv.org/abs/2609.09153">arXiv:2609.09153</a>, 2026.</span></li>
            </ol>
          </section>

          <footer className="ar-foot">
            <span>singularity</span>
            <span>Every number here comes from real runs · <a href="https://github.com/pandacover/singularity">GitHub</a></span>
          </footer>
        </article>}
      </div>
    </TipProvider>
  )
}

export const App = () => {
  const [view, setView] = useState<View>(viewOf)
  const [flip, setFlip] = useState<View | null>(null)
  const top = useRef(false)
  // the theme lives on the root, so the whole window, scrollbar and all, takes it; a switched page starts at its top,
  // once it is drawn
  useLayoutEffect(() => {
    document.documentElement.dataset.view = view
    if (top.current) { top.current = false; scrollTo({ top: 0, behavior: "instant" }) }
  }, [view])

  const show = (v: View) => { keepView(v); top.current = true; setView(v) }
  const go: Go = (v) => {
    if (v === view || flip) return
    if (reduced) show(v)
    else setFlip(v)
  }

  return (
    <>
      <Page view={view} go={go} />
      {flip && <Flip theme={flip} page={<Page view={flip} go={() => {}} still />} onSwap={() => show(flip)} onEnd={() => setFlip(null)} />}
    </>
  )
}
