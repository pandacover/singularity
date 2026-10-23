// (a) The 62 real task starts of 2026-10-23 (docs/development.md), each pointer judged by a stronger model that saw
// no pick: wrong pointers by each way of picking, and Haiku's right ones.
const STARTS = 62
const WAYS: ReadonlyArray<readonly [way: string, how: string, wrong: number, right: number | null]> = [
  ["Words: request and commit message", "the earlier word search", 6, null],
  ["Words: commit message", "word search today", 1, null],
  ["Haiku", "a model, in the background", 0, 10]
]

// (b) The first saved-scripts pass over the markdownlint daily driver (2026-10-14,
// apps/cli/examples/scripts/results/markdownlint/scripts-handovers.jsonl), when word search matched by the request:
// each task's best score against the changes stored before it, and the one it was handed. t01 ran with nothing stored.
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

/** A start's square: wrong pointers first, then right ones where they were counted. */
const cellOf = (i: number, wrong: number, right: number | null) => (i < wrong ? "w" : right !== null && i < wrong + right ? "r" : undefined)

/** Figure 3: (a) wrong pointers on real task starts, by each way of picking; (b) word search by the request, task by task. */
export const Picks = () => (
  <figure aria-labelledby="f3t">
    <div className="fig-head"><h3 id="f3t"><span className="label">Figure 3</span>Two ways to pick, and how often each points wrong</h3></div>

    <div className="sub"><span className="label">a</span>62 real task starts, a square each</div>
    <ol className="starts">
      {WAYS.map(([way, how, wrong, right]) => (
        <li key={way}>
          <span className="task">{way}<small>{how}</small></span>
          <span className="cells" role="img" aria-label={`${wrong} wrong of ${STARTS}${right === null ? "" : `, ${right} right`}`}>
            {Array.from({ length: STARTS }, (_, i) => <i key={i} className={cellOf(i, wrong, right)} />)}
          </span>
          <span className="got"><b>{wrong}</b> wrong{right === null ? "" : <>, <b>{right}</b> right</>}</span>
        </li>
      ))}
    </ol>
    <div className="starts-key" aria-hidden="true">
      <span><i className="w" />wrong pointer</span><span><i className="r" />right pointer, counted for Haiku</span><span><i />the other starts</span>
    </div>

    <div className="sub"><span className="label">b</span>Word search by the request, on 12 markdownlint tasks in order</div>
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
      (a) Each pointer was judged by a stronger model that didn't know how it was picked. Matching a request's words
      brought most of the wrong ones, so word search now goes by the commit message. (b) The earlier word search, which
      matched by the request, over twelve tasks run in order, each with the changes the earlier ones committed. Every
      new rule after the first got the first rule's change; the one-offs scored below the bar and got nothing. Going by
      the commit message has a cost here: those new rules, asked for in the same words, no longer find the first one.
    </figcaption>
  </figure>
)
