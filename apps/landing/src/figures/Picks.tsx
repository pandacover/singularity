// The first saved-scripts pass over the markdownlint daily driver (2026-10-14,
// apps/cli/examples/scripts/results/markdownlint/scripts-handovers.jsonl): each task's best score against the
// changes stored before it, and the one it was handed. t01 ran with nothing stored.
const BAR = 0.38
const MAX = 0.7
const TASKS: ReadonlyArray<readonly [id: string, kind: string, score: number | null, got: string | null]> = [
  ["t01 heading-max-level", "new rule", null, null],
  ["t02 code-block-max-lines", "new rule", 0.57, "t01"],
  ["t03 md024-ignore-case", "rule option", 0.423, "t01"],
  ["t04 list-max-depth", "new rule", 0.614, "t01"],
  ["t05 get-rules", "one-off", 0.34, null],
  ["t06 rename-doc-src", "update", 0.353, null],
  ["t07 link-url-scheme", "new rule", 0.416, "t01"],
  ["t08 todo-comments-example", "look-alike", 0.337, null],
  ["t09 md014-prompts", "rule option", 0.489, "t03"],
  ["t10 ol-delimiter-style", "new rule", 0.471, "t01"],
  ["t11 circular-extends", "one-off", 0.327, null],
  ["t12 no-empty-headings", "new rule", 0.526, "t01"]
]
const at = (v: number) => `${(v / MAX) * 100}%`

/** Figure 3: twelve tasks in order, each one's best score, and what it was handed. */
export const Picks = () => (
  <figure aria-labelledby="f3t">
    <div className="fig-head"><h3 id="f3t"><span className="label">Figure 3</span>Twelve tasks, seven hand-overs</h3></div>
    <div className="picks-axis" aria-hidden="true">
      <span>Task</span>
      <span className="ax">
        {[0, 0.2, 0.4, 0.6].map((v) => <span key={v} style={{ left: at(v) }}>{v.toFixed(1)}</span>)}
        <span className="b" style={{ left: at(BAR), top: -14 }}>bar {BAR}</span>
      </span>
      <span>Handed over</span>
    </div>
    <ol className="picks">
      {TASKS.map(([id, kind, score, got]) => (
        <li key={id} className={got ? "on" : undefined}>
          <span className="task">{id}<small>{kind}</small></span>
          <span className="track">
            <i className="bar" style={{ left: at(BAR) }} />
            {score !== null && <i className="sc" style={{ left: at(score) }} title={`score ${score}`} />}
          </span>
          <span className="got">{got ? `${got}'s change, ${score!.toFixed(2)}` : score === null ? "nothing stored yet" : `nothing, ${score.toFixed(2)}`}</span>
        </li>
      ))}
    </ol>
    <figcaption>
      Twelve tasks in the markdownlint repository, run in order, each with the changes the earlier ones committed. A
      score is how much of a stored task's words the new task holds, combined with how alike the two are. Every new
      rule after the first got the first rule's change. The one-offs, the folder rename and the example rule scored
      below the bar and got nothing.
    </figcaption>
  </figure>
)
