import { useRef, useState } from "react"
import { Mistake } from "./figures/Mistake.tsx"
import { Results } from "./figures/Results.tsx"
import { Stack } from "./figures/Stack.tsx"
import { TryIt } from "./figures/TryIt.tsx"
import { Turns } from "./figures/Turns.tsx"
import { defaultOs, Install, type Os } from "./Install.tsx"
import { Intro } from "./Intro.tsx"
import { TipProvider } from "./Tip.tsx"

const Dot = ({ yes }: { readonly yes: boolean }) => <span className={yes ? "dot-y" : "dot-n"} role="img" aria-label={yes ? "yes" : "no"} />

const AGENTS: ReadonlyArray<[name: string, handsOver: boolean, warns: boolean, learns: boolean, note?: string]> = [
  ["Claude Code", true, true, true],
  ["Codex", true, true, false],
  ["Gemini CLI", true, true, false],
  ["Droid", true, true, false],
  ["Cursor, OpenCode", false, false, false, "through a skill, when asked"]
]

const HowItWorks = () => (
  <section id="how">
    <header className="sh"><h2>How it works</h2></header>
    <div className="steps">
      <div className="phase p1">After a session</div>
      <div className="phase p2">When the next one starts</div>
      <div className="step s1">
        <div className="n">1</div>
        <h3>It keeps a record</h3>
        <p>What changed, where, and what went wrong.</p>
        <div className="vis">
          <div className="vh">A “Minimap” setting</div>
          <div className="vt">18 turns · 11 files edited</div>
          <div className="vr" style={{ marginTop: 8 }}><span className="bad">✗</span><span><code>yarn test:update --watch=false</code></span></div>
          <div className="vr"><span className="good">✓</span><span><code>yarn test:update</code></span></div>
        </div>
      </div>
      <div className="step s2">
        <div className="n">2</div>
        <h3>It learns workflows</h3>
        <p>Steps with blanks, and the phrases that call for them.</p>
        <div className="vis">
          <div className="vh">Add a field to the app state</div>
          <ol>
            <li>Add <span className="pill">field</span> to AppState</li>
            <li>Default it to <span className="pill">default</span></li>
            <li>Store it as the task says</li>
          </ol>
          <div className="vt">when a task says “new setting”</div>
        </div>
      </div>
      <div className="step s3">
        <div className="n">3</div>
        <h3>It hands them over</h3>
        <p>Picked by plain text, filled from your words, pointed at today’s code.</p>
        <div className="vis">
          <div className="vh">Add a field to the app state</div>
          <ol>
            <li>Add <span className="pill f">presenterModeEnabled</span> to AppState</li>
            <li>Default it to <span className="pill f">false</span></li>
            <li>Store it as the task says</li>
          </ol>
          <div className="vt">→ appState.ts, line 28</div>
        </div>
      </div>
      <div className="step s4">
        <div className="n">4</div>
        <h3>It catches repeats</h3>
        <p>A known mistake’s fix arrives the moment it happens again.</p>
        <div className="vis">
          <div className="vr"><span className="bad">✗</span><span><code>yarn test:update --watch=false</code></span></div>
          <div className="say">Run it plain; the script already passes --watch.</div>
          <div className="vr"><span className="good">✓</span><span><code>yarn test:update</code></span></div>
        </div>
      </div>
    </div>
  </section>
)

export const App = () => {
  const [os, setOs] = useState<Os>(defaultOs)
  const replayIntro = useRef<(() => void) | null>(null)

  return (
    <TipProvider>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <symbol id="bh" viewBox="-50 -50 100 100">
          <circle r="50" fill="#1a1815" />
          <g transform="rotate(27)">
            <path d="M-3 0 L0 -50 L3 0Z" fill="#f2eee5" />
            <path d="M-3 0 L0 50 L3 0Z" fill="#f2eee5" opacity="0.55" />
            <ellipse rx="41" ry="7" fill="#f2eee5" opacity="0.4" />
            <ellipse rx="22" ry="4.2" fill="#f2eee5" />
            <ellipse cy="-1.2" rx="5" ry="4.4" fill="#1a1815" />
          </g>
        </symbol>
      </svg>

      <Intro replay={replayIntro} />

      <div className="page">
        <header className="mast">
          <a className="wordmark" href="#"><svg className="logo" viewBox="0 0 100 100" aria-hidden="true"><use href="#bh" /></svg><span className="wm-name">singularity</span></a>
          <nav aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#try">Try it</a>
            <a href="#results">Results</a>
            <a href="#install">Install</a>
            <a href="https://github.com/pandacover/singularity">GitHub</a>
          </nav>
        </header>

        <div className="open">
          <h1>Coding agents forget your codebase between sessions. <span>singularity remembers the way around it.</span></h1>
          <div className="after">
            <p className="lede">It learns from your past Claude Code sessions, then hands the next one where to edit, how to check, and which mistakes to avoid.</p>
            <Install os={os} setOs={setOs} requirement="Needs Node.js 24 and git." />
          </div>
        </div>

        <Turns />
        <Mistake />
        <HowItWorks />

        <section id="try">
          <header className="sh"><h2>Try it</h2><p>Type a task the way you would to your agent. Memory attaches what it knows.</p></header>
          <TryIt />
        </section>

        <section id="results">
          <header className="sh"><h2>Results</h2><p>Pre-registered, one Claude Code version, hidden tests. All 40 runs passed.</p></header>
          <Results />
        </section>

        <section id="rules">
          <header className="sh"><h2>Rules it keeps</h2><p>Layer by layer, from your machine up to your agent.</p></header>
          <Stack />
        </section>

        <section id="install">
          <header className="sh"><h2>Install</h2><p>One command, then a short setup that asks before it changes anything.</p></header>
          <Install os={os} setOs={setOs} style={{ maxWidth: 760 }} />
          <div className="setup">
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

        <footer>
          <span>singularity · <button type="button" onClick={() => replayIntro.current?.()}>replay the intro</button></span>
          <span>Every number here comes from real runs · <a href="https://github.com/pandacover/singularity">GitHub</a></span>
        </footer>
      </div>
    </TipProvider>
  )
}
