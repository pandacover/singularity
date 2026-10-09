/** The four steps of memory: two after a session, two when the next one starts. */
export const Steps = () => (
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
)
