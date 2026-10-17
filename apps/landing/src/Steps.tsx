/** The three steps of memory: one when a session commits, two when the next one works. */
export const Steps = () => (
  <div className="steps">
    <div className="phase p1">When a session commits</div>
    <div className="phase p2">When the next one works</div>
    <div className="step s1">
      <div className="n">1</div>
      <h3>It stores the change</h3>
      <p>Only if the last check before the commit passed.</p>
      <div className="vis">
        <div className="vh">A record, no code</div>
        <ol>
          <li>The task, as the person wrote it</li>
          <li>The files it changed</li>
          <li>The commands that ran</li>
          <li>What failed, and what fixed it</li>
        </ol>
      </div>
    </div>
    <div className="step s2">
      <div className="n">2</div>
      <h3>It hands one over</h3>
      <p>The stored task most like the new one, read from git as the code is now.</p>
      <div className="vis">
        <div className="vh">t09 · a new option for MD014</div>
        <div className="vr"><span className="good">✓</span><span>t03's change, score 0.49</span></div>
        <div className="vn">bar 0.38 · no model call</div>
      </div>
    </div>
    <div className="step s3">
      <div className="n">3</div>
      <h3>Or later, mid-task</h3>
      <p>
        A first edit of a file a similar change touched brings that change. Reading a stored commit in git brings what
        git doesn't show. The agent can also ask.
      </p>
      <div className="vis">
        <code>singularity recall "make the build check pass"</code>
        <div className="vn">the closest past change, or none</div>
      </div>
    </div>
  </div>
)
