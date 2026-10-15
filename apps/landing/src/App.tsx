import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import AGENTS_MD from "./agents.md?raw"
import { Collapse } from "./figures/Collapse.tsx"
import { Flip } from "./Flip.tsx"
import { Picks } from "./figures/Picks.tsx"
import { Results } from "./figures/Results.tsx"
import { Stack } from "./figures/Stack.tsx"
import { defaultOs, Install, type Os } from "./Install.tsx"
import { Logo } from "./Logo.tsx"
import { Steps } from "./Steps.tsx"
import { reduced } from "./lib.ts"
import { TipProvider } from "./Tip.tsx"

// The landing page, written as a research article: a centred column of prose, figures wider than it on both
// sides, and the contents down the left, following the reader.
const TOC: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: "problem", title: "The same task, from zero" },
  { id: "method", title: "What memory keeps" },
  { id: "picking", title: "Picking without a model" },
  { id: "results", title: "Results" },
  { id: "limits", title: "Limitations" },
  { id: "rules", title: "Rules it keeps" },
  { id: "use", title: "Use it" }
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
        <p>This page is for a coding agent to read: what singularity does, how to install, update and uninstall it without questions, what it changes and where, and its results. The same text is at <a href="/llms.txt">/llms.txt</a>.</p>
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
const AGENTS: ReadonlyArray<[name: string, handsOver: boolean, stores: boolean, note?: string]> = [
  ["Claude Code", true, true],
  ["Codex", true, true],
  ["Gemini CLI", true, false],
  ["Droid", true, false],
  ["Hermes Agent", true, true, "through a plugin"],
  ["Cursor, OpenCode", false, false, "through a skill, when asked"]
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
            <h1>Memory for coding agents</h1>
            <p className="dek">Coding agents forget a repository between sessions. singularity keeps the changes they commit, and hands the closest one to the next session that starts a similar task.</p>
            <div className="byline">
              <span><a href="https://github.com/pandacover/singularity">pandacover/singularity</a></span>
              <span>Code on GitHub · runs on your machine</span>
            </div>
          </header>

          <section className="abstract" aria-labelledby="abs">
            <h2 id="abs" className="label">Abstract</h2>
            <p>
              An agent asked for the same kind of change twice starts from zero both times, and most of its turns go to
              finding places it has found before. singularity stores each change a Claude Code, Codex or Hermes Agent
              session commits once its checks pass. When a new task starts, it picks the stored change whose task is most
              like it by plain text matching, with no model call. It reads that change from git as the code is now and
              adds it to the agent's first prompt. On 12 tasks in the markdownlint repository, the 7 that got a hand-over
              cost 16% less and used 24% fewer tokens. A hand-over can also carry a mistake forward. When one listed a
              build command that had failed before, agents ran it again in 8 of 10 tasks.
            </p>
            <dl className="glance">
              <div><dt>−16%</dt><dd>cost, tasks with a hand-over</dd></div>
              <div><dt>−24%</dt><dd>tokens, same tasks</dd></div>
              <div><dt>8 / 10</dt><dd>reran a failed command a hand-over named</dd></div>
            </dl>
          </section>

          <div className="ar-install">
            <Install os={os} setOs={setOs} requirement={<>
              <a href="#use">Works with</a> Claude Code, Codex, Gemini CLI, Droid and Hermes Agent.<br />
              Needs git. Setup asks before it changes anything.
            </>} />
            <ProductHunt />
          </div>

          <section>
            <H2 id="problem">The same task, from zero</H2>
            <p>
              Ask a coding agent to add a setting to <a href="https://github.com/excalidraw/excalidraw">excalidraw</a> and
              it will find its way. It reads the app state, searches for how other settings are stored, finds the menu,
              runs the tests, fails once on a flag and runs them again. Ask it for a second setting the next day and it
              does all of that again. Nothing it learned about the codebase survives the session.
            </p>
            <p>
              Figure 1 shows four real runs of one such task without memory. They spent 110 turns between them, most of
              them reading and searching, and all four made much the same change in the same places. A change like that,
              once committed, is what memory keeps.
            </p>
            <div className="wide"><Collapse /></div>
          </section>

          <section>
            <H2 id="method">What memory keeps</H2>
            <p>
              When a session commits a change and the last test, typecheck, build or lint before the commit passed,
              memory records it. The record holds the task as the person wrote it, the files changed, the commands that
              ran, and what failed and what fixed it. It holds no code. At hand-over, memory reads the change from git,
              so the diff the agent sees matches the code as it is that day. It leaves out files changed past recognition
              since, and stops handing over a change that was reverted or replaced.
            </p>
            <div className="wide"><Steps /></div>
            <p>
              The agent still writes every line itself. The hand-over calls the past change a worked example, and says
              that the names, values and details of the new task differ.
            </p>
            <p>
              When no stored change is close enough at task start, memory waits. The first time the agent edits a file
              that a similar change touched, and few other changes did, memory hands that change over, with its edit of
              that file first. A task gets one hand-over at most. Setup also adds a note to the agent's instructions
              saying it can run <code>singularity recall</code> before work it may have done before.
            </p>
          </section>

          <section>
            <H2 id="picking">Picking without a model</H2>
            <p>
              Picking happens before the agent's first turn, so it has to be fast and cost nothing. Memory scores each
              stored task against the new one. The score combines how much of the stored task's words the new task holds
              with how alike the two are overall. Below 0.38 memory hands over nothing, because a wrong example is worse
              than none.
            </p>
            <p>
              Figure 3 shows the first pass of this memory over 12 tasks in the markdownlint repository. Each task ran
              after the ones before it, with their committed changes stored.
            </p>
            <div className="wide"><Picks /></div>
          </section>

          <section>
            <H2 id="results">Results</H2>
            <p>
              We ran the 12 markdownlint tasks five times with memory and three times without, on one Claude Code
              version. We also ran two long excalidraw tasks, with memory built from six earlier runs. Figure 4 shows the
              cost of each with memory as a share of its cost without.
            </p>
            <div className="wide"><Results /></div>
            <p>
              Tasks with a hand-over cost less. Tasks without one cost the same as with no memory. On excalidraw, the
              task with a mix of changes used 43% to 53% fewer tokens. The task with four changes was within the noise.
            </p>
            <p>
              Pass counts swing. A task that leaves a check failing fails every later task until an agent fixes it.
              With memory, 4 of 60 tasks started such a run of failures; without it, 2 of 36 did. Two of memory's came
              after a hand-over that listed a failing build command among past mistakes. Across all our markdownlint
              runs, agents ran that command in 8 of the 10 tasks whose hand-over named it, and in none of the other 78.
              Memory now shows other changes' mistakes only through files few changes touch. That fix is not yet
              measured in runs.
            </p>
          </section>

          <section>
            <H2 id="limits">Limitations</H2>
            <ul className="limits">
              <li><b>It helps with what it has seen.</b> The savings come from tasks like ones already committed in the same repository. With no close past change, a task costs what it costs without memory.</li>
              <li><b>A hand-over can carry a mistake.</b> Agents run the commands a past change lists, including ones that failed.</li>
              <li><b>Agents rarely ask.</b> Agents ran <code>singularity recall</code> on their own once in 60 runs that had the note.</li>
              <li><b>Small samples.</b> One to five passes per side, on two repositories, markdownlint and excalidraw.</li>
              <li><b>Agents change.</b> Claude Code updates itself, and each version behaves a little differently. Runs are only compared within one version.</li>
            </ul>
          </section>

          <section>
            <H2 id="rules">Rules it keeps</H2>
            <p>Memory sits between your machine and your agent. Each layer keeps one rule.</p>
            <figure className="wide" aria-labelledby="f5t">
              <div className="fig-head"><h3 id="f5t"><span className="label">Figure 5</span>Layer by layer, from your machine up to your agent</h3></div>
              <Stack />
            </figure>
          </section>

          <section>
            <H2 id="use">Use it</H2>
            <p>One command installs it. A short setup asks before it changes anything.</p>
            <div className="use-install"><Install os={os} setOs={setOs} /></div>
            <div className="use-grid">
              <div>
                <span className="label">Works with</span>
                <table className="agents">
                  <thead><tr><th>Agent</th><th>At task start</th><th>Stores changes</th></tr></thead>
                  <tbody>
                    {AGENTS.map(([name, handsOver, stores, note]) => (
                      <tr key={name}>
                        <td>{name}{note && <small>{note}</small>}</td>
                        <td><Dot yes={handsOver} /></td><td><Dot yes={stores} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <span className="label">Then, if you're curious</span>
                <dl className="cmds">
                  <dt>singularity status</dt><dd>What memory stored, per repo.</dd>
                  <dt>singularity recall "…"</dt><dd>What a task would be handed.</dd>
                  <dt>singularity store</dt><dd>Store what earlier sessions here committed.</dd>
                  <dt>singularity update</dt><dd>Get the latest version.</dd>
                  <dt>singularity uninstall</dt><dd>Take it out again.</dd>
                </dl>
              </div>
            </div>
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
