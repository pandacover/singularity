/** The three steps of memory: one when a session commits, two when the next one works. */
export const Steps = () => (
  <div className="steps">
    <div className="phase p1">When a session commits</div>
    <div className="phase p2">When the next one works</div>
    <div className="step s1">
      <div className="n">1</div>
      <h3>It stores the change</h3>
      <p>It also notes whether the last check before the commit passed.</p>
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
      <h3>It points to one</h3>
      <p>It hands over the commit and files of the stored change most like the new task, without the diff, and lists the check scripts earlier sessions ran.</p>
      <div className="vis">
        <div className="vh">Who picks it</div>
        <div className="vr"><span className="good">●</span><span>In Claude Code, a model, Haiku by default</span></div>
        <div className="vr"><span className="good">○</span><span>Elsewhere, or with no model, the words of commit messages</span></div>
        <div className="vn">in the background · about $0.002 a task</div>
      </div>
    </div>
    <div className="step s3">
      <div className="n">3</div>
      <h3>Or later, mid-task</h3>
      <p>
        Reading a stored commit in git brings what git doesn't show, such as the commands its session ran. The agent
        can also ask.
      </p>
      <div className="vis">
        <code>singularity recall "make the build check pass"</code>
        <div className="vn">the closest past change, or none</div>
      </div>
    </div>
  </div>
)
