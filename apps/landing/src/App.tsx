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
  { id: "picking", title: "Picking the past change" },
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
const viewOf = (): View =>
  typeof location !== "undefined" && new URLSearchParams(location.search).get("for") === "agents" ? "agents" : "human"
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
  ["Claude Code", true, true, "a model you choose picks, Haiku by default"],
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
            <p className="dek">Coding agents forget a repository between sessions. singularity keeps the changes they commit, and points the next session that starts a similar task to the closest one.</p>
            <div className="byline">
              <span><a href="https://github.com/pandacover/singularity">pandacover/singularity</a></span>
              <span>Code on GitHub · runs on your machine</span>
            </div>
          </header>

          <section className="abstract" aria-labelledby="abs">
            <h2 id="abs" className="label">Abstract</h2>
            <p>
              An agent asked for the same kind of change twice starts from zero both times, and most of its turns go to
              finding places it has found before. singularity stores each change that a Claude Code, Codex or Hermes
              Agent session commits. When a new task starts, it points the agent to the stored change closest to it,
              without the diff, which git holds. It also lists the check scripts earlier sessions ran that are still on
              disk, and when the agent reads a stored commit in git, it adds the commands that commit's session ran. On
              fresh clones of chat-v2, with Claude Code's auto memory off, Opus cost 26% less with memory over 12 pairs
              of runs. Sonnet cost the same and passed 12 of 12 runs, against 10 of 12 without. The help came from the
              check scripts and the commands, not from the pointer. In daily use on markdownlint, an earlier hand-over
              that included the diff saved 6%, which is inside the noise.
            </p>
            <dl className="glance">
              <div><dt>−26%</dt><dd>cost, Opus on fresh clones</dd></div>
              <div><dt>12 / 12</dt><dd>Sonnet runs passed with memory, 10 / 12 without</dd></div>
              <div><dt>−6%</dt><dd>cost in daily use, inside the noise</dd></div>
            </dl>
          </section>

          <div className="ar-install">
            <Install os={os} setOs={setOs} requirement={<>
              <a href="#use">Works with</a> Claude Code, Codex, Gemini CLI, Droid and Hermes Agent.<br />
              You need git. Setup asks before it changes anything.
            </>} />
            <ProductHunt />
          </div>

          <section>
            <H2 id="problem">The same task, from zero</H2>
            <p>
              Ask a coding agent to add a setting to <a href="https://github.com/excalidraw/excalidraw">excalidraw</a>,
              and it does. It reads the app state, searches for how other settings are stored, finds the menu, runs the
              tests, fails once on a flag and runs them again. Ask it for a second setting the next day and it does all
              of that again. Unless the agent keeps a memory of its own, nothing it learned about the codebase survives
              the session.
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
              When a session commits a change, memory records it. The record holds the task as the person wrote it, the
              files changed, the commands that ran, what failed and what fixed it, and whether the last test, typecheck,
              build or lint before the commit passed. It holds no code, because git has that. Memory stops handing over
              a change that was reverted or replaced.
            </p>
            <div className="wide"><Steps /></div>
            <p>
              At task start the agent gets a pointer, not a diff: the past change's commit, the first line of its commit
              message, and its files as they are named today. It can read the change with <code>git show</code>, and it
              still writes every line itself. The pointer says that the names, values and details of the new task
              differ. Once a session, a short card follows. It lists the check scripts that earlier sessions ran before
              committing and that are still on disk, such as a screenshot or end-to-end script, with the pointed-to
              change's own scripts first.
            </p>
            <p>
              When the agent reads a stored change in git, with <code>git show</code> or <code>git log</code>, memory
              adds what the commit doesn't hold: the commands its session ran, and the task when the commit message says
              too little. It never adds a diff or past mistakes. It adds each change once a session, and never one the
              session made itself. Setup also adds a note to the agent's instructions saying it can run{" "}
              <code>singularity recall</code> before work it may have done before.
            </p>
          </section>

          <section>
            <H2 id="picking">Picking the past change</H2>
            <p>
              A wrong pointer is worse than none, so memory picks one change or nothing. It has two ways to pick.
            </p>
            <p>
              <b>By words.</b> Memory scores each stored change against the new task. The score combines how much of the
              change's words the new task holds with how alike the two are overall. Memory finds a change by its commit
              message, and by the request that asked for it only when the message says too little. Below 0.38 memory
              hands over nothing. It costs nothing and needs no model, but it misses a task put in other words. Codex,
              Gemini CLI, Droid and Hermes Agent pick this way.
            </p>
            <p>
              <b>By a model.</b> In Claude Code, setup asks whether a model should pick. The default is Haiku, the
              cheapest, at about $0.002 a task on your Claude plan. You can choose Sonnet, Opus, another model by name,
              or none, which keeps word search. The model reads your task and the repository's stored changes, and picks
              one or none. It runs in a background hook, so the session never waits. The check scripts arrive at once,
              and the pointer reaches the agent with its next tool result, a few seconds in.
            </p>
            <p>
              Figure 3 shows both on 62 real task starts. Finding changes by their commit message instead of also by
              their request cut wrong pointers from 6 to 1. Haiku handed over none wrong, and 10 right.
            </p>
            <div className="wide"><Picks /></div>
          </section>

          <section>
            <H2 id="results">Results</H2>
            <p>
              On 2026-10-22 we gave Claude Code two tasks related to earlier work in{" "}
              <a href="https://github.com/pandacover/chat-v2">chat-v2</a>, an Electron app of ours. Every run started
              from a fresh clone with Claude Code's auto memory off, so the only memory of the repository was
              singularity's. Runs with memory had a copy of the memory our own sessions had built in chat-v2. Each one
              ran at the same time as a run without memory, on the same machine. Figure 4 shows each pair's cost with
              memory as a share of its cost without.
            </p>
            <div className="wide"><Results /></div>
            <p>
              Opus cost 26% less with memory, and 10 of its 12 pairs were cheaper. Every Opus run passed, with memory
              and without. Sonnet cost the same, $3.50 with memory and $3.51 without, and passed 12 of 12 runs against
              10 of 12. No task passed less often with memory.
            </p>
            <p>
              The transcripts show where the help came from. Opus runs with memory reused the browser install that a
              past session had left on disk, wrote their check from that session's scripts, and tested the change in
              the running app. The two Sonnet runs that failed without memory committed a type error after trying{" "}
              <code>npx tsc</code>, which chat-v2 doesn't install. With memory, Sonnet ran{" "}
              <code>bun run typecheck</code>, and several runs got that command from what memory adds to{" "}
              <code>git show</code>. One task got a pointer at every start, to a weak match, and no run visibly used it.
            </p>
            <p>
              Daily use on markdownlint tells a different story. Sonnet did 12 tasks in order, each in a fresh session,
              three times with memory and three times without, on an earlier version whose hand-over included the past
              change's diff. Cost fell 6% (95% interval −13% to +1%), which is inside the noise. A second run of the
              same passes, which also added notes when an agent ran <code>git show</code>, cost 1.9% less (−12% to
              +8%). There the earlier changes were in the repository's git history, and agents read them there with
              memory and without.
            </p>
          </section>

          <section>
            <H2 id="limits">Limitations</H2>
            <ul className="limits">
              <li><b>It helps where git says too little.</b> The help came from check scripts and commands that the repository doesn't hold. Where the past changes are in git and the agent reads them anyway, as on markdownlint, memory added little.</li>
              <li><b>One machine.</b> The card lists only check scripts still on disk, so on a new machine it would list none. The chat-v2 runs were on the machine where the past sessions ran.</li>
              <li><b>Agents with a memory of their own.</b> The runs had Claude Code's auto memory off. An agent that keeps its own notes on a repository may already know what memory tells it.</li>
              <li><b>Measured before the latest changes.</b> The chat-v2 runs picked by word search, before the model's pick, and their notes on <code>git show</code> still listed past mistakes. The markdownlint runs had a hand-over with the diff.</li>
              <li><b>A model's pick comes a step in.</b> It reaches the agent with its first tool result after the pick, a few seconds in, so the agent starts without it. We judged picking on 62 real task starts, not on paid runs.</li>
              <li><b>Sonnet rarely asks.</b> Across 177 sessions with the recall note on markdownlint, excalidraw and validator, Sonnet ran <code>singularity recall</code> on its own once, and in its 12 runs on chat-v2 it never did. Opus ran it in 5 of its 12 runs on chat-v2.</li>
              <li><b>Small samples.</b> Twelve pairs of runs per model on chat-v2, over two tasks in one repository. Three passes of 12 tasks on markdownlint.</li>
              <li><b>Agents change.</b> Claude Code updates itself, and each version behaves a little differently. We compare runs only within one version.</li>
            </ul>
          </section>

          <section>
            <H2 id="rules">Rules it keeps</H2>
            <p>Figure 5 draws memory as layers, from your machine up to your agent. Each layer keeps one rule.</p>
            <figure className="wide" aria-labelledby="f5t">
              <div className="fig-head"><h3 id="f5t"><span className="label">Figure 5</span>Layer by layer, from your machine up to your agent</h3></div>
              <Stack />
            </figure>
          </section>

          <section>
            <H2 id="use">Use it</H2>
            <p>
              One command installs it. A short setup asks before it changes anything, and, for Claude Code, which model
              picks the past change, if any.
            </p>
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
                  <dt>singularity changes</dt><dd>The changes stored here, or one in full.</dd>
                  <dt>singularity visualise</dt><dd>The same, drawn in your terminal.</dd>
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
